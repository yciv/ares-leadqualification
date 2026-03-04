import { task, logger } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import { getCruxData } from "../lib/crux/service";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Phase2Payload {
  projectId: string;
  leads: Array<{
    id: string;
    canonicalDomain: string;
  }>;
}

export const processPhase2Crux = task({
  id: "process-phase2-crux",
  run: async (payload: Phase2Payload) => {
    const limit = pLimit(5);
    let successful = 0;
    let failed = 0;

    await Promise.all(
      payload.leads.map((lead) =>
        limit(async () => {
          try {
            const cruxData = await getCruxData(lead.canonicalDomain);

            const { error } = await supabase
              .from("leads")
              .update({
                crux_data: cruxData,
                status: "phase2_done",
              })
              .eq("id", lead.id)
              .eq("project_id", payload.projectId);

            if (error) {
              throw new Error(`Supabase update failed: ${error.message}`);
            }

            successful++;
            logger.info("CrUX enriched lead", {
              id: lead.id,
              domain: lead.canonicalDomain,
            });
          } catch (err) {
            failed++;
            logger.error("Phase2 failed for lead", {
              id: lead.id,
              domain: lead.canonicalDomain,
              error: err instanceof Error ? err.message : String(err),
            });

            await supabase
              .from("leads")
              .update({ status: "phase2_error" })
              .eq("id", lead.id)
              .eq("project_id", payload.projectId)
              .then(({ error: updateErr }) => {
                if (updateErr) {
                  logger.error("Failed to set error status for lead", {
                    id: lead.id,
                    error: updateErr.message,
                  });
                }
              });
          }
        })
      )
    );

    return { successful, failed };
  },
});
