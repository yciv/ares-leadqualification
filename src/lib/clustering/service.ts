import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type StandardizedOutput } from "../schemas/lead";

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
  // 1. Fetch all phase4_done leads with embeddings
  const { data: leads, error } = await supabase
    .from("leads")
    .select("canonical_domain, standardized_data")
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

  // 3. Ask Claude to identify 2-4 ICP archetypes
  const { object } = await generateObject({
    model: anthropic("claude-3-5-sonnet-latest"),
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

      // Insert centroid row (upsert on unique project_id + cluster_label)
      const { error: insertError } = await supabase.from("centroids").upsert(
        {
          project_id: projectId,
          cluster_label: cluster.cluster_label,
          notes: cluster.description,
          centroid_vector: centroidVector,
          lead_count: domains.length,
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
