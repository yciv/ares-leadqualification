import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // Test connection by trying to query the leads table
  const { data, error } = await supabase.from("leads").select("id").limit(1);

  if (error) {
    console.error("Cannot query leads table:", error.message);
    console.log("\nPlease run the SQL migrations manually in Supabase SQL Editor:");
    console.log("1. supabase/migrations/20260227120000_init_leads.sql");
    console.log("2. supabase/migrations/20260227130000_add_crux_to_leads.sql");
    console.log("3. supabase/migrations/20260227140000_add_standardized_data.sql");
    console.log("4. supabase/migrations/20260227150000_add_vector_to_leads.sql");
    process.exit(1);
  }

  console.log("leads table exists and is queryable.");
  console.log(`Current rows: ${data.length}`);
}

main();
