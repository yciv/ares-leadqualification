/**
 * CIV-11 Benchmark — NL Serialization + Composite Scoring Validation
 *
 * Usage:
 *   npx tsx src/lib/benchmark/civ11-benchmark.ts <seed_project_id> <test_project_id>
 *
 * What it does:
 *   1. Snapshots current test lead scores → benchmarks/civ11-before.json
 *   2. Re-runs Phase 3+4 on all seed leads (new nl_summary + embeddings)
 *   3. Recomputes centroids using existing cluster assignments (no re-clustering)
 *   4. Re-runs Phase 3+4 on all test leads
 *   5. Re-scores test leads against updated centroids
 *   6. Snapshots updated test lead scores → benchmarks/civ11-after.json
 *   7. Prints comparison table + summary stats to stdout
 */

// Static imports: only modules with zero runtime side-effects.
// Service modules (scoring/service, llm/service, embeddings/service, scoring/numeric)
// are dynamically imported inside main() AFTER config() loads env vars — this
// prevents top-level Supabase client creation from firing with undefined URLs.
import { config } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pLimit from "p-limit";

// Type-only imports are erased at runtime — safe to keep static.
import type { NumericFeatures } from "../scoring/numeric";
import type { LinkupOutput, CruxOutput, StandardizedOutput } from "../schemas/lead";

