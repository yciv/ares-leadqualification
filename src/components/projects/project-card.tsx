"use client";

import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ProjectWithStats, PipelineStatus } from "@/lib/schemas/project";

// ─── Pipeline status display ─────────────────────────────────────────────────

const PIPELINE_LABELS: Record<PipelineStatus, string> = {
  empty: "Empty",
  enriching: "Enriching",
  embedding: "Embedding",
  clustering: "Awaiting Clusters",
  scoring: "Scoring",
  done: "Complete",
  error: "Error",
};

function PipelineStatusBadge({ status }: { status: PipelineStatus }) {
  let className: string;

  switch (status) {
    case "done":
      className = "bg-status-success/15 text-status-success border-transparent";
      break;
    case "error":
      className = "bg-status-danger/15 text-status-danger border-transparent";
      break;
    case "empty":
      className = "bg-bg-elevated text-text-muted border-transparent";
      break;
    default:
      // enriching, embedding, clustering, scoring
      className =
        "bg-status-warning/15 text-status-warning border-transparent";
      break;
  }

  return (
    <Badge variant="outline" className={className}>
      {PIPELINE_LABELS[status]}
    </Badge>
  );
}

// ─── Type badge ──────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: "seed" | "test" | "live" }) {
  return (
    <Badge variant="secondary" className="capitalize">
      {type}
    </Badge>
  );
}

// ─── Relative time ───────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;

  return `${Math.floor(diffMonth / 12)}y ago`;
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function ProjectCard({ project }: { project: ProjectWithStats }) {
  return (
    <Link href={`/projects/${project.id}`} className="block">
      <Card className="cursor-pointer border-border-default bg-bg-surface transition-colors hover:border-border-hover">
        <CardContent className="flex flex-col gap-3">
          {/* Top: name + type badge */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <FolderKanban className="size-4 shrink-0 text-text-muted" />
              <span className="truncate text-sm font-semibold text-text-primary">
                {project.name}
              </span>
            </div>
            <TypeBadge type={project.project_type} />
          </div>

          {/* Middle: lead count + pipeline status */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary tabular-nums">
              {project.lead_count} lead{project.lead_count !== 1 ? "s" : ""}
            </span>
            <PipelineStatusBadge status={project.pipeline_status} />
          </div>

          {/* Bottom: created date */}
          <p className="text-xs text-text-muted">
            Created {relativeTime(project.created_at)}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
