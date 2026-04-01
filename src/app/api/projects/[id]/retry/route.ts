import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Map from phase key (e.g. "phase1") to trigger task ID and payload builder
const PHASE_CONFIG = {
  phase1: {
    taskId: "process-phase1-enrichment",
    buildLeadPayload: (lead: FailedLead) => ({
      id: lead.id,
      companyName: lead.company_name,
      canonicalDomain: lead.canonical_domain,
    }),
  },
  phase2: {
    taskId: "process-phase2-crux",
    buildLeadPayload: (lead: FailedLead) => ({
      id: lead.id,
      canonicalDomain: lead.canonical_domain,
    }),
  },
  phase3: {
    taskId: "process-phase3-standardization",
    buildLeadPayload: (lead: FailedLead) => ({
      id: lead.id,
      linkupData: lead.linkup_data,
      cruxData: lead.crux_data,
    }),
  },
  phase4: {
    taskId: "process-phase4-embeddings",
    buildLeadPayload: (lead: FailedLead) => ({
      id: lead.id,
      standardizedData: lead.standardized_data,
    }),
  },
} as const;

type PhaseKey = keyof typeof PHASE_CONFIG;

interface FailedLead {
  id: string;
  company_name: string;
  canonical_domain: string;
  status: string;
  linkup_data: unknown;
  crux_data: unknown;
  standardized_data: unknown;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  // Fetch all leads in an error state for this project
  const { data: failedLeads, error } = await supabase
    .from("leads")
    .select(
      "id, company_name, canonical_domain, status, linkup_data, crux_data, standardized_data"
    )
    .eq("project_id", projectId)
    .like("status", "%_error");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!failedLeads || failedLeads.length === 0) {
    return NextResponse.json({ message: "No failed leads to retry" });
  }

  // Group leads by phase key (phase1, phase2, phase3, phase4)
  const groups = new Map<PhaseKey, FailedLead[]>();
  for (const lead of failedLeads as FailedLead[]) {
    // status is like "phase1_error" → extract "phase1"
    const phaseKey = lead.status.replace("_error", "") as PhaseKey;
    if (!(phaseKey in PHASE_CONFIG)) continue;
    const group = groups.get(phaseKey) ?? [];
    group.push(lead);
    groups.set(phaseKey, group);
  }

  // Fire a trigger task for each phase group
  const triggerPromises: Promise<unknown>[] = [];
  for (const [phaseKey, leads] of groups) {
    const config = PHASE_CONFIG[phaseKey];
    triggerPromises.push(
      tasks.trigger(config.taskId, {
        projectId,
        leads: leads.map(config.buildLeadPayload as (lead: FailedLead) => Record<string, unknown>),
      })
    );
  }

  await Promise.all(triggerPromises);

  return NextResponse.json({
    message: `Retried ${failedLeads.length} lead${failedLeads.length !== 1 ? "s" : ""}`,
  });
}
