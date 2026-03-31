import { PCA } from "ml-pca";
import { kmeans } from "ml-kmeans";

// ── Exported types ─────────────────────────────────────────────────────────────

export type ClusteringResult = {
  labels: number[];           // cluster index per lead (0-based)
  k: number;                  // chosen k
  silhouetteScore: number;
  stability: { meanARI: number; stdARI: number; stable: boolean } | null;
  pcaDimensions: number;      // actual dims used
};

// ── Module-level PCA state (for projectNewEmbedding) ─────────────────────────

let _pca: PCA | null = null;
let _pcaDims = 15;

// ── Math helpers ──────────────────────────────────────────────────────────────

function l2(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function normalize(v: number[]): number[] {
  const n = l2(v);
  return n === 0 ? v.slice() : v.map((x) => x / n);
}

function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function comb2(n: number): number {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

// ── PCA + normalization ───────────────────────────────────────────────────────

/**
 * Reduces embeddings from 1536-dim to targetDims via PCA, then re-normalizes
 * each output vector to unit L2 length. Stores the trained PCA model so
 * projectNewEmbedding() can apply the same transform to unseen leads.
 */
export function reduceDimensions(
  embeddings: number[][],
  targetDims = 15,
): number[][] {
  _pca = new PCA(embeddings);
  _pcaDims = targetDims;
  const matrix = _pca.predict(embeddings, { nComponents: targetDims });
  return (matrix.to2DArray() as number[][]).map(normalize);
}

/**
 * Projects a single new embedding through the stored PCA model and normalizes.
 * Must be called after reduceDimensions().
 */
export function projectNewEmbedding(embedding: number[]): number[] {
  if (!_pca) {
    throw new Error(
      "PCA model not initialized — call reduceDimensions() first.",
    );
  }
  const matrix = _pca.predict([embedding], { nComponents: _pcaDims });
  return normalize((matrix.to2DArray() as number[][])[0]);
}

// ── K-Means with manual restarts ──────────────────────────────────────────────

/**
 * Runs K-Means nRestarts times (each with a different seed) and returns the
 * result with the lowest total inertia (sum of per-cluster mean-squared-error
 * × cluster size, using the default squaredEuclidean distance).
 */
function runKMeansWithRestarts(
  vectors: number[][],
  k: number,
  nRestarts: number,
): { labels: number[]; centroids: number[][] } {
  let bestLabels: number[] | null = null;
  let bestCentroids: number[][] | null = null;
  let bestInertia = Infinity;

  for (let r = 0; r < nRestarts; r++) {
    const result = kmeans(vectors, k, {
      initialization: "kmeans++",
      maxIterations: 300,
      seed: r,
    });

    // computeInformation returns {centroid, error (mean dist), size} per cluster.
    // error is mean squared euclidean; total inertia = sum(error[i] * size[i]).
    const info = result.computeInformation(vectors);
    const inertia = info.reduce(
      (sum, c) => sum + (c.error === -1 ? 0 : c.error * c.size),
      0,
    );

    if (inertia < bestInertia) {
      bestInertia = inertia;
      bestLabels = result.clusters;
      bestCentroids = result.centroids;
    }
  }

  return { labels: bestLabels!, centroids: bestCentroids! };
}

// ── Silhouette score ──────────────────────────────────────────────────────────

/**
 * Computes mean silhouette coefficient for the given assignment.
 * s(i) = (b(i) - a(i)) / max(a(i), b(i))
 * a(i) = mean Euclidean distance to same-cluster points
 * b(i) = mean Euclidean distance to nearest other cluster's points
 * On normalized vectors, Euclidean distance is equivalent to cosine distance.
 */
function computeSilhouette(
  vectors: number[][],
  labels: number[],
  k: number,
): number {
  const n = vectors.length;
  const clusters: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) clusters[labels[i]].push(i);

  let total = 0;
  for (let i = 0; i < n; i++) {
    const myCluster = labels[i];
    const mates = clusters[myCluster].filter((j) => j !== i);

    // a(i): mean distance to same-cluster points
    let a = 0;
    if (mates.length > 0) {
      for (const j of mates) a += euclidean(vectors[i], vectors[j]);
      a /= mates.length;
    }

    // b(i): min over other clusters of mean distance to that cluster's points
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === myCluster || clusters[c].length === 0) continue;
      let mean = 0;
      for (const j of clusters[c]) mean += euclidean(vectors[i], vectors[j]);
      mean /= clusters[c].length;
      if (mean < b) b = mean;
    }

    const maxAB = Math.max(a, b);
    total += maxAB === 0 ? 0 : (b - a) / maxAB;
  }

  return total / n;
}

