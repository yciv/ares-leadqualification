"use client";

import { useRef, useState } from "react";
import { useResultsStore, type ResultLead, type Thresholds } from "@/lib/store/resultsStore";

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTING_FLAGS = ["AE", "SDR", "nurture", "reject"] as const;
type RoutingFlag = (typeof ROUTING_FLAGS)[number];

const FLAG_STYLES: Record<RoutingFlag, string> = {
  AE:      "bg-status-success/20 text-status-success",
  SDR:     "bg-status-info/20    text-status-info",
  nurture: "bg-status-warning/20 text-status-warning",
  reject:  "bg-status-neutral/20 text-status-neutral",
};

// ─── RoutingBadge ─────────────────────────────────────────────────────────────

function RoutingBadge({
  leadId,
  flag,
  overridden,
}: {
  leadId: string;
  flag: string | null;
  overridden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const overrideRouting = useResultsStore((s) => s.overrideRouting);
  const ref = useRef<HTMLDivElement>(null);

  const current = (flag ?? "reject") as RoutingFlag;
  const style = FLAG_STYLES[current] ?? "bg-status-neutral/20 text-status-neutral";

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${style} ${overridden ? "ring-1 ring-white/30" : ""}`}
        title={overridden ? "Manually overridden" : undefined}
      >
        {current}
        {overridden && <span className="text-[10px] opacity-60">✎</span>}
        <span className="text-[10px] opacity-60">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-28 rounded-lg border border-border-default bg-bg-surface py-1 shadow-lg">
          {ROUTING_FLAGS.map((f) => (
            <button
              key={f}
              onClick={() => {
                overrideRouting(leadId, f);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-elevated ${
                f === current ? "font-semibold text-text-primary" : "text-text-secondary"
              }`}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${FLAG_STYLES[f].split(" ")[0]}`} />
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ThresholdControl ─────────────────────────────────────────────────────────

function ThresholdControl({
  label,
  tier,
  value,
}: {
  label: string;
  tier: keyof Thresholds;
  value: number;
}) {
  const setThreshold = useResultsStore((s) => s.setThreshold);
  const [draft, setDraft] = useState(String(value));

  function commit(raw: string) {
    const num = parseFloat(raw);
    if (!isNaN(num) && num >= 0 && num <= 1) setThreshold(tier, num);
    else setDraft(String(value)); // revert invalid input
  }

  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-xs text-text-secondary">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => {
          setDraft(e.target.value);
          setThreshold(tier, parseFloat(e.target.value));
        }}
        className="w-32 accent-accent-gold"
      />
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(draft);
          if (e.key === "Escape") setDraft(String(value));
        }}
        className="w-14 rounded border border-border-default bg-bg-elevated px-2 py-0.5 text-center text-xs text-text-primary focus:border-border-focus focus:outline-none"
      />
    </div>
  );
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

function exportCsv(leads: ResultLead[]) {
  const header = [
    "company_name",
    "canonical_domain",
    "cluster_label",
    "fit_score",
    "routing_flag",
    "stack_archetype",
    "tech_maturity_score",
    "crux_rank",
    "overridden",
  ].join(",");

  const rows = leads.map((l) =>
    [
      `"${l.company_name}"`,
      l.canonical_domain,
      l.cluster_label ?? "",
      l.fit_score?.toFixed(4) ?? "",
      l.routing_flag ?? "",
      l.standardized_data?.stack_archetype ?? "",
      l.standardized_data?.tech_maturity_score ?? "",
      l.crux_data?.crux_rank ?? "",
      l._overridden ? "1" : "0",
    ].join(",")
  );

  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "test-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function TestResultsView({ projectId }: { projectId: string }) {
  const leads = useResultsStore((s) => s.leads);
  const thresholds = useResultsStore((s) => s.thresholds);
  const reviewCount = useResultsStore((s) => s.reviewCount);

  const canSyncToAttio = reviewCount >= 10;
  const pendingCount = leads.filter((l) => l.fit_score == null && l.status === "phase4_done").length;

  return (
    <div className="space-y-6">
      {/* ── Scoring-in-progress banner ── */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-accent-gold/30 bg-accent-gold-muted px-5 py-3">
          <div className="h-2 w-2 animate-pulse rounded-full bg-accent-gold" />
          <p className="text-sm text-accent-gold">
            Scoring in progress — {pendingCount} lead{pendingCount !== 1 ? "s" : ""} pending...
          </p>
        </div>
      )}

      {/* ── Threshold controls ── */}
      <div className="rounded-xl border border-border-default bg-bg-surface p-5">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-text-muted">
          Routing Thresholds
        </h2>
        <div className="flex flex-wrap gap-4">
          <ThresholdControl label="AE"      tier="ae"      value={thresholds.ae} />
          <ThresholdControl label="SDR"     tier="sdr"     value={thresholds.sdr} />
          <ThresholdControl label="Nurture" tier="nurture" value={thresholds.nurture} />
        </div>
        <p className="mt-3 text-xs text-text-muted">
          Thresholds are applied client-side. Use "Export CSV" to lock in the current assignment.
        </p>
      </div>

      {/* ── Actions bar ── */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {leads.length} leads · {reviewCount} manually reviewed
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => exportCsv(leads)}
            className="rounded-md border border-border-default px-4 py-2 text-sm font-medium text-text-secondary hover:border-border-hover"
          >
            Export CSV
          </button>
          <button
            disabled={!canSyncToAttio}
            title={!canSyncToAttio ? `Review ${10 - reviewCount} more leads to unlock` : undefined}
            onClick={() => console.log("Sync to Attio — project:", projectId)}
            className="rounded-md bg-accent-gold px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-gold-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sync to Attio
            {!canSyncToAttio && (
              <span className="ml-1.5 text-xs opacity-70">
                ({10 - reviewCount} left)
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Results table ── */}
      <div className="rounded-xl border border-border-default bg-bg-surface overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-default text-xs text-text-muted">
              <th className="px-4 py-3 font-medium">Domain</th>
              <th className="px-4 py-3 font-medium">Matched Cluster</th>
              <th className="px-4 py-3 font-medium text-right">Fit %</th>
              <th className="px-4 py-3 font-medium">Routing</th>
              <th className="px-4 py-3 font-medium">Stack Archetype</th>
              <th className="px-4 py-3 font-medium text-center">Maturity</th>
              <th className="px-4 py-3 font-medium text-center">CrUX Rank</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                  No scored leads yet.
                </td>
              </tr>
            ) : (
              leads.map((lead) => (
                <tr key={lead.id} className="border-b border-border-default/60 hover:bg-bg-elevated/40">
                  <td className="px-4 py-2.5 font-medium text-text-primary">
                    {lead.canonical_domain}
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">
                    {lead.cluster_label ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-text-secondary tabular-nums">
                    {lead.fit_score != null
                      ? `${(lead.fit_score * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <RoutingBadge
                      leadId={lead.id}
                      flag={lead.routing_flag}
                      overridden={lead._overridden}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">
                    {lead.standardized_data?.stack_archetype ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-center text-text-secondary">
                    {lead.standardized_data?.tech_maturity_score ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-center text-text-secondary">
                    {lead.crux_data?.crux_rank != null
                      ? lead.crux_data.crux_rank.toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
