"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { useRouter } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ProjectCard } from "@/components/projects/project-card";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  derivePipelineStatus,
  type Project,
  type ProjectWithStats,
} from "@/lib/schemas/project";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const supabase = createSupabaseBrowserClient();

      // Fetch all projects
      const { data: rows } = await supabase
        .from("projects")
        .select("*")
        .order("created_at", { ascending: false });

      if (!rows || rows.length === 0) {
        setProjects([]);
        setLoading(false);
        return;
      }

      const projectIds = rows.map((r: Project) => r.id);

      // Fetch all lead statuses for these projects in one query
      const { data: leadRows } = await supabase
        .from("leads")
        .select("project_id, status")
        .in("project_id", projectIds);

      // Group status counts by project
      const countsByProject: Record<string, Record<string, number>> = {};
      for (const lead of leadRows ?? []) {
        const pid = lead.project_id as string;
        if (!countsByProject[pid]) countsByProject[pid] = {};
        const st = lead.status as string;
        countsByProject[pid][st] = (countsByProject[pid][st] ?? 0) + 1;
      }

      const enriched: ProjectWithStats[] = rows.map((p: Project) => {
        const statusCounts = countsByProject[p.id] ?? {};
        const leadCount = Object.values(statusCounts).reduce(
          (a, b) => a + b,
          0
        );
        return {
          ...p,
          lead_count: leadCount,
          status_counts: statusCounts,
          pipeline_status: derivePipelineStatus(
            statusCounts,
            p.project_type,
            p.clustering_metadata
          ),
        };
      });

      setProjects(enriched);
      setLoading(false);
    }

    load();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Projects"
        description="Manage your lead qualification projects"
        action={
          <Link href="/projects/new" className={buttonVariants()}>
            New Project
          </Link>
        }
      />

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[132px] rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project to start qualifying leads."
          action={{
            label: "Create Project",
            onClick: () => router.push("/projects/new"),
          }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
