/**
 * CIV-12 Benchmark — Algorithmic Clustering Validation
 *
 * Usage:
 *   npx tsx src/lib/benchmark/civ12-benchmark.ts <seed_project_id> <test_project_id>
 *
 * What it does:
 *   1. Snapshots current state (seed leads, test leads, centroids) → benchmarks/civ12-before.json
 *   2. Re-clusters seed leads via new algorithmic pipeline (calculateCentroids)
 *   3. Re-scores test leads against new centroids (scoreLeadsAgainstCentroids)
 *   4. Snapshots updated state → benchmarks/civ12-after.json
 *   5. Prints clustering summary, seed distribution, per-lead scoring table, and summary stats
 */

// Static imports: only modules with zero runtime side-effects.
// Service modules are dynamically imported inside main() AFTER config() loads
// env vars — prevents top-level Supabase client creation from firing with
// undefined URLs.
import { config } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─── Runtime bindings (assigned inside main() after dotenv + dynamic imports) ─

let supabase!: SupabaseClient;
let calculateCentroids!: Awaited<typeof import("../clustering/service")>["calculateCentroids"];
let scoreLeadsAgainstCentroids!: Awaited<typeof import("../scoring/service")>["scoreLeadsAgainstCentroids"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface SeedLeadSnapshot {
  canonical_domain: string;
  cluster_label: string | null;
  fit_score: number | null;
}

interface TestLeadSnapshot {
  id: string;
  canonical_domain: string;
  cluster_label: string | null;
  fit_score: number | null;
  routing_flag: string | null;
  text_similarity: number | null;
  numeric_similarity: number | null;
}

interface CentroidSnapshot {
  cluster_label: string;
  lead_count: number;
}

interface ClusteringMetadata {
  k: number;
  silhouette_score: number;
  stability: {
    mean_ari: number;
    std_ari: number;
    stable: boolean;
  } | null;
  pca_dimensions: number;
  clustered_at: string;
  lead_count: number;
}

interface BenchmarkSnapshot {
  captured_at: string;
  seed_project_id: string;
  test_project_id: string;
  seed_leads: SeedLeadSnapshot[];
  test_leads: TestLeadSnapshot[];
  centroids: CentroidSnapshot[];
  clustering_metadata: ClusteringMetadata | null;
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

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// ─── Snapshot queries ─────────────────────────────────────────────────────────

async function snapshotSeedLeads(seedProjectId: string): Promise<SeedLeadSnapshot[]> {
  const { data, error } = await supabase
    .from("leads")
    .select("canonical_domain, cluster_label, fit_score")
    .eq("project_id", seedProjectId)
    .order("canonical_domain");

  if (error) throw new Error(`Seed leads snapshot failed: ${error.message}`);
  if (!data || data.length === 0)
    throw new Error(`No seed leads found for project ${seedProjectId}`);

  return data as SeedLeadSnapshot[];
}

async function snapshotTestLeads(testProjectId: string): Promise<TestLeadSnapshot[]> {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, canonical_domain, cluster_label, fit_score, routing_flag, text_similarity, numeric_similarity"
    )
    .eq("project_id", testProjectId)
    .order("canonical_domain");

  if (error) throw new Error(`Test leads snapshot failed: ${error.message}`);
  if (!data || data.length === 0)
    throw new Error(`No test leads found for project ${testProjectId}`);

  return data as TestLeadSnapshot[];
}

async function snapshotCentroids(seedProjectId: string): Promise<CentroidSnapshot[]> {
  const { data, error } = await supabase
    .from("centroids")
    .select("cluster_label, lead_count")
    .eq("project_id", seedProjectId)
    .order("cluster_label");

  if (error) throw new Error(`Centroids snapshot failed: ${error.message}`);
  return (data ?? []) as CentroidSnapshot[];
}

async function fetchClusteringMetadata(
  seedProjectId: string
): Promise<ClusteringMetadata | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("clustering_metadata")
    .eq("id", seedProjectId)
    .single();

  if (error) {
    // Column may not exist if migration 20260313000200 hasn't been applied.
    console.warn(`[Benchmark] clustering_metadata unavailable: ${error.message}`);
    return null;
  }
  return (data?.clustering_metadata as ClusteringMetadata | null) ?? null;
}

async function takeSnapshot(
  seedProjectId: string,
  testProjectId: string,
  includeMetadata: boolean
): Promise<BenchmarkSnapshot> {
  const [seedLeads, testLeads, centroids] = await Promise.all([
    snapshotSeedLeads(seedProjectId),
    snapshotTestLeads(testProjectId),
    snapshotCentroids(seedProjectId),
  ]);

  const clusteringMetadata = includeMetadata
    ? await fetchClusteringMetadata(seedProjectId)
    : null;

  return {
    captured_at: new Date().toISOString(),
    seed_project_id: seedProjectId,
    test_project_id: testProjectId,
    seed_leads: seedLeads,
    test_leads: testLeads,
    centroids: centroids,
    clustering_metadata: clusteringMetadata,
  };
}

