import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { tasks } from "@trigger.dev/sdk";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("project_type")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (project.project_type !== "seed") {
    return NextResponse.json(
      { error: "Centroid calculation is only available for seed projects" },
      { status: 400 }
    );
  }

  await tasks.trigger("calculate-centroids", { projectId });

  return NextResponse.json({ message: "Centroid calculation queued" });
}
