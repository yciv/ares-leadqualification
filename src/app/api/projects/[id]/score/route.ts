import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface ScoreRequestBody {
  seedProjectId: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: testProjectId } = await params;

  let body: ScoreRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { seedProjectId } = body;

  if (!seedProjectId) {
    return NextResponse.json({ error: "seedProjectId is required" }, { status: 400 });
  }

  // Validate: test project must not be a seed project
  const { data: testProject, error: testProjectError } = await supabase
    .from("projects")
    .select("project_type")
    .eq("id", testProjectId)
    .single();

  if (testProjectError || !testProject) {
    return NextResponse.json({ error: "Test project not found" }, { status: 404 });
  }

  if (testProject.project_type === "seed") {
    return NextResponse.json(
      { error: "Cannot score a seed project against itself" },
      { status: 400 }
    );
  }

  // Validate: seed project must have centroids
  const { data: centroids, error: centroidsError } = await supabase
    .from("centroids")
    .select("id")
    .eq("project_id", seedProjectId);

  if (centroidsError) {
    return NextResponse.json({ error: centroidsError.message }, { status: 500 });
  }

  if (!centroids || centroids.length === 0) {
    return NextResponse.json(
      { error: "Seed project has no centroids. Calculate centroids first." },
      { status: 400 }
    );
  }

  await tasks.trigger("score-leads", { testProjectId, seedProjectId });

  return NextResponse.json({ message: "Scoring queued" });
}
