"use client";

import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useResultsStore, type ResultLead } from "@/lib/store/resultsStore";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { type Centroid } from "@/app/(dashboard)/projects/[id]/results/page";
import { ScoreBadge } from "@/components/leads/score-badge";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mode<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  const freq = new Map<T, number>();
  for (const v of arr) freq.set(v, (freq.get(v) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

type SortKey = "company_name" | "fit_score" | "routing_flag" | "stack_archetype" | "tech_maturity_score" | "crux_rank";
type SortDir = "asc" | "desc";

function getSortValue(lead: ResultLead, key: SortKey): string | number | null {
  switch (key) {
    case "company_name":        return lead.company_name;
    case "fit_score":           return lead.fit_score;
    case "routing_flag":        return lead.routing_flag;
    case "stack_archetype":     return lead.standardized_data?.stack_archetype ?? null;
    case "tech_maturity_score": return lead.standardized_data?.tech_maturity_score ?? null;
    case "crux_rank":           return lead.crux_data?.crux_rank ?? null;
  }
}

function sortLeads(leads: ResultLead[], key: SortKey, dir: SortDir): ResultLead[] {
  return [...leads].sort((a, b) => {
    const av = getSortValue(a, key);
    const bv = getSortValue(b, key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return dir === "asc" ? cmp : -cmp;
  });
}

// ─── SortHeader ──────────────────────────────────────────────────────────────

function SortHeader({
  label,
  sortKey,
  activeKey,
  activeDir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "center" | "right";
}) {
  const active = sortKey === activeKey;
  const alignCls = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`cursor-pointer select-none px-3 py-2 font-medium uppercase tracking-wider ${
        active ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
      }`}
    >
      <span className={`inline-flex items-center gap-1 ${alignCls}`}>
        {label}
        {active && (activeDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </span>
    </th>
  );
}

// ─── CentroidCard ────────────────────────────────────────────────────────────

function CentroidCard({
  centroid,
  leads,
  selected,
  onSelect,
  onLabelSave,
}: {
  centroid: Centroid;
  leads: ResultLead[];
  selected: boolean;
  onSelect: () => void;
  onLabelSave: (newLabel: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(centroid.cluster_label);

  const archetypes = leads
    .map((l) => l.standardized_data?.stack_archetype)
    .filter(Boolean) as string[];
  const industries = leads
    .map((l) => l.linkup_data?.industry)
    .filter(Boolean) as string[];
  const scores = leads
    .map((l) => l.standardized_data?.tech_maturity_score)
    .filter((s): s is number => s != null);

  const dominantArchetype = mode(archetypes) ?? "—";
  const dominantIndustry = mode(industries) ?? "—";
  const avgMaturity = scores.length ? avg(scores).toFixed(1) : "—";

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      onLabelSave(draft);
      setEditing(false);
    }
    if (e.key === "Escape") {
      setDraft(centroid.cluster_label);
      setEditing(false);
    }
  }

  function handleDownload() {
    const blob = new Blob(
      [JSON.stringify({ centroid, leads }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `centroid-${centroid.cluster_label}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-lg border p-4 transition-colors ${
        selected
          ? "border-border-focus bg-accent-gold-muted"
          : "border-border-default bg-bg-surface hover:border-border-hover"
      }`}
    >
      {/* Cluster label with inline edit */}
      <div className="mb-3 flex items-center justify-between gap-2">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              onLabelSave(draft);
              setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-border-focus bg-bg-elevated px-2 py-0.5 text-sm text-text-primary focus:outline-none"
          />
        ) : (
          <span
            className="flex-1 text-sm font-semibold text-text-primary"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            title="Double-click to rename"
          >
            {centroid.cluster_label}
          </span>
        )}
        <span className="shrink-0 rounded bg-bg-elevated px-2 py-0.5 text-xs text-text-secondary">
          {leads.length} leads
        </span>
      </div>

      {/* Stats */}
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <p className="text-text-muted">Archetype</p>
          <p className="mt-0.5 font-medium text-text-secondary">{dominantArchetype}</p>
        </div>
        <div>
          <p className="text-text-muted">Industry</p>
          <p className="mt-0.5 font-medium text-text-secondary">{dominantIndustry}</p>
        </div>
        <div>
          <p className="text-text-muted">Avg Maturity</p>
          <p className="mt-0.5 font-medium text-text-secondary">{avgMaturity}/5</p>
        </div>
      </div>

      {/* Notes */}
      {centroid.notes && (
        <p className="mb-3 text-xs text-text-secondary line-clamp-2">{centroid.notes}</p>
      )}

      {/* Actions */}
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={handleDownload}
          className="rounded-md border border-border-default px-2.5 py-1 text-xs text-text-secondary hover:border-border-hover hover:text-text-primary"
        >
          Download JSON
        </button>
        <button
          className="rounded-md border border-accent-gold/30 px-2.5 py-1 text-xs text-accent-gold hover:border-accent-gold hover:text-accent-gold-hover"
          onClick={() => console.log("Score a test batch against cluster", centroid.cluster_label)}
        >
          ↗ Score Test Batch
        </button>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SeedResultsView({
  projectId,
  centroids: initialCentroids,
}: {
  projectId: string;
  centroids: Centroid[];
}) {
  const supabase = createSupabaseBrowserClient();
  const leads = useResultsStore((s) => s.leads);
  const [centroids, setCentroids] = useState(initialCentroids);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(
    initialCentroids[0]?.cluster_label ?? null
  );
  const [sortKey, setSortKey] = useState<SortKey>("company_name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filteredLeads = selectedLabel
    ? leads.filter((l) => l.cluster_label === selectedLabel)
    : leads;

  const sortedLeads = useMemo(
    () => sortLeads(filteredLeads, sortKey, sortDir),
    [filteredLeads, sortKey, sortDir]
  );

  const leadsForCentroid = (label: string) =>
    leads.filter((l) => l.cluster_label === label);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "company_name" ? "asc" : "desc");
    }
  }

  async function handleLabelSave(centroidId: string, newLabel: string) {
    setCentroids((prev) =>
      prev.map((c) => (c.id === centroidId ? { ...c, cluster_label: newLabel } : c))
    );
    if (selectedLabel) setSelectedLabel(newLabel);

    await supabase
      .from("centroids")
      .update({ cluster_label: newLabel })
      .eq("id", centroidId);
  }

  if (centroids.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No centroids yet. Run &ldquo;Calculate Centroids&rdquo; from the project page first.
      </p>
    );
  }

  return (
    <div className="flex gap-6">
      {/* ── Left: Centroid cards ── */}
      <div className="w-80 shrink-0 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          ICP Clusters
        </h2>
        {centroids.map((c) => (
          <CentroidCard
            key={c.id}
            centroid={c}
            leads={leadsForCentroid(c.cluster_label)}
            selected={selectedLabel === c.cluster_label}
            onSelect={() => setSelectedLabel(c.cluster_label)}
            onLabelSave={(newLabel) => handleLabelSave(c.id, newLabel)}
          />
        ))}
      </div>

      {/* ── Right: Lead table for selected cluster ── */}
      <div className="min-w-0 flex-1">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
          {selectedLabel ? `Leads in \u201c${selectedLabel}\u201d` : "All Leads"}
          <span className="ml-2 normal-case text-text-muted">
            ({sortedLeads.length})
          </span>
        </h2>
        <div className="rounded-lg border border-border-default bg-bg-surface overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-bg-surface">
              <tr className="border-b border-border-default text-xs">
                <SortHeader label="Company" sortKey="company_name" activeKey={sortKey} activeDir={sortDir} onSort={handleSort} />
                <th className="px-3 py-2 font-medium uppercase tracking-wider text-text-muted">Domain</th>
                <SortHeader label="Score" sortKey="fit_score" activeKey={sortKey} activeDir={sortDir} onSort={handleSort} />
                <SortHeader label="Archetype" sortKey="stack_archetype" activeKey={sortKey} activeDir={sortDir} onSort={handleSort} />
                <SortHeader label="Maturity" sortKey="tech_maturity_score" activeKey={sortKey} activeDir={sortDir} onSort={handleSort} align="right" />
                <SortHeader label="CrUX Rank" sortKey="crux_rank" activeKey={sortKey} activeDir={sortDir} onSort={handleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sortedLeads.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-text-muted">
                    No leads in this cluster.
                  </td>
                </tr>
              ) : (
                sortedLeads.map((lead) => (
                  <tr key={lead.id} className="border-b border-border-default hover:bg-bg-elevated">
                    <td className="px-3 py-2 font-medium text-text-primary">{lead.company_name}</td>
                    <td className="px-3 py-2 text-text-secondary">{lead.canonical_domain}</td>
                    <td className="px-3 py-2">
                      <ScoreBadge routingFlag={lead.routing_flag} fitScore={lead.fit_score} />
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {lead.standardized_data?.stack_archetype ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                      {lead.standardized_data?.tech_maturity_score ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
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
    </div>
  );
}