// ─── Comparison report ────────────────────────────────────────────────────────

function printComparisonReport(
  before: BenchmarkSnapshot,
  after: BenchmarkSnapshot
): void {
  const dividerWidth = 130;
  const divider = "─".repeat(dividerWidth);

  // ── Section 1: Clustering summary ──────────────────────────────────────────
  console.log("\n" + divider);
  console.log("CIV-12 BENCHMARK — CLUSTERING SUMMARY");
  console.log(divider);

  const oldK = before.centroids.length;
  const newMeta = after.clustering_metadata;
  const newK = newMeta?.k ?? after.centroids.length;

  console.log(`  k (before):        ${oldK}  (${before.centroids.map((c) => `"${c.cluster_label}"`).join(", ")})`);
  console.log(`  k (after):         ${newK}  (${after.centroids.map((c) => `"${c.cluster_label}"`).join(", ")})`);

  if (newMeta) {
    console.log(`  Silhouette score:  ${fmt(newMeta.silhouette_score, 4)}`);
    console.log(`  PCA dimensions:    ${newMeta.pca_dimensions}`);
    console.log(`  Lead count:        ${newMeta.lead_count}`);
    console.log(`  Clustered at:      ${newMeta.clustered_at}`);
    if (newMeta.stability) {
      const { mean_ari, std_ari, stable } = newMeta.stability;
      console.log(
        `  ARI stability:     meanARI=${fmt(mean_ari, 3)}  stdARI=${fmt(std_ari, 3)}  stable=${stable}`
      );
    } else {
      console.log("  ARI stability:     not computed");
    }
  } else {
    console.log("  (No clustering_metadata available after run)");
  }

  // ── Section 2: Centroid size table ─────────────────────────────────────────
  console.log("\n" + divider);
  console.log("CENTROID SIZES");
  console.log(divider);

  const allCentroidLabels = new Set([
    ...before.centroids.map((c) => c.cluster_label),
    ...after.centroids.map((c) => c.cluster_label),
  ]);
  const beforeCentroidMap = new Map(before.centroids.map((c) => [c.cluster_label, c.lead_count]));
  const afterCentroidMap = new Map(after.centroids.map((c) => [c.cluster_label, c.lead_count]));

  console.log(pad("cluster_label", 36) + "  " + pad("before", 8) + "  " + pad("after", 8));
  console.log("─".repeat(60));
  for (const label of [...allCentroidLabels].sort()) {
    const b = beforeCentroidMap.get(label);
    const a = afterCentroidMap.get(label);
    const bStr = b !== undefined ? String(b) : "(gone)";
    const aStr = a !== undefined ? String(a) : "(new)";
    console.log(pad(label, 36) + "  " + pad(bStr, 8) + "  " + pad(aStr, 8));
  }

  // ── Section 3: Seed lead cluster distribution ───────────────────────────────
  console.log("\n" + divider);
  console.log("SEED LEAD DISTRIBUTION (99 leads)");
  console.log(divider);

  const beforeSeedClusters = countBy(before.seed_leads, (l) => l.cluster_label ?? "(unassigned)");
  const afterSeedClusters = countBy(after.seed_leads, (l) => l.cluster_label ?? "(unassigned)");
  const allSeedClusterKeys = new Set([
    ...beforeSeedClusters.keys(),
    ...afterSeedClusters.keys(),
  ]);

  const beforeUnassigned = before.seed_leads.filter((l) => l.cluster_label === null).length;
  const afterUnassigned = after.seed_leads.filter((l) => l.cluster_label === null).length;

  console.log(pad("cluster", 36) + "  " + pad("before", 8) + "  " + pad("after", 8));
  console.log("─".repeat(60));
  for (const label of [...allSeedClusterKeys].sort()) {
    const b = beforeSeedClusters.get(label) ?? 0;
    const a = afterSeedClusters.get(label) ?? 0;
    const delta = a - b;
    const deltaStr = delta === 0 ? "" : `  (${delta > 0 ? "+" : ""}${delta})`;
    console.log(pad(label, 36) + "  " + pad(String(b), 8) + "  " + pad(String(a), 8) + deltaStr);
  }
  console.log(`\n  Previously unassigned: ${beforeUnassigned}  →  After: ${afterUnassigned}`);

  // ── Section 4: Test lead per-lead scoring table ─────────────────────────────
  console.log("\n" + divider);
  console.log("TEST LEAD SCORING (22 leads)");
  console.log(divider);

  const COL = {
    domain:  32,
    score:    8,
    tsim:     8,
    nsim:     8,
    cluster: 28,
    routing: 10,
  };

  const header =
    pad("domain",      COL.domain)  + "  " +
    pad("old_score",   COL.score)   + "  " +
    pad("new_score",   COL.score)   + "  " +
    pad("txt_sim",     COL.tsim)    + "  " +
    pad("num_sim",     COL.nsim)    + "  " +
    pad("old_cluster", COL.cluster) + "  " +
    pad("new_cluster", COL.cluster) + "  " +
    pad("old_route",   COL.routing) + "  " +
    pad("new_route",   COL.routing);

  console.log(header);
  console.log("─".repeat(header.length));

  const afterTestMap = new Map(after.test_leads.map((l) => [l.canonical_domain, l]));

  let clusterChanges = 0;
  let routingChanges = 0;

  for (const b of before.test_leads) {
    const a = afterTestMap.get(b.canonical_domain);
    if (!a) continue;

    const clusterChanged = b.cluster_label !== a.cluster_label;
    const routingChanged = b.routing_flag !== a.routing_flag;
    if (clusterChanged) clusterChanges++;
    if (routingChanged) routingChanges++;

    const flags = [
      clusterChanged ? "CLUSTER" : "",
      routingChanged ? "ROUTING" : "",
    ].filter(Boolean).join("+");

    const row =
      pad(b.canonical_domain,        COL.domain)  + "  " +
      pad(fmt(b.fit_score),          COL.score)   + "  " +
      pad(fmt(a.fit_score),          COL.score)   + "  " +
      pad(fmt(a.text_similarity),    COL.tsim)    + "  " +
      pad(fmt(a.numeric_similarity), COL.nsim)    + "  " +
      pad(b.cluster_label ?? "null", COL.cluster) + "  " +
      pad(a.cluster_label ?? "null", COL.cluster) + "  " +
      pad(b.routing_flag  ?? "null", COL.routing) + "  " +
      pad(a.routing_flag  ?? "null", COL.routing);

    console.log(row + (flags ? `  ← ${flags}` : ""));
  }

  console.log("─".repeat(header.length));

  // ── Section 5: Summary stats ────────────────────────────────────────────────
  const beforeScores = before.test_leads
    .map((l) => l.fit_score)
    .filter((s): s is number => s !== null);
  const afterScores = after.test_leads
    .map((l) => l.fit_score)
    .filter((s): s is number => s !== null);
  const afterTextSims = after.test_leads
    .map((l) => l.text_similarity)
    .filter((s): s is number => s !== null);
  const afterNumericSims = after.test_leads
    .map((l) => l.numeric_similarity)
    .filter((s): s is number => s !== null);

  console.log("\nSCORE DISTRIBUTION");
  if (beforeScores.length > 0) {
    console.log(
      `  Before — min: ${fmt(Math.min(...beforeScores))}  max: ${fmt(Math.max(...beforeScores))}  ` +
        `mean: ${fmt(mean(beforeScores))}  median: ${fmt(median(beforeScores))}`
    );
  } else {
    console.log("  Before — (no scored leads)");
  }
  if (afterScores.length > 0) {
    console.log(
      `  After  — min: ${fmt(Math.min(...afterScores))}  max: ${fmt(Math.max(...afterScores))}  ` +
        `mean: ${fmt(mean(afterScores))}  median: ${fmt(median(afterScores))}`
    );
  }
  if (afterTextSims.length > 0) {
    console.log(
      `  Text similarity (after)    — mean: ${fmt(mean(afterTextSims))}  median: ${fmt(median(afterTextSims))}`
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
    const beforeCount = before.test_leads.filter((l) => l.routing_flag === flag).length;
    const afterCount = after.test_leads.filter((l) => l.routing_flag === flag).length;
    const delta = afterCount - beforeCount;
    const deltaStr = delta === 0 ? "  (no change)" : `  (${delta > 0 ? "+" : ""}${delta})`;
    console.log(`  ${pad(flag, 10)}  before: ${beforeCount}  after: ${afterCount}${deltaStr}`);
  }

  console.log("\nCLUSTER DISTRIBUTION (test leads, after)");
  const afterTestClusters = countBy(
    after.test_leads,
    (l) => l.cluster_label ?? "(unassigned)"
  );
  for (const [label, count] of [...afterTestClusters.entries()].sort()) {
    console.log(`  ${pad(label, 34)}  ${count} leads`);
  }

  console.log("\nCHANGES");
  console.log(`  Cluster assignment changes: ${clusterChanges} / ${before.test_leads.length}`);
  console.log(`  Routing flag changes:       ${routingChanges} / ${before.test_leads.length}`);
  console.log(divider + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const resumeMode = args.includes("--resume");
  const projectArgs = args.filter((a) => !a.startsWith("--"));
  const [seedProjectId, testProjectId] = projectArgs;

  if (!seedProjectId || !testProjectId) {
    console.error(
      "Usage: npx tsx src/lib/benchmark/civ12-benchmark.ts <seed_project_id> <test_project_id> [--resume]"
    );
    console.error("  --resume  Skip clustering (already done); load existing civ12-before.json and run scoring + report only.");
    process.exit(1);
  }

  // Load env vars BEFORE any module initialization that reads them.
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
  ({ calculateCentroids }         = await import("../clustering/service"));
  ({ scoreLeadsAgainstCentroids } = await import("../scoring/service"));

  console.log("=== CIV-12 Benchmark — Algorithmic Clustering Validation ===");
  console.log(`Seed project:  ${seedProjectId}`);
  console.log(`Test project:  ${testProjectId}`);
  if (resumeMode) console.log("Mode:          --resume (skipping clustering, loading saved before-snapshot)");

  const benchmarksDir = path.resolve(process.cwd(), "benchmarks");
  fs.mkdirSync(benchmarksDir, { recursive: true });
  const beforePath = path.join(benchmarksDir, "civ12-before.json");

  let before: BenchmarkSnapshot;

  if (resumeMode) {
    // ── Resume: load existing before-snapshot ───────────────────────────────
    if (!fs.existsSync(beforePath)) {
      console.error(`[RESUME] civ12-before.json not found at ${beforePath} — run without --resume first.`);
      process.exit(1);
    }
    before = JSON.parse(fs.readFileSync(beforePath, "utf8")) as BenchmarkSnapshot;
    console.log(
      `\n[1/4] Loaded existing before-snapshot from ${beforePath}` +
        `  (seed: ${before.seed_leads.length}, test: ${before.test_leads.length}, centroids: ${before.centroids.length})`
    );
    console.log("[2/4] Skipping clustering (--resume mode — clustering already applied to DB).");
  } else {
    // ── Step 1: Before snapshot ────────────────────────────────────────────
    console.log("\n[1/4] Taking before-snapshot (seed leads, test leads, centroids)...");
    before = await takeSnapshot(seedProjectId, testProjectId, false);
    fs.writeFileSync(beforePath, JSON.stringify(before, null, 2));
    console.log(
      `[1/4] Before-snapshot saved → ${beforePath}` +
        `  (seed: ${before.seed_leads.length}, test: ${before.test_leads.length}, centroids: ${before.centroids.length})`
    );

    // ── Step 2: Re-cluster seed leads ──────────────────────────────────────
    console.log("\n[2/4] Running algorithmic clustering on seed leads...");
    console.log("      (PCA → K-Means with 50 restarts/k → silhouette → bootstrap → Haiku labeling)");
    await calculateCentroids(seedProjectId);

    // Log clustering metadata immediately after (available only if migration applied)
    const postClusterMeta = await fetchClusteringMetadata(seedProjectId);
    if (postClusterMeta) {
      console.log(
        `[2/4] Clustering complete — k=${postClusterMeta.k}, ` +
          `silhouette=${fmt(postClusterMeta.silhouette_score, 4)}, ` +
          `leads=${postClusterMeta.lead_count}`
      );
      if (postClusterMeta.stability) {
        console.log(
          `      stability: meanARI=${fmt(postClusterMeta.stability.mean_ari, 3)}, ` +
            `stable=${postClusterMeta.stability.stable}`
        );
      }
    } else {
      console.log("[2/4] Clustering complete (clustering_metadata not available — migration pending).");
    }
  }

  // ── Step 3: Re-score test leads ──────────────────────────────────────────
  console.log("\n[3/4] Re-scoring test leads against new centroids...");
  // Signature: scoreLeadsAgainstCentroids(testProjectId, seedProjectId)
  await scoreLeadsAgainstCentroids(testProjectId, seedProjectId);
  console.log("[3/4] Scoring complete.");

  // ── Step 4: After snapshot ───────────────────────────────────────────────
  console.log("\n[4/4] Taking after-snapshot (seed leads, test leads, centroids)...");
  const after = await takeSnapshot(seedProjectId, testProjectId, true);

  const afterPath = path.join(benchmarksDir, "civ12-after.json");
  fs.writeFileSync(afterPath, JSON.stringify(after, null, 2));
  console.log(
    `[4/4] After-snapshot saved → ${afterPath}` +
      `  (seed: ${after.seed_leads.length}, test: ${after.test_leads.length}, centroids: ${after.centroids.length})`
  );

  // ── Comparison report ────────────────────────────────────────────────────
  printComparisonReport(before, after);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
