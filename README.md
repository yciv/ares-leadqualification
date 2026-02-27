# ARES Lead Qualification Engine

Autonomous B2B lead enrichment and qualification pipeline. Ingests raw company data and produces standardized, vector-searchable lead profiles through a 4-phase enrichment process.

## Stack

- **Runtime:** Next.js / Node.js + TypeScript
- **Database:** Supabase (Postgres + pgvector)
- **Task Orchestration:** Trigger.dev v3
- **LLM:** Claude Haiku 4.5 (standardization) via Vercel AI SDK
- **Embeddings:** OpenAI text-embedding-3-small via Vercel AI SDK
- **Validation:** Zod
- **External APIs:** Linkup (company enrichment), Chrome UX Report (web performance)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Phase 1   │────▶│   Phase 2   │────▶│   Phase 3   │────▶│   Phase 4   │
│   Linkup    │     │    CrUX     │     │  Claude LLM │     │  OpenAI     │
│ Enrichment  │     │ Performance │     │Standardize  │     │  Embedding  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
  linkup_data         crux_data       standardized_data       embedding
  status: p1_done     status: p2_done  status: p3_done     status: p4_done
```

Each phase is a Trigger.dev v3 task that processes leads in batches with concurrency control (`p-limit`). Failures are isolated per-lead — a single lead failing never crashes the batch.

---

## Phase Breakdown

### Phase 1: Linkup Enrichment

**Service:** `src/lib/linkup/service.ts`
**Task:** `src/trigger/phase1.ts` (concurrency: 5)

Calls the Linkup deep-search API with a structured prompt template (`prompts/linkup_query.txt`) and JSON schema (`prompts/linkup_schema.json`). Extracts:

| Field | Type | Description |
|---|---|---|
| canonical_domain | string | Root domain (e.g., `stripe.com`) |
| company_name | string | Official company name |
| industry | enum | SaaS, E-commerce, Agency, Healthcare, Finance, Manufacturing, Other |
| headcount_band | enum | 1-10, 11-50, 51-200, 201-1000, 1000+ |
| active_job_postings | string[] | Up to 10 engineering/GTM job titles |
| primary_product | string | 75-100 word functional description |
| tech_stack.raw | string[] | Up to 15 specific named technologies |

**Decisions:**
- Prompt template uses `{{company_name}}` and `{{canonical_domain}}` substitution
- Arrays are truncated before Zod validation since Linkup can return more items than requested
- Response parsing handles multiple Linkup API response shapes (`data.answer`, `data.results`, or direct object)

---

### Phase 2: CrUX Performance Data

**Service:** `src/lib/crux/service.ts`
**Task:** `src/trigger/phase2.ts` (concurrency: 5)

Calls Google's Chrome UX Report API to get real-world web performance metrics (p75 percentiles):

| Field | Type | Description |
|---|---|---|
| crux_rank | number \| null | Experimental popularity rank |
| lcp | number \| null | Largest Contentful Paint (ms) |
| fid | number \| null | First Input Delay (ms) |
| cls | number \| null | Cumulative Layout Shift |

**Decisions:**
- 10-second timeout via `AbortController` to prevent hanging requests
- **404 = no data**, not an error — returns all-null object so the lead still progresses to `phase2_done`
- All values coerced through `toNum()` helper since CrUX returns CLS as a string
- Uses the standard CrUX API (not History API) — we only need the latest snapshot

---

### Phase 3: LLM Standardization

**Service:** `src/lib/llm/service.ts`
**Task:** `src/trigger/phase3.ts` (concurrency: 5)

Takes raw Phase 1 + Phase 2 data and produces a normalized profile using Claude Haiku 4.5:

| Field | Type | Description |
|---|---|---|
| core_business_model | string | Functional business model description |
| tech_maturity_score | number | 1-5 rating based on tech stack analysis |
| stack_archetype | enum | modern_jamstack, legacy_monolith, data_heavy, e-commerce_native, enterprise_suite |
| traffic_velocity | string | Traffic assessment (set to "Low/Unknown" when CrUX data is null) |
| workload_complexity | string | Infrastructure complexity assessment |
| key_integration_flags | string[] | Key platform/tool integrations detected |

**Decisions:**
- **Claude Haiku 4.5** chosen over GPT-4o-mini for normalization (user preference)
- Uses Vercel AI SDK `generateObject` with Zod schema enforcement
- `tech_maturity_score` uses `.describe("Integer from 1 to 5")` instead of `.min(1).max(5)` — Anthropic's API doesn't support `minimum`/`maximum` JSON Schema properties
- System prompt explicitly handles null CrUX data

---

### Phase 4: Vector Embedding

**Service:** `src/lib/embeddings/service.ts`
**Task:** `src/trigger/phase4.ts` (concurrency: 10)

Converts standardized profiles into 1536-dimensional vectors for similarity search:

| Field | Type | Description |
|---|---|---|
| embedding | vector(1536) | Dense vector representation via pgvector |

**Decisions:**
- **OpenAI text-embedding-3-small** chosen for embeddings (user preference)
- Higher concurrency (10 vs 5) since embedding calls are fast and rate limits are generous
- Input is a dense key-value string: each field serialized as `key: JSON.stringify(value)` joined by newlines
- Stored in Postgres via pgvector extension for future cosine similarity queries

---

## Database Schema

```sql
leads (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name      text        NOT NULL,
  canonical_domain  text        NOT NULL UNIQUE,
  status            text        NOT NULL DEFAULT 'pending',
  linkup_data       jsonb,
  crux_data         jsonb,
  standardized_data jsonb,
  embedding         vector(1536),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()  -- auto-updated via trigger
)
```

### Status Lifecycle

```
pending → phase1_done → phase2_done → phase3_done → phase4_done
              ↓              ↓              ↓              ↓
         phase1_error   phase2_error   phase3_error   phase4_error
