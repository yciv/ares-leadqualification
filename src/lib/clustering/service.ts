import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type StandardizedOutput, type CruxOutput } from "../schemas/lead";
import { extractNumericFeatures, type NumericFeatures } from "../scoring/numeric";
import { clusterEmbeddings } from "./algorithm";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ClusterLabelSchema = z.object({
  cluster_label: z.string(),
  description: z.string(),
});

export async function calculateCentroids(projectId: string): Promise<void> {
  // ── Step 1: Fetch leads ────────────────────────────────────────────────────
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, canonical_domain, company_name, standardized_data, crux_data, embedding")
    .eq("project_id", projectId)
    .eq("status", "phase4_done")
    .not("embedding", "is", null);

  if (error) throw new Error(`Failed to fetch leads: ${error.message}`);
  if (!leads || leads.length === 0) throw new Error("No eligible leads found");

  // ── Step 2: Algorithmic clustering ────────────────────────────────────────
  // pgvector returns vectors as a JSON-array string "[x,y,...]" — parse to number[].
  const embeddings: number[][] = leads.map((l) => {
    const raw = l.embedding as string | number[];
    return typeof raw === "string" ? (JSON.parse(raw) as number[]) : raw;
  });

  const clusteringResult = await clusterEmbeddings(embeddings, {
    targetDims: 15,
    kMin: 2,
    kMax: 6,
    minClusterSize: 15,
    validateStability: true,
  });

  console.log(
    `[Clustering] k=${clusteringResult.k}, ` +
      `silhouette=${clusteringResult.silhouetteScore.toFixed(4)}, ` +
      `leads=${leads.length}`
  );
  if (clusteringResult.stability) {
    console.log(
      `[Clustering] stability: meanARI=${clusteringResult.stability.meanARI.toFixed(3)}, ` +
        `stdARI=${clusteringResult.stability.stdARI.toFixed(3)}, ` +
        `stable=${clusteringResult.stability.stable}`
    );
  }

  // ── Build per-cluster domain / profile maps ────────────────────────────────
  // clusteringResult.labels is parallel to leads[] — labels[i] is the 0-based
  // cluster index for leads[i].
  const clusterDomains = new Map<number, string[]>();
  const clusterProfilesMap = new Map<
    number,
    Array<{ company_name: string | null; data: StandardizedOutput | null }>
  >();
  for (let i = 0; i < clusteringResult.k; i++) {
    clusterDomains.set(i, []);
    clusterProfilesMap.set(i, []);
  }
  for (let i = 0; i < leads.length; i++) {
    const idx = clusteringResult.labels[i];
    clusterDomains.get(idx)!.push(leads[i].canonical_domain as string);
    clusterProfilesMap.get(idx)!.push({
      company_name: leads[i].company_name as string | null,
      data: leads[i].standardized_data as StandardizedOutput | null,
    });
  }

  // Domain → lead data lookup for numeric centroid computation
  const leadsByDomain = new Map(
    leads.map((l) => [
      l.canonical_domain as string,
      {
        standardized_data: l.standardized_data as StandardizedOutput | null,
        crux_data: l.crux_data as CruxOutput | null,
      },
    ])
  );

  // ── Step 3: Claude Haiku post-labeling (parallel, one call per cluster) ───
  const clusterLabels = await Promise.all(
    Array.from({ length: clusteringResult.k }, async (_, idx) => {
      const profiles = clusterProfilesMap.get(idx)!;

      const { object } = await generateObject({
        model: anthropic("claude-haiku-4-5-20251001"),
        schema: ClusterLabelSchema,
        prompt: `Given these ${profiles.length} company profiles that have been algorithmically grouped together, \
generate a short, descriptive ICP archetype label (2-5 words) and a 1-2 sentence \
description of what these companies have in common.

Profiles:
${JSON.stringify(profiles)}

Respond with JSON: { "cluster_label": "...", "description": "..." }`,
      });

      return { clusterIdx: idx, cluster_label: object.cluster_label, description: object.description };
    })
  );

  // ── Step 4+5: Delete stale centroids, then upsert new ones ────────────────
  // Old cluster_labels won't match new runs — clean slate per project.
  const { error: deleteError } = await supabase
    .from("centroids")
    .delete()
    .eq("project_id", projectId);

  if (deleteError) {
    throw new Error(`Failed to delete old centroids: ${deleteError.message}`);
  }

  await Promise.all(
    clusterLabels.map(async ({ clusterIdx, cluster_label, description }) => {
      const domains = clusterDomains.get(clusterIdx)!;

      // Semantic centroid — Postgres avg(embedding) via RPC
      const { data: centroidVector, error: rpcError } = await supabase.rpc(
        "get_centroid_for_domains",
        { p_project_id: projectId, p_domains: domains }
      );

      if (rpcError) {
        throw new Error(
          `RPC get_centroid_for_domains failed for cluster "${cluster_label}": ${rpcError.message}`
        );
      }

      // Numeric centroid — element-wise average in Node, null-skipping per field
      const numericSums: Record<keyof NumericFeatures, number> = {
        tech_maturity_score: 0,
        crux_rank: 0,
        lcp: 0,
        fid: 0,
        cls: 0,
      };
      const numericCounts: Record<keyof NumericFeatures, number> = {
        tech_maturity_score: 0,
        crux_rank: 0,
        lcp: 0,
        fid: 0,
        cls: 0,
      };

      for (const domain of domains) {
        const leadData = leadsByDomain.get(domain);
        if (!leadData) continue;
        const features = extractNumericFeatures(leadData);
        for (const key of Object.keys(numericSums) as Array<keyof NumericFeatures>) {
          if (features[key] !== null) {
            numericSums[key] += features[key]!;
            numericCounts[key]++;
          }
        }
      }

      const avgNumericFeatures: NumericFeatures = {
        tech_maturity_score:
          numericCounts.tech_maturity_score > 0
            ? numericSums.tech_maturity_score / numericCounts.tech_maturity_score
            : null,
        crux_rank:
          numericCounts.crux_rank > 0
            ? numericSums.crux_rank / numericCounts.crux_rank
            : null,
        lcp: numericCounts.lcp > 0 ? numericSums.lcp / numericCounts.lcp : null,
        fid: numericCounts.fid > 0 ? numericSums.fid / numericCounts.fid : null,
        cls: numericCounts.cls > 0 ? numericSums.cls / numericCounts.cls : null,
      };

      const { error: upsertError } = await supabase.from("centroids").upsert(
        {
          project_id: projectId,
          cluster_label,
          notes: description,
          centroid_vector: centroidVector,
          lead_count: domains.length,
          numeric_features: avgNumericFeatures,
        },
        { onConflict: "project_id,cluster_label" }
      );

      if (upsertError) {
        throw new Error(
          `Failed to upsert centroid for cluster "${cluster_label}": ${upsertError.message}`
        );
      }

      // ── Step 6: Tag every lead in this cluster ─────────────────────────────
      const { error: updateError } = await supabase
        .from("leads")
        .update({ cluster_label })
        .eq("project_id", projectId)
        .in("canonical_domain", domains);

      if (updateError) {
        throw new Error(
          `Failed to tag leads for cluster "${cluster_label}": ${updateError.message}`
        );
      }
    })
  );

  // ── Step 7: Write clustering metadata to projects table ───────────────────
  const clusteringMetadata = {
    k: clusteringResult.k,
    silhouette_score: clusteringResult.silhouetteScore,
    stability: clusteringResult.stability
      ? {
          mean_ari: clusteringResult.stability.meanARI,
          std_ari: clusteringResult.stability.stdARI,
          stable: clusteringResult.stability.stable,
        }
      : null,
    pca_dimensions: clusteringResult.pcaDimensions,
    clustered_at: new Date().toISOString(),
    lead_count: leads.length,
  };

  const { error: metaError } = await supabase
    .from("projects")
    .update({ clustering_metadata: clusteringMetadata })
    .eq("id", projectId);

  if (metaError) {
    // Non-fatal: column may not exist if migration 20260313000200 hasn't been
    // applied yet. Clustering is complete — warn and continue.
    console.warn(
      `[Clustering] Warning: could not write clustering_metadata: ${metaError.message}` +
        " — apply migration 20260313000200_add_clustering_metadata.sql to enable this."
    );
  }
}
