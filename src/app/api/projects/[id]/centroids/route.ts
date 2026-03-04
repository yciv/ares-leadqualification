import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  await tasks.trigger("calculate-centroids", { projectId });

  return NextResponse.json({ message: "Centroid calculation queued" });
}
