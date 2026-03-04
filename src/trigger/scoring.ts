import { task, logger } from "@trigger.dev/sdk/v3";
import { scoreLeadsAgainstCentroids } from "../lib/scoring/service";

interface ScoringPayload {
  testProjectId: string;
  seedProjectId: string;
}

export const scoreLeadsTask = task({
  id: "score-leads",
  run: async (payload: ScoringPayload) => {
    logger.info("Scoring leads", {
      testProjectId: payload.testProjectId,
      seedProjectId: payload.seedProjectId,
    });

    await scoreLeadsAgainstCentroids(payload.testProjectId, payload.seedProjectId);

    logger.info("Scoring complete", {
      testProjectId: payload.testProjectId,
      seedProjectId: payload.seedProjectId,
    });

    return { success: true };
  },
});
