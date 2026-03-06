"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/browser";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  description: string | null;
  project_type: "seed" | "test" | "live";
  created_at: string;
}

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
  pending: "bg-gray-600",
  phase1_done: "bg-blue-500",
  phase2_done: "bg-cyan-500",
  phase3_done: "bg-violet-500",
  phase4_done: "bg-green-500",
  error: "bg-red-500",
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
    "inline-block rounded px-2 py-0.5 text-xs font-medium text-white";

  if (isError) return <span className={`${base} bg-red-600`}>{label}</span>;

  const color = STATUS_COLORS[status] ?? "bg-gray-600";
  return <span className={`${base} ${color}`}>{label}</span>;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = createBrowserClient();

  const [project, setProject] = useState<Project | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueMessage, setContinueMessage] = useState<string | null>(null);
  const [queuingCentroids, setQueuingCentroids] = useState(false);
  const [centroidsMessage, setCentroidsMessage] = useState<string | null>(null);

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

  const stuckCount = leads.filter((l) =>
    ["phase1_done", "phase2_done", "phase3_done"].includes(l.status)
  ).length;
  const showContinuePipeline = stuckCount > 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-500">
        Loading…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center text-red-400">
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
            <p className="mt-1 text-sm text-gray-400">{project.description}</p>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
            <span className="rounded bg-gray-800 px-2 py-0.5 font-medium capitalize text-gray-300">
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
              className="rounded-lg border border-blue-700 bg-blue-950 px-4 py-2 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-900 disabled:opacity-50"
            >
              {continuing ? "Continuing…" : `Continue Pipeline (${stuckCount})`}
            </button>
          )}
          {errorCount > 0 && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="rounded-lg border border-red-700 bg-red-950 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900 disabled:opacity-50"
            >
              {retrying ? "Retrying…" : `Retry Failed (${errorCount})`}
            </button>
          )}
          {showCalculateCentroids && (
            <button
              onClick={handleCalculateCentroids}
              disabled={queuingCentroids}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {queuingCentroids ? "Queueing…" : "Calculate Centroids"}
            </button>
          )}
        </div>
      </div>

      {continueMessage && (
        <p className="rounded-lg border border-blue-800 bg-blue-950 px-4 py-2 text-sm text-blue-300">
          {continueMessage}
        </p>
      )}

      {retryMessage && (
        <p className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-300">
          {retryMessage}
        </p>
      )}

      {centroidsMessage && (
        <p className="rounded-lg border border-violet-800 bg-violet-950 px-4 py-2 text-sm text-violet-300">
          {centroidsMessage}
        </p>
      )}

      {/* ── Progress ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
          Pipeline Progress
        </h2>

        {/* Progress bar */}
        {total > 0 && (
          <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-gray-800">
            {[...ORDERED_STATUSES, "error" as const].map((key) => {
              const count = statusCounts[key] ?? 0;
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={key}
                  className={`${STATUS_COLORS[key] ?? "bg-gray-600"} transition-all`}
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
                  className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_COLORS[key] ?? "bg-gray-600"}`}
                />
                <span className="text-xs text-gray-400">
                  {STATUS_LABELS[key] ?? key}
                </span>
                <span className="text-xs font-semibold text-white">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Leads Table ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-400">
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
                    className="px-4 py-8 text-center text-sm text-gray-500"
                  >
                    No leads yet.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr
                    key={lead.id}
                    className="border-b border-gray-800/60 hover:bg-gray-800/40"
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-200">
                      {lead.company_name}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {lead.canonical_domain}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={lead.status} />
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-300">
                      {lead.standardized_data?.tech_maturity_score ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {lead.standardized_data?.stack_archetype ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-400">
                      {lead.crux_data?.crux_rank != null
                        ? lead.crux_data.crux_rank.toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-300">
                      {lead.fit_score != null
                        ? lead.fit_score.toFixed(2)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
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
