import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type StandardizedOutput, type CruxOutput } from "../schemas/lead";
import { extractNumericFeatures, type NumericFeatures } from "../scoring/numeric";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ClusteringOutputSchema = z.object({
  clusters: z.array(
    z.object({
      cluster_label: z.string(),
      description: z.string(),
      canonical_domains: z.array(z.string()),
    })
  ),
});

export async function calculateCentroids(projectId: string): Promise<void> {
  // 1. Fetch all phase4_done leads with embeddings (include crux_data for numeric features)
  const { data: leads, error } = await supabase
    .from("leads")
    .select("canonical_domain, standardized_data, crux_data")
    .eq("project_id", projectId)
    .eq("status", "phase4_done")
    .not("embedding", "is", null);

  if (error) throw new Error(`Failed to fetch leads: ${error.message}`);
  if (!leads || leads.length === 0) throw new Error("No eligible leads found");

  // 2. Build condensed profile list for the LLM
  const profiles: Array<{ domain: string; data: StandardizedOutput }> =
    leads.map((l) => ({
      domain: l.canonical_domain as string,
      data: l.standardized_data as StandardizedOutput,
    }));

  // Build a map for quick lookup during centroid numeric computation
  const leadsByDomain = new Map(
    leads.map((l) => [
      l.canonical_domain as string,
      {
        standardized_data: l.standardized_data as StandardizedOutput | null,
        crux_data: l.crux_data as CruxOutput | null,
      },
    ])
  );

  // 3. Ask Claude to identify 2-4 ICP archetypes
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-5-20250929"),
    schema: ClusteringOutputSchema,
    prompt: `Given these ${profiles.length} company profiles, identify 2-4 distinct ICP archetypes based on their business model, tech stack, and complexity. Return a JSON object with a 'clusters' array.

Profiles:
${JSON.stringify(profiles, null, 2)}`,
  });

  // 4. Persist each cluster
  await Promise.all(
    object.clusters.map(async (cluster) => {
      const domains = cluster.canonical_domains;

      // Compute centroid vector via Postgres avg()
      const { data: centroidVector, error: rpcError } = await supabase.rpc(
        "get_centroid_for_domains",
        { p_project_id: projectId, p_domains: domains }
      );

      if (rpcError) {
        throw new Error(
          `RPC get_centroid_for_domains failed for cluster "${cluster.cluster_label}": ${rpcError.message}`
        );
      }

      // Compute average numeric features for leads in this cluster
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

      // Insert centroid row (upsert on unique project_id + cluster_label)
      const { error: insertError } = await supabase.from("centroids").upsert(
        {
          project_id: projectId,
          cluster_label: cluster.cluster_label,
          notes: cluster.description,
          centroid_vector: centroidVector,
          lead_count: domains.length,
          numeric_features: avgNumericFeatures,
        },
        { onConflict: "project_id,cluster_label" }
      );

      if (insertError) {
        throw new Error(
          `Failed to insert centroid for cluster "${cluster.cluster_label}": ${insertError.message}`
        );
      }

      // Tag each lead in this cluster
      const { error: updateError } = await supabase
        .from("leads")
        .update({ cluster_label: cluster.cluster_label })
        .eq("project_id", projectId)
        .in("canonical_domain", domains);

      if (updateError) {
        throw new Error(
          `Failed to update cluster_label for cluster "${cluster.cluster_label}": ${updateError.message}`
        );
      }
    })
  );
}
