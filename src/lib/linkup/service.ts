import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LinkupOutputSchema, type LinkupOutput } from "../schemas/lead";

export async function enrichWithLinkup(
  companyName: string,
  canonicalDomain: string
): Promise<LinkupOutput> {
  const promptsDir = join(process.cwd(), "prompts");

  const [queryTemplate, schemaContents] = await Promise.all([
    readFile(join(promptsDir, "linkup_query.txt"), "utf-8"),
    readFile(join(promptsDir, "linkup_schema.json"), "utf-8"),
  ]);

  const query = queryTemplate
    .replaceAll("{{company_name}}", companyName)
    .replaceAll("{{canonical_domain}}", canonicalDomain);

  const apiKey = process.env.LINKUP_API_KEY;
  if (!apiKey) {
    throw new Error("LINKUP_API_KEY environment variable is not set");
  }

  const response = await fetch("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      depth: "standard",
      outputType: "structured",
      structuredOutputSchema: schemaContents,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `Linkup API returned ${response.status} for ${canonicalDomain}: ${body}`
    );
  }

  const data = await response.json();

  // Linkup may return structured output in different fields depending on API version
  const rawAnswer = data.answer ?? data.results ?? data;

  let parsed: unknown;
  try {
    parsed = typeof rawAnswer === "string" ? JSON.parse(rawAnswer) : rawAnswer;
  } catch {
    throw new Error(
      `Failed to parse Linkup answer as JSON for ${canonicalDomain}: ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  // Truncate arrays that may exceed schema limits from external API
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.active_job_postings)) {
      p.active_job_postings = p.active_job_postings.slice(0, 10);
    }
    if (p.tech_stack && typeof p.tech_stack === "object") {
      const ts = p.tech_stack as Record<string, unknown>;
      if (Array.isArray(ts.raw)) {
        ts.raw = ts.raw.slice(0, 15);
      }
    }
  }

  const result = LinkupOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Linkup output validation failed for ${canonicalDomain}:\n${issues}\nRaw payload: ${JSON.stringify(parsed).slice(0, 500)}`
    );
  }

  return result.data;
}
