import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { type StandardizedOutput } from "../schemas/lead";

export async function generateLeadEmbedding(
  standardizedData: StandardizedOutput
): Promise<number[]> {
  const stringifiedData = Object.entries(standardizedData)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");

  const result = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: stringifiedData,
  });

  return result.embedding;
}
