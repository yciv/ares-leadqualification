import { task, logger } from "@trigger.dev/sdk/v3";
import { calculateCentroids } from "../lib/clustering/service";

interface CentroidsPayload {
  projectId: string;
}

export const calculateCentroidsTask = task({
  id: "calculate-centroids",
  run: async (payload: CentroidsPayload) => {
    logger.info("Calculating centroids", { projectId: payload.projectId });

    await calculateCentroids(payload.projectId);

    logger.info("Centroids calculated", { projectId: payload.projectId });

    return { success: true };
  },
});
