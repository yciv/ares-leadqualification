import { z } from "zod";

export const LinkupOutputSchema = z.object({
  canonical_domain: z.string(),
  company_name: z.string(),
  industry: z.enum([
    "SaaS",
    "E-commerce",
    "Agency",
    "Healthcare",
    "Finance",
    "Manufacturing",
    "Other",
  ]),
  headcount_band: z.enum(["1-10", "11-50", "51-200", "201-1000", "1000+"]),
  active_job_postings: z.array(z.string()).max(10),
  primary_product: z.string(),
  tech_stack: z.object({
    raw: z.array(z.string()).max(15),
  }),
});

export type LinkupOutput = z.infer<typeof LinkupOutputSchema>;

export const CruxOutputSchema = z.object({
  crux_rank: z.number().nullable(),
  lcp: z.number().nullable(),
  fid: z.number().nullable(),
  cls: z.number().nullable(),
});

export type CruxOutput = z.infer<typeof CruxOutputSchema>;
