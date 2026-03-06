import { task, logger, tasks } from "@trigger.dev/sdk/v3";
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
    const successfulIds: string[] = [];

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
            successfulIds.push(lead.id);
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

    if (successfulIds.length > 0) {
      const { data: leadsData } = await supabase
        .from("leads")
        .select("id, linkup_data, crux_data")
        .in("id", successfulIds);

      if (leadsData && leadsData.length > 0) {
        await tasks.trigger("process-phase3-standardization", {
          projectId: payload.projectId,
          leads: leadsData.map((l) => ({
            id: l.id,
            linkupData: l.linkup_data,
            cruxData: l.crux_data,
          })),
        });
      }
    }

    return { successful, failed };
  },
});
