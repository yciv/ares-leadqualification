import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Routing thresholds ───────────────────────────────────────────────────────

function resolveRouting(similarity: number, clusterLabel: string): {
  cluster_label: string;
  routing_flag: string;
} {
  if (similarity >= 0.85) return { cluster_label: clusterLabel, routing_flag: "AE" };
  if (similarity >= 0.72) return { cluster_label: clusterLabel, routing_flag: "SDR" };
  if (similarity >= 0.60) return { cluster_label: "fringe",    routing_flag: "nurture" };
  return                         { cluster_label: "no_match",  routing_flag: "reject" };
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function scoreLeadsAgainstCentroids(
  testProjectId: string,
  seedProjectId: string
): Promise<void> {
  // Step 1: Fetch centroids for the seed project
  const { data: centroids, error: centroidsError } = await supabase
    .from("centroids")
    .select("id, cluster_label, centroid_vector")
    .eq("project_id", seedProjectId);

  if (centroidsError) {
    throw new Error(`Failed to fetch centroids: ${centroidsError.message}`);
  }
  if (!centroids || centroids.length === 0) {
    throw new Error(`No centroids found for seed project ${seedProjectId}`);
  }

  // Step 2: Score the test project leads against every centroid
  // best[leadId] = { similarity, cluster_label }
  const best = new Map<string, { similarity: number; cluster_label: string }>();

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

    // Step 3: Keep the highest-similarity centroid per lead
    for (const row of rows as Array<{ lead_id: string; similarity: number }>) {
      const current = best.get(row.lead_id);
      if (!current || row.similarity > current.similarity) {
        best.set(row.lead_id, {
          similarity: row.similarity,
          cluster_label: centroid.cluster_label as string,
        });
      }
    }
  }

  if (best.size === 0) return;

  // Step 4 + 5: Apply routing logic and group by (routing_flag, cluster_label)
  // so we can do one update per unique combination instead of N individual updates.
  const scoredAt = new Date().toISOString();

  type UpdateGroup = {
    routing_flag: string;
    cluster_label: string;
    fit_score: number;
    ids: string[];
  };

  // We need per-row fit_score, so group only by routing outcome (same flag+label)
  // and then do a per-lead update for the fit_score. To avoid N round-trips we
  // batch leads that share the same routing_flag + cluster_label AND same rounded
  // fit_score bucket — but since fit_score is continuous we just do individual
  // updates efficiently via Promise.all (not sequential).
  const updateGroups = new Map<string, UpdateGroup>();

  for (const [leadId, { similarity, cluster_label }] of best) {
    const routing = resolveRouting(similarity, cluster_label);
    const key = `${routing.routing_flag}::${routing.cluster_label}`;

    if (!updateGroups.has(key)) {
      updateGroups.set(key, {
        routing_flag: routing.routing_flag,
        cluster_label: routing.cluster_label,
        fit_score: similarity, // placeholder; overridden per-lead below
        ids: [],
      });
    }
    updateGroups.get(key)!.ids.push(leadId);
  }

  // Bulk update: one Supabase call per (routing_flag, cluster_label) group.
  // fit_score varies per lead so we still need per-lead updates for that field;
  // we run them in parallel to keep latency low.
  const updatePromises: Promise<void>[] = [];

  // Group-level update for routing_flag + cluster_label (same for all in group)
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

  // Per-lead update for fit_score (continuous float — cannot batch without CASE)
  for (const [leadId, { similarity }] of best) {
    updatePromises.push(
      (async () => {
        const { error } = await supabase
          .from("leads")
          .update({ fit_score: similarity })
          .eq("id", leadId)
          .eq("project_id", testProjectId);

        if (error) {
          throw new Error(
            `fit_score update failed for lead ${leadId}: ${error.message}`
          );
        }
      })()
    );
  }

  await Promise.all(updatePromises);

  // Step 6: Mark leads that had no embedding (skipped by RPC) as unscored
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

  // Step 7: Record the scoring run
  const { error: runError } = await supabase.from("scoring_runs").insert({
    seed_project_id: seedProjectId,
    test_project_id: testProjectId,
    leads_scored: best.size,
  });

  if (runError) {
    throw new Error(`Failed to record scoring run: ${runError.message}`);
  }
}