// ─── Runtime bindings (assigned inside main() after dotenv + dynamic imports) ─
// All callers are downstream of main()'s initialization block.
let supabase!: SupabaseClient;
let standardizeProfile!: Awaited<typeof import("../llm/service")>["standardizeProfile"];
let generateLeadEmbedding!: Awaited<typeof import("../embeddings/service")>["generateLeadEmbedding"];
let extractNumericFeatures!: Awaited<typeof import("../scoring/numeric")>["extractNumericFeatures"];
let scoreLeadsAgainstCentroids!: Awaited<typeof import("../scoring/service")>["scoreLeadsAgainstCentroids"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeadSnapshot {
  id: string;
  canonical_domain: string;
  fit_score: number | null;
  text_similarity: number | null;
  numeric_similarity: number | null;
  completeness_score: number | null;
  cluster_label: string | null;
  routing_flag: string | null;
}

interface BenchmarkSnapshot {
  captured_at: string;
  seed_project_id: string;
  test_project_id: string;
  leads: LeadSnapshot[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 4): string {
  if (n === null || n === undefined) return "null";
  return n.toFixed(decimals);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

// ─── Step 1: Snapshot ─────────────────────────────────────────────────────────

async function snapshotTestLeads(
  testProjectId: string
): Promise<LeadSnapshot[]> {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, canonical_domain, fit_score, text_similarity, numeric_similarity, completeness_score, cluster_label, routing_flag"
    )
    .eq("project_id", testProjectId)
    .order("canonical_domain");

  if (error) throw new Error(`Snapshot query failed: ${error.message}`);
  if (!data || data.length === 0)
    throw new Error(`No leads found for test project ${testProjectId}`);

  return data as LeadSnapshot[];
}

// ─── Step 2: Re-process leads (Phase 3 + Phase 4) ─────────────────────────────

async function reprocessLeads(
  projectId: string,
  label: string
): Promise<void> {
  console.log(`\n[${label}] Fetching leads for Phase 3+4 re-processing...`);

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, canonical_domain, linkup_data, crux_data")
    .eq("project_id", projectId)
    .eq("status", "phase4_done");

  if (error) throw new Error(`Failed to fetch ${label} leads: ${error.message}`);
  if (!leads || leads.length === 0)
    throw new Error(`No phase4_done leads found for ${label} project`);

  console.log(`[${label}] Found ${leads.length} leads. Re-running Phase 3 (concurrency 3, 1500ms delay)...`);

  const phase3Limit = pLimit(3);
  let phase3Done = 0;
  let phase3Failed = 0;

  // Phase 3: Re-standardize to generate nl_summary
  const standardizedMap = new Map<string, StandardizedOutput>();

  await Promise.all(
    leads.map((lead) =>
      phase3Limit(async () => {
        if (!lead.linkup_data || !lead.crux_data) {
          console.warn(`  [SKIP] ${lead.canonical_domain} — missing linkup or crux data`);
          phase3Failed++;
          return;
        }

        try {
          const standardized = await standardizeProfile(
            lead.linkup_data as LinkupOutput,
            lead.crux_data as CruxOutput
          );
          standardizedMap.set(lead.id as string, standardized);
          phase3Done++;

          if (phase3Done % 10 === 0) {
            console.log(`  Phase 3: ${phase3Done}/${leads.length} done`);
          }
        } catch (err) {
          phase3Failed++;
          console.warn(
            `  [WARN] Phase 3 failed for ${lead.canonical_domain}: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // Rate limit: 1500ms per-request delay (Anthropic 50 req/min)
        await new Promise((r) => setTimeout(r, 1500));
      })
    )
  );

  console.log(`[${label}] Phase 3 complete: ${phase3Done} OK, ${phase3Failed} failed.`);
  console.log(`[${label}] Re-running Phase 4 (concurrency 10)...`);

  const phase4Limit = pLimit(10);
  let phase4Done = 0;
  let phase4Failed = 0;

  await Promise.all(
    Array.from(standardizedMap.entries()).map(([leadId, standardized]) =>
      phase4Limit(async () => {
        const lead = leads.find((l) => l.id === leadId)!;

        try {
          const embedding = await generateLeadEmbedding(standardized);

          // Compute numeric features from fresh standardized_data + existing crux_data
          const numericFeatures = extractNumericFeatures({
            standardized_data: standardized,
            crux_data: lead.crux_data as CruxOutput | null,
          });

          const { error: updateError } = await supabase
            .from("leads")
            .update({
              standardized_data: standardized,
              embedding,
              numeric_features: numericFeatures,
            })
            .eq("id", leadId)
            .eq("project_id", projectId);

          if (updateError) {
            throw new Error(`DB update failed: ${updateError.message}`);
          }

          phase4Done++;

          if (phase4Done % 10 === 0) {
            console.log(`  Phase 4: ${phase4Done}/${standardizedMap.size} done`);
          }
        } catch (err) {
          phase4Failed++;
          console.warn(
            `  [WARN] Phase 4 failed for lead ${leadId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
    )
  );

  console.log(`[${label}] Phase 4 complete: ${phase4Done} OK, ${phase4Failed} failed.`);
}

// ─── Step 3: Recompute centroids (no re-clustering) ──────────────────────────

async function recomputeCentroids(seedProjectId: string): Promise<void> {
  console.log("\n[Centroids] Recomputing centroid vectors using existing cluster assignments...");

  // Fetch all phase4_done seed leads with cluster_label + data for numeric features
  const { data: leads, error: leadsError } = await supabase
    .from("leads")
    .select("canonical_domain, cluster_label, standardized_data, crux_data")
    .eq("project_id", seedProjectId)
    .eq("status", "phase4_done")
    .not("embedding", "is", null)
    .not("cluster_label", "is", null);

  if (leadsError)
    throw new Error(`Failed to fetch seed leads for centroids: ${leadsError.message}`);
  if (!leads || leads.length === 0)
    throw new Error("No eligible seed leads found for centroid recomputation");

  // Group domains by existing cluster_label
  const clusterMap = new Map<string, string[]>();
  for (const lead of leads) {
    const label = lead.cluster_label as string;
    const domain = lead.canonical_domain as string;
    if (!clusterMap.has(label)) clusterMap.set(label, []);
    clusterMap.get(label)!.push(domain);
  }

  // Build domain → lead data map for numeric averaging
  const leadsByDomain = new Map(
    leads.map((l) => [
      l.canonical_domain as string,
      {
        standardized_data: l.standardized_data as StandardizedOutput | null,
        crux_data: l.crux_data as CruxOutput | null,
      },
    ])
  );

  console.log(`[Centroids] Found ${clusterMap.size} clusters: ${[...clusterMap.keys()].join(", ")}`);

  for (const [clusterLabel, domains] of clusterMap) {
    // Recompute centroid vector via Postgres AVG(embedding)
    const { data: centroidVector, error: rpcError } = await supabase.rpc(
      "get_centroid_for_domains",
      { p_project_id: seedProjectId, p_domains: domains }
    );

    if (rpcError) {
      throw new Error(
        `RPC get_centroid_for_domains failed for cluster "${clusterLabel}": ${rpcError.message}`
      );
    }

    // Compute average numeric features for this cluster
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
      lcp:
        numericCounts.lcp > 0 ? numericSums.lcp / numericCounts.lcp : null,
      fid:
        numericCounts.fid > 0 ? numericSums.fid / numericCounts.fid : null,
      cls:
        numericCounts.cls > 0 ? numericSums.cls / numericCounts.cls : null,
    };

    // Upsert centroid (update vector + numeric_features; preserve cluster_label and notes)
    const { error: upsertError } = await supabase
      .from("centroids")
      .update({
        centroid_vector: centroidVector,
        numeric_features: avgNumericFeatures,
        lead_count: domains.length,
      })
      .eq("project_id", seedProjectId)
      .eq("cluster_label", clusterLabel);

    if (upsertError) {
      throw new Error(
        `Failed to update centroid for cluster "${clusterLabel}": ${upsertError.message}`
      );
    }

    console.log(
      `  [Centroids] "${clusterLabel}" updated (${domains.length} leads, ` +
        `tech_maturity_avg=${fmt(avgNumericFeatures.tech_maturity_score, 2)})`
    );
  }

  console.log("[Centroids] All centroids recomputed.");
}

// ─── Step 5: Comparison report ────────────────────────────────────────────────

function printComparisonReport(
  before: LeadSnapshot[],
  after: LeadSnapshot[]
): void {
  const afterMap = new Map(after.map((l) => [l.id, l]));

  // ── Per-lead table ──
  const COL = {
    domain: 32,
    score: 8,
    cluster: 22,
    routing: 10,
    completeness: 7,
  };

  const header =
    pad("domain", COL.domain) +
    "  " +
    pad("old_score", COL.score) +
    "  " +
    pad("new_score", COL.score) +
    "  " +
    pad("old_cluster", COL.cluster) +
    "  " +
    pad("new_cluster", COL.cluster) +
    "  " +
    pad("old_route", COL.routing) +
    "  " +
    pad("new_route", COL.routing) +
    "  " +
    pad("compl.", COL.completeness);

  const divider = "─".repeat(header.length);

  console.log("\n" + divider);
  console.log("CIV-11 BENCHMARK COMPARISON");
  console.log(divider);
  console.log(header);
  console.log(divider);

  let clusterChanges = 0;
  let routingChanges = 0;

  for (const b of before) {
    const a = afterMap.get(b.id);
    if (!a) continue;

    const clusterChanged = b.cluster_label !== a.cluster_label;
    const routingChanged = b.routing_flag !== a.routing_flag;
    if (clusterChanged) clusterChanges++;
    if (routingChanged) routingChanges++;

    const row =
      pad(b.canonical_domain, COL.domain) +
      "  " +
      pad(fmt(b.fit_score), COL.score) +
      "  " +
      pad(fmt(a.fit_score), COL.score) +
      "  " +
      pad(b.cluster_label ?? "null", COL.cluster) +
      "  " +
      pad(a.cluster_label ?? "null", COL.cluster) +
      "  " +
      pad(b.routing_flag ?? "null", COL.routing) +
      "  " +
      pad(a.routing_flag ?? "null", COL.routing) +
      "  " +
      pad(a.completeness_score !== null ? `${(a.completeness_score * 100).toFixed(0)}%` : "null", COL.completeness);

    // Mark rows with changes
    const flags = [clusterChanged ? "CLUSTER" : "", routingChanged ? "ROUTING" : ""]
      .filter(Boolean)
      .join("+");

    console.log(row + (flags ? `  ← ${flags}` : ""));
  }

  console.log(divider);

  // ── Summary stats ──
  const beforeScores = before.map((l) => l.fit_score).filter((s): s is number => s !== null);
  const afterScores = after.map((l) => l.fit_score).filter((s): s is number => s !== null);

  const afterTextSims = after
    .map((l) => l.text_similarity)
    .filter((s): s is number => s !== null);
  const afterNumericSims = after
    .map((l) => l.numeric_similarity)
    .filter((s): s is number => s !== null);

  console.log("\nSCORE DISTRIBUTION");
  console.log(
    `  Before — min: ${fmt(Math.min(...beforeScores))}  max: ${fmt(Math.max(...beforeScores))}  ` +
      `mean: ${fmt(mean(beforeScores))}  median: ${fmt(median(beforeScores))}`
  );
  console.log(
    `  After  — min: ${fmt(Math.min(...afterScores))}  max: ${fmt(Math.max(...afterScores))}  ` +
      `mean: ${fmt(mean(afterScores))}  median: ${fmt(median(afterScores))}`
  );

  if (afterTextSims.length > 0) {
    console.log(
      `  Text similarity (after)   — mean: ${fmt(mean(afterTextSims))}  median: ${fmt(median(afterTextSims))}`
    );
  }
  if (afterNumericSims.length > 0) {
    console.log(
      `  Numeric similarity (after) — mean: ${fmt(mean(afterNumericSims))}  median: ${fmt(median(afterNumericSims))}`
    );
  }

  console.log("\nROUTING DISTRIBUTION");
  const routingFlags = ["AE", "SDR", "nurture", "reject", "unscored"];
  for (const flag of routingFlags) {
    const beforeCount = before.filter((l) => l.routing_flag === flag).length;
    const afterCount = after.filter((l) => l.routing_flag === flag).length;
    const delta = afterCount - beforeCount;
    const deltaStr = delta === 0 ? "  (no change)" : `  (${delta > 0 ? "+" : ""}${delta})`;
    console.log(`  ${pad(flag, 10)}  before: ${beforeCount}  after: ${afterCount}${deltaStr}`);
  }

  console.log("\nCHANGES");
  console.log(`  Cluster assignment changes: ${clusterChanges} / ${before.length}`);
  console.log(`  Routing flag changes:       ${routingChanges} / ${before.length}`);
  console.log(divider + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [, , seedProjectId, testProjectId] = process.argv;

  if (!seedProjectId || !testProjectId) {
    console.error(
      "Usage: npx tsx src/lib/benchmark/civ11-benchmark.ts <seed_project_id> <test_project_id>"
    );
    process.exit(1);
  }

  // Load env vars BEFORE any validation or module initialization that reads them.
  config({ path: ".env.local" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY in .env.local");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in .env.local");
    process.exit(1);
  }

  supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Dynamic imports: executed after config() so top-level Supabase clients
  // inside these modules initialize with populated env vars.
  ({ standardizeProfile }     = await import("../llm/service"));
  ({ generateLeadEmbedding }  = await import("../embeddings/service"));
  ({ extractNumericFeatures } = await import("../scoring/numeric"));
  ({ scoreLeadsAgainstCentroids } = await import("../scoring/service"));

  console.log("=== CIV-11 Benchmark ===");
  console.log(`Seed project:  ${seedProjectId}`);
  console.log(`Test project:  ${testProjectId}`);

  const benchmarksDir = path.resolve(process.cwd(), "benchmarks");
  fs.mkdirSync(benchmarksDir, { recursive: true });

  // ── Step 1: Before snapshot ───────────────────────────────────────────────
  console.log("\n[1/6] Taking before-snapshot of test leads...");
  const beforeLeads = await snapshotTestLeads(testProjectId);

  const beforeSnapshot: BenchmarkSnapshot = {
    captured_at: new Date().toISOString(),
    seed_project_id: seedProjectId,
    test_project_id: testProjectId,
    leads: beforeLeads,
  };

  const beforePath = path.join(benchmarksDir, "civ11-before.json");
  fs.writeFileSync(beforePath, JSON.stringify(beforeSnapshot, null, 2));
  console.log(`[1/6] Before-snapshot saved → ${beforePath} (${beforeLeads.length} leads)`);

  // ── Step 2: Re-process seed leads ─────────────────────────────────────────
  console.log("\n[2/6] Re-processing seed leads (Phase 3 + Phase 4)...");
  await reprocessLeads(seedProjectId, "Seed");

  // ── Step 3: Recompute centroids ───────────────────────────────────────────
  console.log("\n[3/6] Recomputing centroids (existing cluster assignments)...");
  await recomputeCentroids(seedProjectId);

  // ── Step 4: Re-process test leads ─────────────────────────────────────────
  console.log("\n[4/6] Re-processing test leads (Phase 3 + Phase 4)...");
  await reprocessLeads(testProjectId, "Test");

  // ── Step 5: Re-score test leads ───────────────────────────────────────────
  console.log("\n[5/6] Re-scoring test leads against updated centroids...");
  await scoreLeadsAgainstCentroids(testProjectId, seedProjectId);
  console.log("[5/6] Scoring complete.");

  // ── Step 6: After snapshot ────────────────────────────────────────────────
  console.log("\n[6/6] Taking after-snapshot of test leads...");
  const afterLeads = await snapshotTestLeads(testProjectId);

  const afterSnapshot: BenchmarkSnapshot = {
    captured_at: new Date().toISOString(),
    seed_project_id: seedProjectId,
    test_project_id: testProjectId,
    leads: afterLeads,
  };

  const afterPath = path.join(benchmarksDir, "civ11-after.json");
  fs.writeFileSync(afterPath, JSON.stringify(afterSnapshot, null, 2));
  console.log(`[6/6] After-snapshot saved → ${afterPath} (${afterLeads.length} leads)`);

  // ── Comparison report ─────────────────────────────────────────────────────
  printComparisonReport(beforeLeads, afterLeads);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
