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

export const StandardizedOutputSchema = z.object({
  core_business_model: z.string(),
  tech_maturity_score: z.number().describe("Integer from 1 to 5"),
  stack_archetype: z.enum([
    "modern_jamstack",
    "legacy_monolith",
    "data_heavy",
    "e-commerce_native",
    "enterprise_suite",
  ]),
  traffic_velocity: z.string(),
  workload_complexity: z.string(),
  key_integration_flags: z.array(z.string()),
});

export type StandardizedOutput = z.infer<typeof StandardizedOutputSchema>;

export const EmbeddingSchema = z.array(z.number()).length(1536).nullable();

export type Embedding = z.infer<typeof EmbeddingSchema>;

export const ProjectTypeSchema = z.enum(["seed", "test", "live"]);

export type ProjectType = z.infer<typeof ProjectTypeSchema>;

export const LeadSchema = z.object({
  id: z.string().uuid(),
  company_name: z.string(),
  canonical_domain: z.string(),
  status: z.string(),
  project_id: z.string().uuid().nullable(),
  source_tag: z.string().nullable(),
  fit_score: z.number().nullable(),
  cluster_label: z.string().nullable(),
  routing_flag: z.string().nullable(),
  scored_at: z.string().datetime().nullable(),
  linkup_data: LinkupOutputSchema.nullable(),
  crux_data: CruxOutputSchema.nullable(),
  standardized_data: StandardizedOutputSchema.nullable(),
  embedding: EmbeddingSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type Lead = z.infer<typeof LeadSchema>;
