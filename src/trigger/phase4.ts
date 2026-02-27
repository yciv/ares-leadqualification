import { task, logger } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import { generateLeadEmbedding } from "../lib/embeddings/service";
import { type StandardizedOutput } from "../lib/schemas/lead";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Phase4Payload {
  leads: Array<{
    id: string;
    standardizedData: StandardizedOutput;
  }>;
}

export const processPhase4Embeddings = task({
  id: "process-phase4-embeddings",
  run: async (payload: Phase4Payload) => {
    const limit = pLimit(10);
    let successful = 0;
    let failed = 0;

    await Promise.all(
      payload.leads.map((lead) =>
        limit(async () => {
          try {
            const embedding = await generateLeadEmbedding(
              lead.standardizedData
            );

            const { error } = await supabase
              .from("leads")
              .update({
                embedding,
                status: "phase4_done",
              })
              .eq("id", lead.id);

            if (error) {
              throw new Error(`Supabase update failed: ${error.message}`);
            }

            successful++;
            logger.info("Embedded lead", { id: lead.id });
          } catch (err) {
            failed++;
            logger.error("Phase4 failed for lead", {
              id: lead.id,
              error: err instanceof Error ? err.message : String(err),
            });

            await supabase
              .from("leads")
              .update({ status: "phase4_error" })
              .eq("id", lead.id)
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