// ── Adjusted Rand Index ───────────────────────────────────────────────────────

/**
 * Computes ARI between two cluster label arrays using the standard
 * contingency-table formula. Permutation-invariant — safe for comparing
 * cluster assignments across independent K-Means runs.
 *
 * ARI = (a - E[a]) / (max(a) - E[a])
 * where a = sum_ij C(n_ij, 2), and E[a] = sum_i C(a_i,2) * sum_j C(b_j,2) / C(n,2)
 */
function computeARI(u: number[], v: number[]): number {
  const n = u.length;
  if (n === 0) return 0;

  const uSet = [...new Set(u)];
  const vSet = [...new Set(v)];
  const uIdx = new Map(uSet.map((l, i) => [l, i]));
  const vIdx = new Map(vSet.map((l, i) => [l, i]));
  const R = uSet.length;
  const C = vSet.length;

  // Build contingency table
  const T: number[][] = Array.from({ length: R }, () => new Array(C).fill(0));
  for (let i = 0; i < n; i++) {
    T[uIdx.get(u[i])!][vIdx.get(v[i])!]++;
  }

  const rowSums = T.map((row) => row.reduce((s, x) => s + x, 0));
  const colSums = Array.from({ length: C }, (_, j) =>
    T.reduce((s, row) => s + row[j], 0),
  );

  const a = T.flat().reduce((s, n_ij) => s + comb2(n_ij), 0);
  const b = rowSums.reduce((s, r) => s + comb2(r), 0);
  const c = colSums.reduce((s, col) => s + comb2(col), 0);
  const d = comb2(n);

  if (d === 0) return 1; // single-point dataset
  const expected = (b * c) / d;
  const maxExpected = (b + c) / 2;
  if (maxExpected - expected === 0) return 1;

  return (a - expected) / (maxExpected - expected);
}

// ── Public: findOptimalK ──────────────────────────────────────────────────────

/**
 * Runs K-Means for each k in [kMin, kMax] with 50 restarts and selects the k
 * with the highest silhouette score. Rejects any k where the smallest cluster
 * has fewer than minClusterSize members. Falls back to kMin if all candidates
 * are rejected (e.g., insufficient data for large k).
 */
export function findOptimalK(
  vectors: number[][],
  kMin = 2,
  kMax = 6,
  minClusterSize = 15,
): { k: number; silhouetteScore: number; labels: number[] } {
  let bestK = -1;
  let bestScore = -Infinity;
  let bestLabels: number[] = [];

  for (let k = kMin; k <= kMax; k++) {
    if (k > vectors.length) break;

    const { labels } = runKMeansWithRestarts(vectors, k, 50);

    // Reject if any cluster is under the minimum size
    const counts = new Array<number>(k).fill(0);
    for (const l of labels) counts[l]++;
    if (Math.min(...counts) < minClusterSize) continue;

    const score = computeSilhouette(vectors, labels, k);
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
      bestLabels = labels;
    }
  }

  // All candidates rejected — fall back to kMin ignoring the size constraint
  if (bestK === -1) {
    const { labels } = runKMeansWithRestarts(vectors, kMin, 50);
    const score = computeSilhouette(vectors, labels, kMin);
    return { k: kMin, silhouetteScore: score, labels };
  }

  return { k: bestK, silhouetteScore: bestScore, labels: bestLabels };
}

// ── Public: bootstrapStability ────────────────────────────────────────────────

/**
 * Estimates cluster stability via bootstrap resampling. Samples N indices
 * with replacement per iteration, runs K-Means on the unique subset, and
 * computes ARI against the reference labels from a full-data run.
 * Returns meanARI, stdARI, and stable = (meanARI > 0.7).
 */