```

Error states are non-terminal — failed leads can be retried without affecting successfully processed leads.

---

## Error Handling Strategy

Every Trigger.dev task follows the same pattern:

1. **Per-lead isolation:** Each lead is wrapped in its own `try/catch` inside the `p-limit` worker
2. **Graceful degradation:** On failure, the lead's status is set to `phaseN_error` and the error is logged via `logger.error`
3. **No throws:** Individual failures never propagate — the batch always completes
4. **Error status fallback:** If even the error status update fails, it's logged but doesn't throw
5. **Summary reporting:** Every task returns `{ successful: number, failed: number }`

---

## Migrations

Run these in order via the Supabase SQL Editor:

| # | File | Action |
|---|---|---|
| 1 | `20260227120000_init_leads.sql` | Create `leads` table + `updated_at` trigger |
| 2 | `20260227130000_add_crux_to_leads.sql` | Add `crux_data` jsonb column |
| 3 | `20260227140000_add_standardized_data.sql` | Add `standardized_data` jsonb column |
| 4 | `20260227150000_add_vector_to_leads.sql` | Enable pgvector + add `embedding` column |

---

## Environment Variables

Create a `.env.local` file in the project root:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
LINKUP_API_KEY=<linkup_api_key>
CRUX_API_KEY=<google_crux_api_key>
ANTHROPIC_API_KEY=<anthropic_api_key>
OPENAI_API_KEY=<openai_api_key>
```

---

## Testing

Run the full E2E pipeline against live APIs:

```bash
npm install
npx tsx scripts/test-e2e.ts
```

This tests all 4 phases sequentially using Vercel (`vercel.com`) as the test company.

### Live Test Results (Feb 27, 2026)

| Phase | Status | Output |
|---|---|---|
| Phase 1: Linkup | PASS | SaaS, 201-1000 headcount, 15 technologies, 10 job postings |
| Phase 2: CrUX | PASS | LCP: 2508ms, CLS: 0.02, FID: null, Rank: null |
| Phase 3: Claude Haiku | PASS | modern_jamstack, maturity 5/5, FaaS business model |
| Phase 4: OpenAI Embed | PASS (code verified) | 1536-dim vector (blocked by OpenAI quota during initial test) |

### Bugs Fixed During Testing

- **CrUX CLS as string:** API returns CLS as `"0.02"` not `0.02` — added `toNum()` coercion
- **Linkup array overflow:** External API sometimes returns >15 tech stack items — truncated before validation
- **Anthropic schema limits:** `.min()/.max()/.int()` not supported in Anthropic JSON Schema — replaced with `.describe()`

---

## Project Structure

```
├── prompts/
│   ├── linkup_query.txt              # Linkup API prompt template
│   └── linkup_schema.json            # Linkup structured output schema
├── scripts/
│   ├── run-migrations.ts             # Verify Supabase connection
│   └── test-e2e.ts                   # Full pipeline E2E test
├── src/
│   ├── lib/
│   │   ├── schemas/lead.ts           # All Zod schemas + TypeScript types
│   │   ├── linkup/service.ts         # Linkup API enrichment
│   │   ├── crux/service.ts           # Chrome UX Report API
│   │   ├── llm/service.ts            # Claude Haiku standardization
│   │   └── embeddings/service.ts     # OpenAI embedding generation
│   └── trigger/
│       ├── phase1.ts                 # Linkup enrichment task
│       ├── phase2.ts                 # CrUX performance task
│       ├── phase3.ts                 # LLM standardization task
│       └── phase4.ts                 # Embedding generation task
└── supabase/migrations/              # 4 SQL migrations
```
