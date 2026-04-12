import { z } from "zod";

// ─── DB shape ────────────────────────────────────────────────────────────────

export const ProjectTypeSchema = z.enum(["seed", "test", "live"]);

export interface ClusteringMetadata {
  k: number;
  silhouette_score: number;
  stability: number;
  pca_dimensions: number;
  clustered_at: string;
  lead_count: number;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  project_type: "seed" | "test" | "live";
  user_id: string;
  created_at: string;
  clustering_metadata: ClusteringMetadata | null;
}

// ─── Enriched shape for the projects list ────────────────────────────────────

export type PipelineStatus =
  | "empty"
  | "enriching"
  | "embedding"
  | "clustering"
  | "scoring"
  | "done"
  | "error";

export interface ProjectWithStats extends Project {
  lead_count: number;
  pipeline_status: PipelineStatus;
  status_counts: Record<string, number>;
}

// ─── Pipeline status derivation ──────────────────────────────────────────────

export function derivePipelineStatus(
  statusCounts: Record<string, number>,
  projectType: Project["project_type"],
  clusteringMetadata: ClusteringMetadata | null
): PipelineStatus {
  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  if (total === 0) return "empty";

  // Any lead in an error state → error
  const hasErrors = Object.keys(statusCounts).some(
    (key) => key.endsWith("_error") && statusCounts[key] > 0
  );
  if (hasErrors) return "error";

  const phase4Done = statusCounts["phase4_done"] ?? 0;
  const allDone = phase4Done === total;

  if (!allDone) {
    // Some leads still in pending or intermediate phases
    return "enriching";
  }

  // All leads are phase4_done
  if (projectType === "seed") {
    return clusteringMetadata ? "done" : "clustering";
  }

  // test or live — check if any leads have been scored
  // (scoring writes fit_score, but we only have status counts here,
  //  so "done" for test/live means phase4_done + clustered seed exists)
  return "done";
}
