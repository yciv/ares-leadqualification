"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useResultsStore, type ResultLead } from "@/lib/store/resultsStore";
import SeedResultsView from "@/components/results/SeedResultsView";
import TestResultsView from "@/components/results/TestResultsView";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  project_type: "seed" | "test" | "live";
  created_at: string;
}

export interface Centroid {
  id: string;
  cluster_label: string;
  notes: string | null;
  lead_count: number | null;
  avg_fit_score: number | null;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ResultsPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = createSupabaseBrowserClient();
  const setLeads = useResultsStore((s) => s.setLeads);
  const updateLead = useResultsStore((s) => s.updateLead);

  const [project, setProject] = useState<Project | null>(null);
  const [centroids, setCentroids] = useState<Centroid[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [{ data: proj }, { data: leadRows }, { data: centroidRows }] =
        await Promise.all([
          supabase.from("projects").select("id, name, project_type, created_at").eq("id", id).single(),
          supabase
            .from("leads")
            .select(
              "id, company_name, canonical_domain, status, fit_score, cluster_label, routing_flag, scored_at, crux_data, standardized_data, linkup_data"
            )
            .eq("project_id", id)
            .order("fit_score", { ascending: false }),
          supabase
            .from("centroids")
            .select("id, cluster_label, notes, lead_count, avg_fit_score")
            .eq("project_id", id),
        ]);

      if (proj) setProject(proj as Project);
      if (leadRows) setLeads(leadRows as ResultLead[]);
      if (centroidRows) setCentroids(centroidRows as Centroid[]);
      setLoading(false);
    }

    load();

    const channel = supabase
      .channel("scoring-results")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leads",
          filter: `project_id=eq.${id}`,
        },
        (payload) => {
          updateLead(payload.new.id as string, payload.new as Partial<ResultLead>);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="mx-auto max-w-7xl px-4 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <span className="mt-1 inline-block rounded bg-gray-800 px-2 py-0.5 text-xs font-medium capitalize text-gray-300">
          {project.project_type} · Results
        </span>
      </div>

      {project.project_type === "seed" ? (
        <SeedResultsView projectId={id} centroids={centroids} />
      ) : (
        <TestResultsView projectId={id} />
      )}
    </div>
  );
}
