import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { enrichWithLinkup } from "../src/lib/linkup/service";
import { getCruxData } from "../src/lib/crux/service";
import { standardizeProfile } from "../src/lib/llm/service";
import { generateLeadEmbedding } from "../src/lib/embeddings/service";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TEST_COMPANY = "Vercel";
const TEST_DOMAIN = "vercel.com";

async function main() {
  console.log("=== ARES Lead Qualification — E2E Test ===\n");

  // Step 0: Insert test lead
  console.log("Step 0: Inserting test lead...");
  const { data: lead, error: insertErr } = await supabase
    .from("leads")
    .insert({ company_name: TEST_COMPANY, canonical_domain: TEST_DOMAIN })
    .select()
    .single();

  if (insertErr) {
    // If duplicate, fetch existing
    if (insertErr.code === "23505") {
      console.log("  Lead already exists, fetching...");
      const { data: existing } = await supabase
        .from("leads")
        .select()
        .eq("canonical_domain", TEST_DOMAIN)
        .single();
      if (!existing) throw new Error("Could not fetch existing lead");
      console.log(`  Lead ID: ${existing.id}\n`);
      await runPipeline(existing.id);
      return;
    }
    throw new Error(`Insert failed: ${insertErr.message}`);
  }

  console.log(`  Lead ID: ${lead.id}\n`);
  await runPipeline(lead.id);
}

async function runPipeline(leadId: string) {
  // Phase 1: Linkup enrichment
  console.log("Phase 1: Linkup enrichment...");
  try {
    console.log("  Calling Linkup API...");
    const linkupData = await enrichWithLinkup(TEST_COMPANY, TEST_DOMAIN);
    console.log("  Raw response received:", JSON.stringify(linkupData).slice(0, 200));
    console.log("  Industry:", linkupData.industry);
    console.log("  Headcount:", linkupData.headcount_band);
    console.log("  Tech stack:", linkupData.tech_stack?.raw?.join(", ") ?? "none");
    console.log("  Jobs:", linkupData.active_job_postings?.length ?? 0, "postings");

    await supabase
      .from("leads")
      .update({ linkup_data: linkupData, status: "phase1_done" })
      .eq("id", leadId);

    console.log("  DB updated: phase1_done\n");

    // Phase 2: CrUX
    console.log("Phase 2: CrUX performance data...");
    const cruxData = await getCruxData(TEST_DOMAIN);
    console.log("  LCP:", cruxData.lcp);
    console.log("  FID:", cruxData.fid);
    console.log("  CLS:", cruxData.cls);
    console.log("  Rank:", cruxData.crux_rank);

    await supabase
      .from("leads")
      .update({ crux_data: cruxData, status: "phase2_done" })
      .eq("id", leadId);

    console.log("  DB updated: phase2_done\n");

    // Phase 3: LLM standardization
    console.log("Phase 3: LLM standardization (Claude Haiku 4.5)...");
    const standardized = await standardizeProfile(linkupData, cruxData);
    console.log("  Business model:", standardized.core_business_model);
    console.log("  Tech maturity:", standardized.tech_maturity_score, "/ 5");
    console.log("  Stack archetype:", standardized.stack_archetype);
    console.log("  Traffic velocity:", standardized.traffic_velocity);
    console.log("  Integration flags:", standardized.key_integration_flags.join(", "));

    await supabase
      .from("leads")
      .update({ standardized_data: standardized, status: "phase3_done" })
      .eq("id", leadId);

    console.log("  DB updated: phase3_done\n");

    // Phase 4: Embedding
    console.log("Phase 4: Generating embedding (OpenAI text-embedding-3-small)...");
    const embedding = await generateLeadEmbedding(standardized);
    console.log("  Embedding dimensions:", embedding.length);
    console.log("  First 5 values:", embedding.slice(0, 5).map((n) => n.toFixed(6)));

    await supabase
      .from("leads")
      .update({ embedding, status: "phase4_done" })
      .eq("id", leadId);

    console.log("  DB updated: phase4_done\n");

    // Final verification
    console.log("=== Final verification ===");
    const { data: final } = await supabase
      .from("leads")
      .select("id, company_name, canonical_domain, status")
      .eq("id", leadId)
      .single();

    console.log(JSON.stringify(final, null, 2));
    console.log("\nAll 4 phases completed successfully!");
  } catch (err) {
    console.error("\nPipeline failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
