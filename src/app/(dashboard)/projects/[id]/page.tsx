"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Project } from "@/lib/schemas/project";

interface Lead {
  id: string;
  company_name: string;
  canonical_domain: string;
  status: string;
  fit_score: number | null;
  cluster_label: string | null;
  crux_data: { crux_rank: number | null } | null;
  standardized_data: {
    tech_maturity_score: number | null;
    stack_archetype: string | null;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ORDERED_STATUSES = [
  "pending",
  "phase1_done",
  "phase2_done",
  "phase3_done",
  "phase4_done",
] as const;

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  phase1_done: "Enriched",
  phase2_done: "CrUX",
  phase3_done: "Standardized",
  phase4_done: "Embedded",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-status-neutral",
  phase1_done: "bg-status-info",
  phase2_done: "bg-cyan-500",
  phase3_done: "bg-violet-500",
  phase4_done: "bg-status-success",
  error: "bg-status-danger",
};

function isErrorStatus(status: string) {
  return status.endsWith("_error");
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const isError = isErrorStatus(status);
  const label = isError ? status.replace("_error", " ✗") : (STATUS_LABELS[status] ?? status);
  const base =
    "inline-block rounded px-2 py-0.5 text-xs font-medium text-text-primary";

  if (isError) return <span className={`${base} bg-status-danger`}>{label}</span>;

  const color = STATUS_COLORS[status] ?? "bg-status-neutral";
  return <span className={`${base} ${color}`}>{label}</span>;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  const [project, setProject] = useState<Project | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueMessage, setContinueMessage] = useState<string | null>(null);
  const [queuingCentroids, setQueuingCentroids] = useState(false);
  const [centroidsMessage, setCentroidsMessage] = useState<string | null>(null);
  const [seedProjectId, setSeedProjectId] = useState("");
  const [scoring, setScoring] = useState(false);

