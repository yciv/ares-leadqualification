import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import {
  StandardizedOutputSchema,
  type LinkupOutput,
  type CruxOutput,
  type StandardizedOutput,
} from "../schemas/lead";

export async function standardizeProfile(
  linkupData: LinkupOutput,
  cruxData: CruxOutput
): Promise<StandardizedOutput> {
  const result = await generateObject({
    model: anthropic("claude-haiku-4-5-20251001"),
    schema: StandardizedOutputSchema,
    system:
      "You are an expert B2B data analyst. Standardize the provided company data into the strict JSON schema. If CrUX traffic data is missing (null), set traffic_velocity to 'Low/Unknown'. Evaluate technical maturity based on their tech stack. For the nl_summary field, write a concise 2-3 sentence company profile following this pattern: \"{company_name} is a {industry} company focused on {core_business_model}. They operate a {stack_archetype} tech stack with {workload_complexity} workload complexity. Key integrations include {key_integration_flags}.\". Do NOT include any numerical scores or metrics in nl_summary. Focus only on business model, tech stack category, and integration patterns.",
    prompt: JSON.stringify({ linkupData, cruxData }),
  });

  return result.object;
}
