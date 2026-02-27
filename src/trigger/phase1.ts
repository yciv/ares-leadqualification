import { task, logger } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import { enrichWithLinkup } from "../lib/linkup/service";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Phase1Payload {
  leads: Array<{
    id: string;
    companyName: string;
    canonicalDomain: string;
  }>;
}

export const processPhase1Enrichment = task({
  id: "process-phase1-enrichment",
  run: async (payload: Phase1Payload) => {
    const limit = pLimit(5);
    let successful = 0;
    let failed = 0;

    await Promise.all(
      payload.leads.map((lead) =>
        limit(async () => {
          try {
            const enriched = await enrichWithLinkup(
              lead.companyName,
              lead.canonicalDomain
            );

            const { error } = await supabase
              .from("leads")
              .update({
                linkup_data: enriched,
                status: "phase1_done",
              })
              .eq("id", lead.id);

            if (error) {
              throw new Error(`Supabase update failed: ${error.message}`);
            }

            successful++;
            logger.info(`Enriched lead`, { id: lead.id, domain: lead.canonicalDomain });
          } catch (err) {
            failed++;
            logger.error(`Phase1 failed for lead`, {
              id: lead.id,
              domain: lead.canonicalDomain,
              error: err instanceof Error ? err.message : String(err),
            });

            await supabase
              .from("leads")
              .update({ status: "phase1_error" })
              .eq("id", lead.id)
              .then(({ error: updateErr }) => {
                if (updateErr) {
                  logger.error(`Failed to set error status for lead`, {
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
