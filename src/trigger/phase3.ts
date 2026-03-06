import { task, logger, tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import { standardizeProfile } from "../lib/llm/service";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Phase3Payload {
  projectId: string;
  leads: Array<{
    id: string;
    linkupData: any;
    cruxData: any;
  }>;
}

export const processPhase3Standardization = task({
  id: "process-phase3-standardization",
  run: async (payload: Phase3Payload) => {
    const limit = pLimit(3);
    let successful = 0;
    let failed = 0;
    const successfulLeads: Array<{ id: string; standardizedData: any }> = [];

    await Promise.all(
      payload.leads.map((lead) =>
        limit(async () => {
          try {
            const standardized = await standardizeProfile(
              lead.linkupData,
              lead.cruxData
            );

            const { error } = await supabase
              .from("leads")
              .update({
                standardized_data: standardized,
                status: "phase3_done",
              })
              .eq("id", lead.id)
              .eq("project_id", payload.projectId);

            if (error) {
              throw new Error(`Supabase update failed: ${error.message}`);
            }

            successful++;
            successfulLeads.push({ id: lead.id, standardizedData: standardized });
            logger.info("Standardized lead", { id: lead.id });
          } catch (err) {
            failed++;
            logger.error("Phase3 failed for lead", {
              id: lead.id,
              error: err instanceof Error ? err.message : String(err),
            });

            await supabase
              .from("leads")
              .update({ status: "phase3_error" })
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
          await new Promise((r) => setTimeout(r, 1500));
        })
      )
    );

    if (successfulLeads.length > 0) {
      await tasks.trigger("process-phase4-embeddings", {
        projectId: payload.projectId,
        leads: successfulLeads,
      });
    }

    return { successful, failed };
  },
});
