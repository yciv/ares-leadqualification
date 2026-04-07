"use client";

import { useState } from "react";
import { useResultsStore, type ResultLead } from "@/lib/store/resultsStore";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { type Centroid } from "@/app/projects/[id]/results/page";

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

// ─── Sub-components ───────────────────────────────────────────────────────────

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
      className={`cursor-pointer rounded-xl border p-4 transition-colors ${
        selected
          ? "border-violet-500 bg-violet-950/40"
          : "border-gray-700 bg-gray-900 hover:border-gray-600"
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
            className="flex-1 rounded border border-violet-500 bg-gray-800 px-2 py-0.5 text-sm text-white focus:outline-none"
          />
        ) : (
          <span
            className="flex-1 text-sm font-semibold text-white"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            title="Double-click to rename"
          >
            {centroid.cluster_label}
          </span>
        )}
        <span className="shrink-0 rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
          {leads.length} leads
        </span>
      </div>

      {/* Stats */}
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <p className="text-gray-500">Archetype</p>
          <p className="mt-0.5 font-medium text-gray-200">{dominantArchetype}</p>
        </div>
        <div>
          <p className="text-gray-500">Industry</p>
          <p className="mt-0.5 font-medium text-gray-200">{dominantIndustry}</p>
        </div>
        <div>
          <p className="text-gray-500">Avg Maturity</p>
          <p className="mt-0.5 font-medium text-gray-200">{avgMaturity}/5</p>
        </div>
      </div>

      {/* Notes */}
      {centroid.notes && (
        <p className="mb-3 text-xs text-gray-400 line-clamp-2">{centroid.notes}</p>
      )}

      {/* Actions */}
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={handleDownload}
          className="rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-200"
        >
          Download JSON
        </button>
        <button
          className="rounded border border-violet-700 px-2.5 py-1 text-xs text-violet-400 hover:border-violet-500 hover:text-violet-200"
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

  const filteredLeads = selectedLabel
    ? leads.filter((l) => l.cluster_label === selectedLabel)
    : leads;

  const leadsForCentroid = (label: string) =>
    leads.filter((l) => l.cluster_label === label);

  async function handleLabelSave(centroidId: string, newLabel: string) {
    // Optimistic update
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
      <p className="text-sm text-gray-500">
        No centroids yet. Run "Calculate Centroids" from the project page first.
      </p>
    );
  }

  return (
    <div className="flex gap-6">
      {/* ── Left: Centroid cards ── */}
      <div className="w-80 shrink-0 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">
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
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-400">
          {selectedLabel ? `Leads in "${selectedLabel}"` : "All Leads"}
          <span className="ml-2 normal-case text-gray-600">
            ({filteredLeads.length})
          </span>
        </h2>
        <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-400">
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Archetype</th>
                <th className="px-4 py-3 font-medium text-center">Maturity</th>
                <th className="px-4 py-3 font-medium text-center">CrUX Rank</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                    No leads in this cluster.
                  </td>
                </tr>
              ) : (
                filteredLeads.map((lead) => (
                  <tr key={lead.id} className="border-b border-gray-800/60 hover:bg-gray-800/40">
                    <td className="px-4 py-2.5 font-medium text-gray-200">{lead.company_name}</td>
                    <td className="px-4 py-2.5 text-gray-400">{lead.canonical_domain}</td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {lead.standardized_data?.stack_archetype ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-300">
                      {lead.standardized_data?.tech_maturity_score ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-400">
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
