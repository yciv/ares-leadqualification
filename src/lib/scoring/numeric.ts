import { type StandardizedOutput, type CruxOutput } from "../schemas/lead";

export type NumericFeatures = {
  tech_maturity_score: number | null;
  crux_rank: number | null;
  lcp: number | null;
  fid: number | null;
  cls: number | null;
};

const NUMERIC_KEYS = [
  "tech_maturity_score",
  "crux_rank",
  "lcp",
  "fid",
  "cls",
] as const satisfies ReadonlyArray<keyof NumericFeatures>;

export function extractNumericFeatures(lead: {
  standardized_data: StandardizedOutput | null;
  crux_data: CruxOutput | null;
}): NumericFeatures {
  return {
    tech_maturity_score: lead.standardized_data?.tech_maturity_score ?? null,
    crux_rank: lead.crux_data?.crux_rank ?? null,
    lcp: lead.crux_data?.lcp ?? null,
    fid: lead.crux_data?.fid ?? null,
    cls: lead.crux_data?.cls ?? null,
  };
}

export function computeNumericSimilarity(
  a: NumericFeatures,
  b: NumericFeatures
): number | null {
  const scores: number[] = [];

  // tech_maturity_score: linear, range [1, 5]
  if (a.tech_maturity_score !== null && b.tech_maturity_score !== null) {
    scores.push(
      Math.max(0, 1 - Math.abs(a.tech_maturity_score - b.tech_maturity_score) / 4)
    );
  }

  // crux_rank: log scale, range [1, 10_000_000] — guard against <= 0
  if (
    a.crux_rank !== null &&
    b.crux_rank !== null &&
    a.crux_rank > 0 &&
    b.crux_rank > 0
  ) {
    scores.push(
      Math.max(
        0,
        1 - Math.abs(Math.log10(a.crux_rank) - Math.log10(b.crux_rank)) / 7
      )
    );
  }

  // lcp: linear, range [0, 10_000], lower is better
  if (a.lcp !== null && b.lcp !== null) {
    scores.push(Math.max(0, 1 - Math.abs(a.lcp - b.lcp) / 10000));
  }

  // fid: linear, range [0, 500], lower is better
  if (a.fid !== null && b.fid !== null) {
    scores.push(Math.max(0, 1 - Math.abs(a.fid - b.fid) / 500));
  }

  // cls: linear, range [0, 1], lower is better
  if (a.cls !== null && b.cls !== null) {
    scores.push(Math.max(0, 1 - Math.abs(a.cls - b.cls)));
  }

  if (scores.length === 0) return null;

  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

export function computeCompleteness(features: NumericFeatures): number {
  const nonNull = NUMERIC_KEYS.filter((k) => features[k] !== null).length;
  return nonNull / 5;
}
