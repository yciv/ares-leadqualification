import { createClient } from "@supabase/supabase-js";
import {
  extractNumericFeatures,
  computeNumericSimilarity,
  computeCompleteness,
  type NumericFeatures,
} from "./numeric";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Routing thresholds ───────────────────────────────────────────────────────

function resolveRouting(
  finalScore: number,
  clusterLabel: string
): { cluster_label: string; routing_flag: string } {
  if (finalScore >= 0.55) return { cluster_label: clusterLabel, routing_flag: "AE" };
  if (finalScore >= 0.35) return { cluster_label: clusterLabel, routing_flag: "SDR" };
  if (finalScore >= 0.20) return { cluster_label: "fringe",     routing_flag: "nurture" };
  return                         { cluster_label: "no_match",   routing_flag: "reject" };
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function scoreLeadsAgainstCentroids(
  testProjectId: string,
  seedProjectId: string
): Promise<void> {
  // Step 1: Fetch centroids for the seed project (include numeric_features)
  const { data: centroids, error: centroidsError } = await supabase
    .from("centroids")
    .select("id, cluster_label, centroid_vector, numeric_features")
    .eq("project_id", seedProjectId);

  if (centroidsError) {
    throw new Error(`Failed to fetch centroids: ${centroidsError.message}`);
  }
  if (!centroids || centroids.length === 0) {
    throw new Error(`No centroids found for seed project ${seedProjectId}`);
  }

  // Step 2: Fetch test leads data for numeric feature extraction
  const { data: testLeads, error: testLeadsError } = await supabase
    .from("leads")
    .select("id, crux_data, standardized_data")
    .eq("project_id", testProjectId)
    .eq("status", "phase4_done");

  if (testLeadsError) {
    throw new Error(`Failed to fetch test leads: ${testLeadsError.message}`);
  }

  const leadDataMap = new Map(
    (testLeads ?? []).map((l) => [
      l.id as string,
      {
        crux_data: l.crux_data,
        standardized_data: l.standardized_data,
      },
    ])
  );

  // Step 3: Score against every centroid; track best composite score per lead
  type BestEntry = {
    text_similarity: number;
    numeric_similarity: number | null;
    completeness_score: number;
    fit_score: number;
    cluster_label: string;
  };
  const best = new Map<string, BestEntry>();

  for (const centroid of centroids) {
    const { data: rows, error: rpcError } = await supabase.rpc(
      "score_leads_against_centroid",
      {
        p_test_project_id: testProjectId,
        p_centroid_id: centroid.id,
        p_centroid_vector: centroid.centroid_vector,
      }
    );

    if (rpcError) {
      throw new Error(
        `RPC score_leads_against_centroid failed for centroid ${centroid.id}: ${rpcError.message}`
      );
    }

    const centroidNumeric = centroid.numeric_features as NumericFeatures | null;

    for (const row of rows as Array<{ lead_id: string; similarity: number }>) {
      const leadData = leadDataMap.get(row.lead_id);

      let numericSim: number | null = null;
      let completeness = 0;

      if (leadData) {
        const leadFeatures = extractNumericFeatures(leadData);
        completeness = computeCompleteness(leadFeatures);
        if (centroidNumeric) {
          numericSim = computeNumericSimilarity(leadFeatures, centroidNumeric);
        }
      }

      // Composite: 70% text + 30% numeric; fall back to 100% text if no numeric overlap
      const fitScore =
        numericSim !== null
          ? 0.7 * row.similarity + 0.3 * numericSim
          : row.similarity;

      const current = best.get(row.lead_id);
      if (!current || fitScore > current.fit_score) {
        best.set(row.lead_id, {
          text_similarity: row.similarity,
          numeric_similarity: numericSim,
          completeness_score: completeness,
          fit_score: fitScore,
          cluster_label: centroid.cluster_label as string,
        });
      }
    }
  }

  if (best.size === 0) return;

  // Step 4: Group leads by routing outcome for bulk cluster/flag updates
  const scoredAt = new Date().toISOString();

  type UpdateGroup = {
    routing_flag: string;
    cluster_label: string;
    ids: string[];
  };
  const updateGroups = new Map<string, UpdateGroup>();

  for (const [leadId, entry] of best) {
    const routing = resolveRouting(entry.fit_score, entry.cluster_label);
    const key = `${routing.routing_flag}::${routing.cluster_label}`;

    if (!updateGroups.has(key)) {
      updateGroups.set(key, {
        routing_flag: routing.routing_flag,
        cluster_label: routing.cluster_label,
        ids: [],
      });
    }
    updateGroups.get(key)!.ids.push(leadId);
  }

  const updatePromises: Promise<void>[] = [];

  // Bulk update: routing_flag + cluster_label + scored_at (same per group)
  for (const group of updateGroups.values()) {
    updatePromises.push(
      (async () => {
        const { error } = await supabase
          .from("leads")
          .update({
            cluster_label: group.cluster_label,
            routing_flag: group.routing_flag,
            scored_at: scoredAt,
          })
          .eq("project_id", testProjectId)
          .in("id", group.ids);

        if (error) {
          throw new Error(
            `Bulk routing update failed for flag "${group.routing_flag}": ${error.message}`
          );
        }
      })()
    );
  }

  // Per-lead update: all score fields (continuous — cannot batch without CASE)
  for (const [leadId, entry] of best) {
    updatePromises.push(
      (async () => {
        const { error } = await supabase
          .from("leads")
          .update({
            fit_score: entry.fit_score,
            text_similarity: entry.text_similarity,
            numeric_similarity: entry.numeric_similarity,
            completeness_score: entry.completeness_score,
          })
          .eq("id", leadId)
          .eq("project_id", testProjectId);

        if (error) {
          throw new Error(
            `Score fields update failed for lead ${leadId}: ${error.message}`
          );
        }
      })()
    );
  }

  await Promise.all(updatePromises);

  // Step 5: Mark leads with no embedding as unscored
  const { data: unscoredLeads } = await supabase
    .from("leads")
    .select("id")
    .eq("project_id", testProjectId)
    .eq("status", "phase4_done")
    .is("fit_score", null);

  if (unscoredLeads && unscoredLeads.length > 0) {
    await supabase
      .from("leads")
      .update({ routing_flag: "unscored", cluster_label: "No embedding" })
      .eq("project_id", testProjectId)
      .eq("status", "phase4_done")
      .is("fit_score", null);

    console.log(`[Scoring] ${unscoredLeads.length} leads marked unscored (no embedding)`);
  }

  // Step 6: Record the scoring run
  const { error: runError } = await supabase.from("scoring_runs").insert({
    seed_project_id: seedProjectId,
    test_project_id: testProjectId,
    leads_scored: best.size,
  });

  if (runError) {
    throw new Error(`Failed to record scoring run: ${runError.message}`);
  }
}