  // ── Initial data fetch ──────────────────────────────────────────────────────
  useEffect(() => {
    async function loadData() {
      const [{ data: proj }, { data: leadRows }] = await Promise.all([
        supabase.from("projects").select("*").eq("id", id).single(),
        supabase
          .from("leads")
          .select(
            "id, company_name, canonical_domain, status, fit_score, cluster_label, crux_data, standardized_data"
          )
          .eq("project_id", id)
          .order("created_at", { ascending: true }),
      ]);

      if (proj) setProject(proj as Project);
      if (leadRows) setLeads(leadRows as Lead[]);
      setLoading(false);
    }

    loadData();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime subscription ───────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`leads:project_id=eq.${id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leads",
          filter: `project_id=eq.${id}`,
        },
        (payload) => {
          const updated = payload.new as Lead;
          setLeads((prev) =>
            prev.map((l) => (l.id === updated.id ? { ...l, ...updated } : l))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Retry handler ───────────────────────────────────────────────────────────
  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      const res = await fetch(`/api/projects/${id}/retry`, { method: "POST" });
      const body = await res.json();
      setRetryMessage(body.message ?? "Retry triggered");
    } catch {
      setRetryMessage("Failed to trigger retry");
    } finally {
      setRetrying(false);
    }
  }, [id]);

  // ── Continue Pipeline handler ────────────────────────────────────────────────
  const handleContinue = useCallback(async () => {
    setContinuing(true);
    setContinueMessage(null);
    try {
      const res = await fetch(`/api/projects/${id}/continue`, { method: "POST" });
      const body = await res.json();
      const { phase2, phase3, phase4 } = body.triggered ?? {};
      const parts: string[] = [];
      if (phase2) parts.push(`${phase2} lead${phase2 !== 1 ? "s" : ""} → Phase 2`);
      if (phase3) parts.push(`${phase3} lead${phase3 !== 1 ? "s" : ""} → Phase 3`);
      if (phase4) parts.push(`${phase4} lead${phase4 !== 1 ? "s" : ""} → Phase 4`);
      setContinueMessage(parts.length > 0 ? `Pushed: ${parts.join(", ")}` : "No stuck leads found");
    } catch {
      setContinueMessage("Failed to continue pipeline");
    } finally {
      setContinuing(false);
    }
  }, [id]);

  // ── Score Project handler ────────────────────────────────────────────────────
  const handleScore = useCallback(async () => {
    setScoring(true);
    try {
      const res = await fetch(`/api/projects/${id}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedProjectId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error ?? `Error ${res.status}`);
        return;
      }
      router.push(`/projects/${id}/results`);
    } catch {
      alert("Failed to trigger scoring");
    } finally {
      setScoring(false);
    }
  }, [id, seedProjectId, router]);

  // ── Calculate Centroids handler ─────────────────────────────────────────────
  const handleCalculateCentroids = useCallback(async () => {
    setQueuingCentroids(true);
    setCentroidsMessage(null);
    try {
      const res = await fetch(`/api/projects/${id}/centroids`, {
        method: "POST",
      });
      const body = await res.json();
      setCentroidsMessage(body.message ?? "Queued");
    } catch {
      setCentroidsMessage("Failed to queue centroid calculation");
    } finally {
      setQueuingCentroids(false);
    }
  }, [id]);

  // ── Derived stats ───────────────────────────────────────────────────────────
  const total = leads.length;
  const errorLeads = leads.filter((l) => isErrorStatus(l.status));
  const errorCount = errorLeads.length;

  const statusCounts = leads.reduce<Record<string, number>>((acc, l) => {
    const key = isErrorStatus(l.status) ? "error" : l.status;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const allPhase4Done =
    total > 0 && leads.every((l) => l.status === "phase4_done");

  const showCalculateCentroids =
    project?.project_type === "seed" && allPhase4Done;

  const showScoreProject =
    (project?.project_type === "test" || project?.project_type === "live") && allPhase4Done;

  const stuckCount = leads.filter((l) =>
    ["phase1_done", "phase2_done", "phase3_done"].includes(l.status)
  ).length;
  const showContinuePipeline = stuckCount > 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-text-muted">
        Loading…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center text-status-danger">
        Project not found.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 space-y-8">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-sm text-text-secondary">{project.description}</p>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
            <span className="rounded bg-bg-elevated px-2 py-0.5 font-medium capitalize text-text-secondary">
              {project.project_type}
            </span>
            <span>{formatDate(project.created_at)}</span>
            <span>{total} lead{total !== 1 ? "s" : ""}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 gap-2">
          {showContinuePipeline && (
            <button
              onClick={handleContinue}
              disabled={continuing}
              className="rounded-md border border-status-info/30 bg-status-info/10 px-4 py-2 text-sm font-medium text-status-info transition-colors hover:bg-status-info/20 disabled:opacity-50"
            >
              {continuing ? "Continuing…" : `Continue Pipeline (${stuckCount})`}
            </button>
          )}
          {errorCount > 0 && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="rounded-md border border-status-danger/30 bg-status-danger/10 px-4 py-2 text-sm font-medium text-status-danger transition-colors hover:bg-status-danger/20 disabled:opacity-50"
            >
              {retrying ? "Retrying…" : `Retry Failed (${errorCount})`}
            </button>
          )}
          {showCalculateCentroids && (
            <button
              onClick={handleCalculateCentroids}
              disabled={queuingCentroids}
              className="rounded-md bg-accent-gold px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-gold-hover disabled:opacity-50"
            >
              {queuingCentroids ? "Queueing…" : "Calculate Centroids"}
            </button>
          )}
          {showScoreProject && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Seed Project ID"
                value={seedProjectId}
                onChange={(e) => setSeedProjectId(e.target.value)}
                className="rounded-md border border-border-default bg-bg-elevated px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:border-border-focus focus:outline-none"
              />
              <button
                onClick={handleScore}
                disabled={scoring || !seedProjectId.trim()}
                className="rounded-md bg-accent-gold px-4 py-1.5 text-sm font-medium text-text-inverse hover:bg-accent-gold-hover disabled:opacity-50"
              >
                {scoring ? "Scoring…" : "Score Project"}
              </button>
            </div>
          )}
          {leads.some((l) => l.fit_score !== null) && (
            <a
              href={`/projects/${id}/results`}
              className="rounded-md bg-bg-elevated border border-border-default px-4 py-1.5 text-sm font-medium text-text-primary hover:border-border-hover"
            >
              View Results →
            </a>
          )}
        </div>
      </div>

      {continueMessage && (
        <p className="rounded-lg border border-status-info/30 bg-status-info/10 px-4 py-2 text-sm text-status-info">
          {continueMessage}
        </p>
      )}

      {retryMessage && (
        <p className="rounded-lg border border-border-default bg-bg-surface px-4 py-2 text-sm text-text-secondary">
          {retryMessage}
        </p>
      )}

      {centroidsMessage && (
        <p className="rounded-lg border border-accent-gold/30 bg-accent-gold-muted px-4 py-2 text-sm text-accent-gold">
          {centroidsMessage}
        </p>
      )}

      {/* ── Progress ── */}
      <div className="rounded-xl border border-border-default bg-bg-surface p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-text-muted">
          Pipeline Progress
        </h2>

        {/* Progress bar */}
        {total > 0 && (
          <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-bg-elevated">
            {[...ORDERED_STATUSES, "error" as const].map((key) => {
              const count = statusCounts[key] ?? 0;
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={key}
                  className={`${STATUS_COLORS[key] ?? "bg-status-neutral"} transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${STATUS_LABELS[key] ?? key}: ${count}`}
                />
              );
            })}
          </div>
        )}

        {/* Stats row */}
        <div className="flex flex-wrap gap-4">
          {[...ORDERED_STATUSES, "error" as const].map((key) => {
            const count = statusCounts[key] ?? 0;
            return (
              <div key={key} className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_COLORS[key] ?? "bg-status-neutral"}`}
                />
                <span className="text-xs text-text-muted">
                  {STATUS_LABELS[key] ?? key}
                </span>
                <span className="text-xs font-semibold text-text-primary">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Leads Table ── */}
      <div className="rounded-xl border border-border-default bg-bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-default text-xs text-text-muted">
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-center">Maturity</th>
                <th className="px-4 py-3 font-medium">Stack Archetype</th>
                <th className="px-4 py-3 font-medium text-center">CrUX Rank</th>
                <th className="px-4 py-3 font-medium text-center">Fit Score</th>
                <th className="px-4 py-3 font-medium">Cluster</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-sm text-text-muted"
                  >
                    No leads yet.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr
                    key={lead.id}
                    className="border-b border-border-default/60 hover:bg-bg-elevated/40"
                  >
                    <td className="px-4 py-2.5 font-medium text-text-primary">
                      {lead.company_name}
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {lead.canonical_domain}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={lead.status} />
                    </td>
                    <td className="px-4 py-2.5 text-center text-text-secondary">
                      {lead.standardized_data?.tech_maturity_score ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {lead.standardized_data?.stack_archetype ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center text-text-secondary">
                      {lead.crux_data?.crux_rank != null
                        ? lead.crux_data.crux_rank.toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center text-text-secondary tabular-nums">
                      {lead.fit_score != null
                        ? lead.fit_score.toFixed(2)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {lead.cluster_label ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