export function bootstrapStability(
  vectors: number[][],
  k: number,
  nResamples = 200,
): { meanARI: number; stdARI: number; stable: boolean } {
  const n = vectors.length;

  // Reference labels from full dataset (10 restarts — sufficient for reference)
  const { labels: refLabels } = runKMeansWithRestarts(vectors, k, 10);

  const ariScores: number[] = [];

  for (let r = 0; r < nResamples; r++) {
    // Sample N with replacement, collect unique indices
    const sampledSet = new Set<number>();
    for (let i = 0; i < n; i++) {
      sampledSet.add(Math.floor(Math.random() * n));
    }
    const sampledIdx = [...sampledSet];
    if (sampledIdx.length < k) continue; // too few unique samples for k clusters

    const sampledVectors = sampledIdx.map((i) => vectors[i]);
    const { labels: bootLabels } = runKMeansWithRestarts(sampledVectors, k, 3);

    // Compare reference labels for the sampled subset vs bootstrap labels
    const refSubset = sampledIdx.map((i) => refLabels[i]);
    ariScores.push(computeARI(refSubset, bootLabels));
  }

  if (ariScores.length === 0) {
    return { meanARI: 0, stdARI: 0, stable: false };
  }

  const mean = ariScores.reduce((s, x) => s + x, 0) / ariScores.length;
  const variance =
    ariScores.reduce((s, x) => s + (x - mean) ** 2, 0) / ariScores.length;

  return { meanARI: mean, stdARI: Math.sqrt(variance), stable: mean > 0.7 };
}

// ── Public: clusterEmbeddings (main orchestrator) ─────────────────────────────

/**
 * Full pipeline: PCA reduction → optimal k selection → optional stability check.
 * This is the primary entry point for the clustering module.
 */
export async function clusterEmbeddings(
  embeddings: number[][],
  options?: {
    targetDims?: number;
    kMin?: number;
    kMax?: number;
    minClusterSize?: number;
    validateStability?: boolean;
  },
): Promise<ClusteringResult> {
  const {
    targetDims = 15,
    kMin = 2,
    kMax = 6,
    minClusterSize = 15,
    validateStability = false,
  } = options ?? {};

  // Step 1: PCA reduction + re-normalization
  const reduced = reduceDimensions(embeddings, targetDims);

  // Step 2: Optimal k via silhouette
  const { k, silhouetteScore, labels } = findOptimalK(
    reduced,
    kMin,
    kMax,
    minClusterSize,
  );

  // Step 3: Optional bootstrap stability
  let stability: ClusteringResult["stability"] = null;
  if (validateStability) {
    stability = bootstrapStability(reduced, k);
  }

  return { labels, k, silhouetteScore, stability, pcaDimensions: targetDims };
}

// ── Smoke test ────────────────────────────────────────────────────────────────

if (require.main === module) {
  void (async () => {
    console.log("Smoke test: 50 random 1536-dim vectors...");

    const embeddings = Array.from({ length: 50 }, () =>
      Array.from({ length: 1536 }, () => Math.random() * 2 - 1),
    );

    const result = await clusterEmbeddings(embeddings, {
      targetDims: 15,
      kMin: 2,
      kMax: 4,
      minClusterSize: 5,
      validateStability: true,
    });

    console.log("\nResult:");
    console.log(`  k              = ${result.k}`);
    console.log(`  silhouette     = ${result.silhouetteScore.toFixed(4)}`);
    console.log(`  pcaDimensions  = ${result.pcaDimensions}`);
    console.log(`  labels[0..9]   = [${result.labels.slice(0, 10).join(", ")}]`);
    if (result.stability) {
      console.log(
        `  stability      = meanARI=${result.stability.meanARI.toFixed(3)}, ` +
          `stdARI=${result.stability.stdARI.toFixed(3)}, ` +
          `stable=${result.stability.stable}`,
      );
    }

    // Sanity checks
    if (result.labels.length !== 50) throw new Error("labels length mismatch");
    if (result.k < 2 || result.k > 4) throw new Error("k out of range");
    if (result.pcaDimensions !== 15) throw new Error("pcaDims mismatch");

    // Verify projectNewEmbedding works on a new unseen vector
    const newVec = Array.from({ length: 1536 }, () => Math.random() * 2 - 1);
    const projected = projectNewEmbedding(newVec);
    if (projected.length !== 15) throw new Error("projected dim mismatch");
    const norm = projected.reduce((s, x) => s + x * x, 0);
    if (Math.abs(norm - 1) > 1e-9) throw new Error("projected vector not unit-normalized");

    console.log("\n✓ All sanity checks passed.");
    process.exit(0);
  })().catch((e) => {
    console.error("Smoke test failed:", e);
    process.exit(1);
  });
}
