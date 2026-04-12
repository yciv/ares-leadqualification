import { Fragment } from "react";
import { AlertCircle } from "lucide-react";
import type { ClusteringMetadata } from "@/lib/schemas/project";

type PhaseState = "completed" | "in-progress" | "pending" | "error";

interface PipelineStepperProps {
  statusCounts: Record<string, number>;
  totalLeads: number;
  projectType: "seed" | "test" | "live";
  clusteringMetadata: ClusteringMetadata | null;
  hasScores: boolean;
}

const PHASE_LABELS = ["Enrichment", "CrUX", "LLM", "Embed", "Cluster/Score"];

function derivePhaseStates(
  sc: Record<string, number>,
  totalLeads: number,
  projectType: string,
  clusteringMetadata: ClusteringMetadata | null,
  hasScores: boolean,
): PhaseState[] {
  if (totalLeads === 0) return Array(5).fill("pending") as PhaseState[];

  const c = (k: string) => sc[k] ?? 0;
  const pending = c("pending");
  const p1Done = c("phase1_done"), p1Err = c("phase1_error");
  const p2Done = c("phase2_done"), p2Err = c("phase2_error");
  const p3Done = c("phase3_done"), p3Err = c("phase3_error");
  const p4Err = c("phase4_error");
  const p4Done = c("phase4_done");

  const reached = [
    totalLeads - pending,
    totalLeads - pending - p1Done - p1Err,
    totalLeads - pending - p1Done - p1Err - p2Done - p2Err,
    p4Done + p4Err,
  ];
  const errors = [p1Err, p2Err, p3Err, p4Err];
  const inputs = [pending, p1Done, p2Done, p3Done];

  const states: PhaseState[] = Array.from({ length: 4 }, (_, i) => {
    if (errors[i] > 0) return "error";
    if (inputs[i] > 0) return "in-progress";
    if (reached[i] > 0) return "completed";
    return "pending";
  });

  const p5Complete =
    (projectType === "seed" && clusteringMetadata != null) ||
    (projectType !== "seed" && hasScores);
  states.push(p5Complete ? "completed" : "pending");

  return states;
}

function StepNode({ state }: { state: PhaseState }) {
  const base = "h-3 w-3 rounded-full";

  switch (state) {
    case "completed":
      return <div className={`${base} bg-accent-gold`} />;
    case "in-progress":
      return (
        <div className={`${base} border-2 border-accent-gold flex items-center justify-center`}>
          <div className="h-1 w-1 rounded-full bg-accent-gold animate-pulse" />
        </div>
      );
    case "pending":
      return <div className={`${base} border-2 border-status-neutral`} />;
    case "error":
      return <AlertCircle className="h-3 w-3 text-status-danger" />;
  }
}

const LABEL_COLORS: Record<PhaseState, string> = {
  completed: "text-accent-gold",
  "in-progress": "text-text-primary",
  pending: "text-text-muted",
  error: "text-status-danger",
};

export function PipelineStepper({
  statusCounts,
  totalLeads,
  projectType,
  clusteringMetadata,
  hasScores,
}: PipelineStepperProps) {
  const states = derivePhaseStates(
    statusCounts, totalLeads, projectType, clusteringMetadata, hasScores,
  );

  const p4Done = statusCounts["phase4_done"] ?? 0;
  const errorTotal = Object.entries(statusCounts)
    .filter(([k]) => k.endsWith("_error"))
    .reduce((sum, [, v]) => sum + v, 0);
  const inProgressIdx = states.findIndex((s) => s === "in-progress");
  const allComplete = states.every((s) => s === "completed");

  let statusLine: string;
  if (totalLeads === 0) {
    statusLine = "No leads";
  } else if (allComplete) {
    statusLine = `${totalLeads} leads processed \u00b7 Pipeline complete`;
  } else {
    const parts: string[] = [];
    parts.push(`${p4Done}/${totalLeads} leads processed`);
    if (errorTotal > 0) parts.push(`${errorTotal} error${errorTotal !== 1 ? "s" : ""}`);
    if (inProgressIdx >= 0) parts.push(`${PHASE_LABELS[inProgressIdx]} in progress`);
    statusLine = parts.join(" \u00b7 ");
  }

  return (
    <div className="rounded-xl border border-border-default bg-bg-surface p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-text-muted">
        Pipeline Progress
      </h2>

      <div className="flex items-start">
        {PHASE_LABELS.map((label, i) => (
          <Fragment key={label}>
            <div className="flex flex-col items-center min-w-[60px]">
              <StepNode state={states[i]} />
              <span className={`mt-1.5 text-xs ${LABEL_COLORS[states[i]]}`}>
                {label}
              </span>
            </div>
            {i < PHASE_LABELS.length - 1 && (
              <div
                className={`flex-1 h-0.5 mt-[5px] min-w-[16px] ${
                  states[i] === "completed" ? "bg-accent-gold" : "bg-border-default"
                }`}
              />
            )}
          </Fragment>
        ))}
      </div>

      <p className="mt-3 text-xs text-text-secondary tabular-nums">
        {statusLine}
      </p>
    </div>
  );
}
