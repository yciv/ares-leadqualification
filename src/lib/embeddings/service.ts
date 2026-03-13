import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { type StandardizedOutput } from "../schemas/lead";

export async function generateLeadEmbedding(
  standardizedData: StandardizedOutput
): Promise<number[]> {
  const result = await embed({
    model: openai.embedding("text-embedding-3-small"),
    value: standardizedData.nl_summary,
  });

  return result.embedding;
}
