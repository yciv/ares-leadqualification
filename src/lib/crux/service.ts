import { CruxOutputSchema, type CruxOutput } from "../schemas/lead";

const CRUX_NULL_RESULT: CruxOutput = {
  crux_rank: null,
  lcp: null,
  fid: null,
  cls: null,
};

export async function getCruxData(
  canonicalDomain: string
): Promise<CruxOutput> {
  const apiKey = process.env.CRUX_API_KEY;
  if (!apiKey) {
    throw new Error("CRUX_API_KEY environment variable is not set");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch(
      `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: `https://${canonicalDomain}` }),
        signal: controller.signal,
      }
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`CrUX API request timed out after 10s for ${canonicalDomain}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    return CRUX_NULL_RESULT;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `CrUX API returned ${response.status} for ${canonicalDomain}: ${body}`
    );
  }

  const data = await response.json();

  const metrics = data?.record?.metrics ?? {};

  const extracted = {
    crux_rank: data?.record?.collectionPeriod?.experimentalPopularity?.rank
      ?? data?.record?.key?.experimentalPopularity?.rank
      ?? null,
    lcp: metrics.largest_contentful_paint?.percentiles?.p75 ?? null,
    fid: metrics.first_input_delay?.percentiles?.p75 ?? null,
    cls: metrics.cumulative_layout_shift?.percentiles?.p75 ?? null,
  };

  const result = CruxOutputSchema.safeParse(extracted);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `CrUX output validation failed for ${canonicalDomain}:\n${issues}\nRaw payload: ${JSON.stringify(extracted).slice(0, 500)}`
    );
  }

  return result.data;
}
