import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const triggered = { phase2: 0, phase3: 0, phase4: 0 };

  // phase1_done → trigger Phase 2
  const { data: phase1Done } = await supabase
    .from("leads")
    .select("id, canonical_domain")
    .eq("project_id", projectId)
    .eq("status", "phase1_done");

  if (phase1Done && phase1Done.length > 0) {
    await tasks.trigger("process-phase2-crux", {
      projectId,
      leads: phase1Done.map((l) => ({
        id: l.id,
        canonicalDomain: l.canonical_domain,
      })),
    });
    triggered.phase2 = phase1Done.length;
  }

  // phase2_done → trigger Phase 3
  const { data: phase2Done } = await supabase
    .from("leads")
    .select("id, linkup_data, crux_data")
    .eq("project_id", projectId)
    .eq("status", "phase2_done");

  if (phase2Done && phase2Done.length > 0) {
    await tasks.trigger("process-phase3-standardization", {
      projectId,
      leads: phase2Done.map((l) => ({
        id: l.id,
        linkupData: l.linkup_data,
        cruxData: l.crux_data,
      })),
    });
    triggered.phase3 = phase2Done.length;
  }

  // phase3_done → trigger Phase 4
  const { data: phase3Done } = await supabase
    .from("leads")
    .select("id, standardized_data")
    .eq("project_id", projectId)
    .eq("status", "phase3_done");

  if (phase3Done && phase3Done.length > 0) {
    await tasks.trigger("process-phase4-embeddings", {
      projectId,
      leads: phase3Done.map((l) => ({
        id: l.id,
        standardizedData: l.standardized_data,
      })),
    });
    triggered.phase4 = phase3Done.length;
  }

  return NextResponse.json({ triggered });
}
