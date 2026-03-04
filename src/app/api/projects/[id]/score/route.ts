import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";

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

  await tasks.trigger("score-leads", { testProjectId, seedProjectId });

  return NextResponse.json({ message: "Scoring queued" });
}
