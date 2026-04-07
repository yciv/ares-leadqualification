import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { tasks } from "@trigger.dev/sdk";

interface LeadInput {
  company_name: string;
  canonical_domain: string;
  source_tag?: string;
}

interface CreateProjectBody {
  name: string;
  description?: string;
  project_type: "seed" | "test" | "live";
  leads: LeadInput[];
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateProjectBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, description, project_type, leads } = body;

  if (!name || !project_type || !Array.isArray(leads) || leads.length === 0) {
    return NextResponse.json(
      { error: "name, project_type, and leads are required" },
      { status: 400 }
    );
  }

  // Action 1: Insert the project and get the generated project_id
  const { data: projectRow, error: projectError } = await supabase
    .from("projects")
    .insert({ name, description, project_type, user_id: user.id })
    .select("id")
    .single();

  if (projectError || !projectRow) {
    return NextResponse.json(
      { error: projectError?.message ?? "Failed to create project" },
      { status: 500 }
    );
  }

  const projectId: string = projectRow.id;

  // Action 2: Bulk insert leads scoped to the project
  const leadsToInsert = leads.map((lead) => ({
    company_name: lead.company_name,
    canonical_domain: lead.canonical_domain,
    source_tag: lead.source_tag ?? null,
    project_id: projectId,
    status: "pending",
  }));

  const { data: insertedLeads, error: leadsError } = await supabase
    .from("leads")
    .insert(leadsToInsert)
    .select("id, company_name, canonical_domain");

  if (leadsError || !insertedLeads) {
    return NextResponse.json(
      { error: leadsError?.message ?? "Failed to insert leads" },
      { status: 500 }
    );
  }

  // Action 3: Trigger Phase 1 enrichment task
  await tasks.trigger("process-phase1-enrichment", {
    projectId,
    leads: insertedLeads.map((lead) => ({
      id: lead.id,
      companyName: lead.company_name,
      canonicalDomain: lead.canonical_domain,
    })),
  });

  return NextResponse.json({ projectId }, { status: 201 });
}
