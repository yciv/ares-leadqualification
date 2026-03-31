import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const seedId = "e60da4b1-acd1-4712-ac2c-4bfb55d1c76a";
const testId = "a73a4567-22f0-4dae-98db-9df8711c4cd4";

async function main() {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: projects } = await sb
    .from("projects")
    .select("id, name, project_type")
    .in("id", [seedId, testId]);
  console.log("Projects:", JSON.stringify(projects, null, 2));

  const { count: seedCount } = await sb
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("project_id", seedId)
    .eq("status", "phase4_done");

  const { count: testCount } = await sb
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("project_id", testId)
    .eq("status", "phase4_done");

  console.log(`Seed phase4_done leads: ${seedCount}`);
  console.log(`Test phase4_done leads: ${testCount}`);

  const { data: centroids } = await sb
    .from("centroids")
    .select("id, cluster_label, lead_count")
    .eq("project_id", seedId);
  console.log(`Seed centroids (${centroids?.length ?? 0}):`, JSON.stringify(centroids, null, 2));
}

main().catch(console.error);
