# ARES Lead Qualification Engine

Autonomous B2B lead enrichment, clustering, and scoring platform. Ingests raw company data via CSV, runs it through a 4-phase enrichment pipeline, clusters seed batches into ICP archetypes using vector centroids, and scores test batches against those archetypes — producing a routed, reviewable lead table ready for CRM export.

## Stack

- **Runtime:** Next.js 16 App Router / Node.js + TypeScript
- **Database:** Supabase (Postgres + pgvector)
- **Task Orchestration:** Trigger.dev v4
- **LLM (standardization):** Claude Haiku 4.5 via Vercel AI SDK
- **LLM (clustering):** Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) via Vercel AI SDK
- **Embeddings:** OpenAI `text-embedding-3-small` via Vercel AI SDK
- **State Management:** Zustand
- **Validation:** Zod
- **Styling:** Tailwind CSS v4 + shadcn/ui (base-nova style)
- **UI Components:** shadcn/ui (button, card, table, badge, dialog, dropdown-menu, separator, skeleton, avatar)
- **Icons:** lucide-react
- **Font:** Geist (via `geist` npm package + `next/font`)
- **Toasts:** Sonner (dark theme, bottom-right)
- **External APIs:** Linkup (company enrichment), Chrome UX Report (web performance)

---

## System Architecture

```
CSV Upload → Project Created → Leads Inserted
                                     │
              ┌──────────────────────▼──────────────────────┐
              │           4-Phase Enrichment Pipeline         │
              │                                               │
              │  Phase 1      Phase 2      Phase 3      Phase 4
              │  Linkup  ───▶  CrUX   ───▶ Claude  ───▶ OpenAI
              │  Enrich       Perf        Standardize   Embed
              └──────────────────────┬──────────────────────┘
                                     │
              ┌──────────────────────▼──────────────────────┐
              │         Seed Project (ICP Definition)         │
              │                                               │
              │  Claude Sonnet clusters leads into 2-4        │
              │  ICP archetypes → centroid vectors stored     │
              │  in Postgres via avg(embedding) RPC           │
              └──────────────────────┬──────────────────────┘
                                     │
              ┌──────────────────────▼──────────────────────┐
              │         Test / Live Project (Scoring)         │
              │                                               │
              │  Each lead scored against every centroid      │
              │  via cosine similarity → highest match wins   │
              │  → routing flag assigned (AE/SDR/nurture/     │
              │    reject) → reviewable in results UI         │
              └─────────────────────────────────────────────┘
```

---

## Enrichment Pipeline (Phases 1–4)

Each phase is a Trigger.dev v3 task with `p-limit` concurrency. Failures are isolated per-lead — a single failure never crashes the batch. Every task returns `{ successful, failed }`.

### Phase 1: Linkup Enrichment
**Service:** `src/lib/linkup/service.ts` · **Task:** `src/trigger/phase1.ts` (concurrency: 5)

Calls the Linkup deep-search API with a structured prompt + JSON schema. Extracts:

| Field | Type | Description |
|---|---|---|
| canonical_domain | string | Root domain (e.g., `stripe.com`) |
| company_name | string | Official company name |
| industry | enum | SaaS, E-commerce, Agency, Healthcare, Finance, Manufacturing, Other |
| headcount_band | enum | 1-10, 11-50, 51-200, 201-1000, 1000+ |
| active_job_postings | string[] | Up to 10 engineering/GTM job titles |
| primary_product | string | 75-100 word functional description |
| tech_stack.raw | string[] | Up to 15 specific named technologies |

### Phase 2: CrUX Performance Data
**Service:** `src/lib/crux/service.ts` · **Task:** `src/trigger/phase2.ts` (concurrency: 5)

Google Chrome UX Report API — p75 percentile metrics:

| Field | Type | Description |
|---|---|---|
| crux_rank | number \| null | Experimental popularity rank |
| lcp | number \| null | Largest Contentful Paint (ms) |
| fid | number \| null | First Input Delay (ms) |
| cls | number \| null | Cumulative Layout Shift |

404 = no data (not an error) — lead still progresses to `phase2_done` with all-null values.

### Phase 3: LLM Standardization
**Service:** `src/lib/llm/service.ts` · **Task:** `src/trigger/phase3.ts` (concurrency: 3, 1500ms per-lead delay)

Claude Haiku 4.5 normalizes Phase 1 + Phase 2 into a structured profile:

| Field | Type | Description |
|---|---|---|
| core_business_model | string | Functional business model description |
| tech_maturity_score | number | 1–5 rating (uses `.describe()` — Anthropic API doesn't support min/max) |
| stack_archetype | enum | modern_jamstack, legacy_monolith, data_heavy, e-commerce_native, enterprise_suite |
| traffic_velocity | string | Traffic assessment |
| workload_complexity | string | Infrastructure complexity |
| key_integration_flags | string[] | Key platform/tool integrations |
| nl_summary | string | 2–3 sentence natural language company profile — embedded in Phase 4 |

**CIV-13:** Prompt explicitly instructs Haiku to omit missing fields from `nl_summary` rather than filling with "N/A", "unknown", etc. Post-generation filler detection warns via `console.warn` if any bypass is detected (non-breaking).

### Phase 4: Vector Embedding
**Service:** `src/lib/embeddings/service.ts` · **Task:** `src/trigger/phase4.ts` (concurrency: 10)

OpenAI `text-embedding-3-small` — produces 1536-dim vector stored via pgvector.

---

## Clustering (Seed Projects)

**Service:** `src/lib/clustering/service.ts` · **Task:** `src/trigger/centroids.ts`

Triggered after all leads in a **seed** project reach `phase4_done`.

1. Fetches all leads (`status = phase4_done`, `embedding IS NOT NULL`). Sends condensed profiles (`domain + standardized_data`) to **Claude Sonnet 4.5**.
2. Claude identifies **2–4 distinct ICP archetypes** and returns `{ cluster_label, description, canonical_domains[] }`.
3. For each cluster, Postgres computes `avg(embedding)` server-side via the `get_centroid_for_domains` RPC — only the resulting 1536-dim vector travels over the wire.
4. Centroid row upserted into `centroids` table (`UNIQUE(project_id, cluster_label)`).
5. Matching leads updated with `cluster_label`.

**API:** `POST /api/projects/[id]/centroids`

---

## Scoring (Test / Live Projects)

**Service:** `src/lib/scoring/service.ts` · **Task:** `src/trigger/scoring.ts`

Scores a test project's leads against a seed project's centroids.

1. Fetches all centroids for the seed project (including `numeric_features`).
2. For each centroid, calls the `score_leads_against_centroid` RPC — computes `1 - (embedding <=> centroid_vector)` (cosine similarity) for every test lead.
3. Computes **dual-channel composite score** per lead per centroid:
   - `fit_score = 0.7 × text_similarity + 0.3 × numeric_similarity` (when numeric data is available)
   - Falls back to `fit_score = text_similarity` when no numeric overlap exists
   - `numeric_similarity` compares 5 fields: `tech_maturity_score`, `crux_rank`, `lcp`, `fid`, `cls`
4. Aggregates in memory: each lead keeps the **highest `fit_score`** across all centroids.
5. Computes `completeness_score` (0.0–1.0) = fraction of the 5 numeric fields that are non-null. Stored as display-only metadata — does not modify `fit_score`.
6. Applies routing thresholds:

| fit_score | cluster_label | routing_flag |
|---|---|---|
| ≥ 0.55 | matched cluster | `AE` |
| ≥ 0.35 | matched cluster | `SDR` |
| ≥ 0.20 | `fringe` | `nurture` |
| < 0.20 | `no_match` | `reject` |

7. Bulk updates leads: routing metadata grouped by `(routing_flag, cluster_label)` — one query per group. `fit_score`, `text_similarity`, `numeric_similarity`, `completeness_score` updated per-lead in parallel via `Promise.all`.
8. Inserts a record into `scoring_runs` with `seed_project_id`, `test_project_id`, `leads_scored`.

**API:** `POST /api/projects/[id]/score` — body: `{ seedProjectId: string }`

---

## Authentication

Google OAuth via Supabase Auth. Beta-gated via `allowed_emails` table.

**Flow:**
1. Any unauthenticated request → `src/proxy.ts` redirects to `/login?next=<path>`
2. User clicks "Sign in with Google" → `supabase.auth.signInWithOAuth` → Google OAuth
3. Google redirects to `/auth/callback?code=<code>&next=<path>`
4. Callback exchanges code for session, checks `allowed_emails` — if email not found, signs out and redirects to `/login?error=not_authorized`
5. On success, redirects to original `next` path with session cookie set

**Beta access:** Add email to `allowed_emails` table in Supabase SQL Editor:
```sql
INSERT INTO allowed_emails (email) VALUES ('user@example.com');
```

**Client setup:**
- Browser: `createSupabaseBrowserClient()` in `src/lib/supabase/browser.ts` — uses anon key + session cookies via `@supabase/ssr`
- Server/API routes: `createSupabaseServerClient()` in `src/lib/supabase/server.ts` — reads session from request cookies, enforces RLS
- Trigger.dev tasks / clustering / scoring: raw `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` — bypasses RLS by design

---

## Web UI

### Dashboard Shell
All authenticated pages are wrapped in a dashboard shell via the `(dashboard)` route group:
- **Sidebar** (200px fixed): ARES. logo (gold period), nav items (Projects + Settings placeholder), user email + logout
- **Topbar** (48px sticky): page title breadcrumb + user avatar
- **Content area**: fluid width, 24px padding, `--bg-base` background
- **Login page** (`/login`) lives outside the route group — full-screen, no shell

### Design System
- **Design guideline:** `.claude/dashboard-design-guideline.md` — authoritative spec for CIV-40 through CIV-44
- **CSS variables:** Ares design tokens in `:root` (backgrounds, borders, text, gold accent, status colors) + shadcn overrides
- **Tailwind v4 mapping:** `@theme inline` block in `globals.css` maps tokens to utility classes (`bg-bg-surface`, `text-text-primary`, `border-border-default`, `text-accent-gold`, `text-status-success`, etc.)
- **Font:** Geist Sans (variable font, loaded via `geist/font/sans` in root layout, CSS variable `--font-sans`)
- **Components:** shadcn/ui primitives restyled with Ares tokens. Reusable patterns in `src/components/shared/` (EmptyState, PageHeader)

### Projects List (`/projects`)
- Fetches real project data + lead status counts from Supabase (two queries, no N+1)
- Card grid (1/2/3 columns responsive) with project name, type badge, lead count, pipeline status badge, relative date
- Pipeline status derived via `derivePipelineStatus()` from `src/lib/schemas/project.ts`
- Loading skeletons (3 cards) while fetching
- EmptyState with FolderKanban icon when no projects exist
- PageHeader with "New Project" primary action

### New Project (`/projects/new`)
- Form for project name, description, type (seed / test / live)
- CSV upload with PapaParse — validates `company_name`, `canonical_domain` (domain regex, no `https://`)
- Hard cap of 100 rows for seed/test projects
- Preview table with per-row error highlighting
- On submit: inserts project + leads, triggers Phase 1

### Project Detail (`/projects/[id]`)
- Live progress bar + stats row across all pipeline statuses
- Supabase Realtime subscription on `leads` filtered by `project_id` — row updates propagate instantly
- **Continue Pipeline** button — visible when any leads are stuck at `phase1_done`, `phase2_done`, or `phase3_done`; POSTs to `/api/projects/[id]/continue` which detects each group and triggers the correct next phase in one click
- **Retry Failed** button — groups errored leads by phase, re-triggers the correct task per group
- **Calculate Centroids** button — visible only for seed projects when all leads are `phase4_done`

### Results (`/projects/[id]/results`)

**Seed view** (`SeedResultsView`):
- Cluster cards showing dominant `stack_archetype`, dominant `industry`, avg `tech_maturity_score`
- Inline `cluster_label` rename (double-click → input → Enter saves to DB)
- Download JSON for each centroid
- Right panel: lead table filtered by selected cluster

**Test view** (`TestResultsView`):
- Live threshold sliders (AE / SDR / Nurture) — re-routes non-overridden leads client-side via Zustand
- Color-coded routing badges: green (AE), blue (SDR), yellow (nurture), gray (reject)
- Clickable badge dropdown → `overrideRouting()` — marks lead as overridden, persists to DB async
- **Export CSV** button
- **Sync to Attio** button — unlocked after 10 manual reviews (`reviewCount >= 10`)

---

## Database Schema

```sql
-- Core lead record
leads (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name      text        NOT NULL,
  canonical_domain  text        NOT NULL UNIQUE,
  status            text        NOT NULL DEFAULT 'pending',
  project_id        uuid        REFERENCES projects(id) ON DELETE CASCADE,
  source_tag        text,
  fit_score         float,
  text_similarity   float,
  numeric_similarity float,
  completeness_score float,      -- fraction of 5 numeric fields non-null; display metadata only
  cluster_label     text,
  routing_flag      text,
  scored_at         timestamptz,
  linkup_data       jsonb,
  crux_data         jsonb,
  standardized_data jsonb,
  embedding         vector(1536),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
)

-- Project container
projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text,
  description  text,
  project_type project_type_enum,   -- 'seed' | 'test' | 'live'
  user_id      uuid REFERENCES auth.users(id),
  created_at   timestamptz DEFAULT now()
)

-- ICP cluster centroids
centroids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  cluster_label   text,
  centroid_vector vector(1536),
  lead_count      int,
  avg_fit_score   float,
  notes           text,
  created_at      timestamptz DEFAULT now(),
  UNIQUE(project_id, cluster_label)
)

-- Scoring run audit log
scoring_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_project_id  uuid REFERENCES projects(id),
  test_project_id  uuid REFERENCES projects(id),
  run_at           timestamptz DEFAULT now(),
  leads_scored     int,
  notes            text
)
```

### Lead Status Lifecycle

```
pending → phase1_done → phase2_done → phase3_done → phase4_done
              ↓              ↓              ↓              ↓
         phase1_error   phase2_error   phase3_error   phase4_error
```

Error states are non-terminal — failed leads can be retried without re-processing successful ones.

---

## Postgres RPCs

| Function | Purpose |
|---|---|
| `get_centroid_for_domains(p_project_id, p_domains[])` | Returns `avg(embedding)` for a set of domains — centroid computation runs fully in Postgres |
| `score_leads_against_centroid(p_test_project_id, p_centroid_id, p_centroid_vector)` | Returns `(lead_id, similarity)` rows using `1 - (embedding <=> centroid_vector)` |

---

## Migrations

Run in order via the Supabase SQL Editor:

| # | File | Action |
|---|---|---|
| 1 | `20260227120000_init_leads.sql` | Create `leads` table + `updated_at` trigger |
| 2 | `20260227130000_add_crux_to_leads.sql` | Add `crux_data` jsonb column |
| 3 | `20260227140000_add_standardized_data.sql` | Add `standardized_data` jsonb column |
| 4 | `20260227150000_add_vector_to_leads.sql` | Enable pgvector + add `embedding` column |
| 5 | `20260304000000_add_projects_and_clustering.sql` | Add `projects`, `centroids`, `scoring_runs` tables; add project/scoring columns to `leads`; enable Realtime |
| 6 | `20260304000100_add_centroid_rpc.sql` | `get_centroid_for_domains` function |
| 7 | `20260304000200_add_scoring_rpc.sql` | `score_leads_against_centroid` function |
| 8 | `20260313000000_add_numeric_features_to_leads.sql` | Add `numeric_features` jsonb to `centroids`; add `text_similarity`, `numeric_similarity` to `leads` |
| 9 | `20260313000100_add_scoring_columns.sql` | Add `completeness_score` float to `leads` |
| 10 | `20260313000200_add_clustering_metadata.sql` | Add clustering metadata columns |
| 11 | `20260313000300_add_allowed_emails.sql` | Beta email whitelist table + seed user |
| 12 | `20260313000400_add_user_ownership_and_rls.sql` | Add `user_id` to `projects`; enable RLS on all 5 tables; 13 policies |

---

## Environment Variables

```env
# Server-side (Trigger.dev tasks — bypasses RLS)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
LINKUP_API_KEY=<linkup_api_key>
CRUX_API_KEY=<google_crux_api_key>
ANTHROPIC_API_KEY=<anthropic_api_key>
OPENAI_API_KEY=<openai_api_key>

# Client-side (browser Supabase client + Realtime)
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key>

# Trigger.dev worker authentication
TRIGGER_SECRET_KEY=<tr_dev_... or tr_prod_...>
```

`TRIGGER_SECRET_KEY` uses `tr_dev_` prefix for local dev, `tr_prod_` for production deployment. Set production keys in the Vercel and Trigger.dev dashboards — never in `.env.local`.

---

## Development

```bash
npm install
npm run dev              # Next.js dev server (http://localhost:3000)
npm run dev:trigger      # Trigger.dev local worker (run alongside dev)
npm run deploy:trigger   # Deploy worker to Trigger.dev cloud (prod key required)
npx tsx scripts/test-e2e.ts   # Full pipeline E2E test (live APIs)
```

> Both `npm run dev` and `npm run dev:trigger` must be running simultaneously for the pipeline to execute locally. The Trigger.dev CLI is `trigger.dev` (note the dot) — not `trigger`.

---

## Project Structure

```
├── prompts/
│   ├── linkup_query.txt                       # Linkup API prompt template
│   └── linkup_schema.json                     # Linkup structured output schema
├── scripts/
│   ├── run-migrations.ts                      # Verify Supabase connection
│   └── test-e2e.ts                            # Full pipeline E2E test
├── src/
│   ├── proxy.ts                               # Auth gate — redirects unauthenticated requests to /login
│   ├── app/
│   │   ├── api/
│   │   │   └── projects/
│   │   │       ├── route.ts                   # POST /api/projects (create + trigger phase1)
│   │   │       └── [id]/
│   │   │           ├── retry/route.ts         # POST /api/projects/:id/retry
│   │   │           ├── continue/route.ts      # POST /api/projects/:id/continue
│   │   │           ├── centroids/route.ts     # POST /api/projects/:id/centroids
│   │   │           └── score/route.ts         # POST /api/projects/:id/score
│   │   ├── auth/
│   │   │   └── callback/route.ts              # OAuth code exchange + beta gate
│   │   ├── login/
│   │   │   └── page.tsx                       # Google OAuth login page (outside dashboard group)
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx                     # Server layout — session fetch + Shell wrapper
│   │   │   ├── page.tsx                       # Root redirect → /projects
│   │   │   └── projects/
│   │   │       ├── page.tsx                   # Projects list (real data, card grid)
│   │   │       ├── new/page.tsx               # CSV upload + project creation form
│   │   │       └── [id]/
│   │   │           ├── page.tsx               # Project detail + pipeline monitor
│   │   │           └── results/page.tsx       # Seed/test results router
│   │   ├── layout.tsx                         # Root layout (Geist font + Sonner toaster)
│   │   └── globals.css                        # Design tokens + Tailwind v4 @theme
│   ├── components/
│   │   ├── layout/
│   │   │   ├── shell.tsx                      # Sidebar + topbar + content wrapper
│   │   │   ├── sidebar.tsx                    # Fixed 200px sidebar with nav + user
│   │   │   └── topbar.tsx                     # Sticky topbar with breadcrumb + avatar
│   │   ├── projects/
│   │   │   └── project-card.tsx               # Project card (status badge, type, lead count)
│   │   ├── shared/
│   │   │   ├── empty-state.tsx                # Reusable empty state pattern
│   │   │   └── page-header.tsx                # Title + description + action slot
│   │   ├── ui/                                # shadcn/ui primitives (auto-generated)
│   │   └── results/
│   │       ├── SeedResultsView.tsx            # Cluster cards + lead table
│   │       └── TestResultsView.tsx            # Threshold sliders + scored table
│   ├── lib/
│   │   ├── schemas/
│   │   │   ├── lead.ts                        # Lead Zod schemas + TypeScript types
│   │   │   └── project.ts                     # Project types, PipelineStatus, derivePipelineStatus()
│   │   ├── supabase/
│   │   │   ├── browser.ts                     # createSupabaseBrowserClient() — anon key + SSR cookies
│   │   │   └── server.ts                      # createSupabaseServerClient() — session from request cookies
│   │   ├── store/resultsStore.ts              # Zustand store (leads, thresholds, overrides)
│   │   ├── clustering/service.ts              # Claude Sonnet clustering + centroid upsert
│   │   ├── scoring/service.ts                 # Cosine similarity scoring + routing
│   │   ├── linkup/service.ts                  # Linkup API enrichment
│   │   ├── crux/service.ts                    # Chrome UX Report API
│   │   ├── llm/service.ts                     # Claude Haiku standardization
│   │   └── embeddings/service.ts              # OpenAI embedding generation
│   └── trigger/
│       ├── phase1.ts                          # Linkup enrichment task
│       ├── phase2.ts                          # CrUX performance task
│       ├── phase3.ts                          # LLM standardization task
│       ├── phase4.ts                          # Embedding generation task
│       ├── centroids.ts                       # Centroid calculation task
│       └── scoring.ts                         # Lead scoring task
└── supabase/migrations/                       # 12 SQL migrations
```

---

## Live Test Results (Feb 27, 2026)

| Phase | Status | Output |
|---|---|---|
| Phase 1: Linkup | PASS | SaaS, 201-1000 headcount, 15 technologies, 10 job postings |
| Phase 2: CrUX | PASS | LCP: 2508ms, CLS: 0.02, FID: null, Rank: null |
| Phase 3: Claude Haiku | PASS | modern_jamstack, maturity 5/5, FaaS business model |
| Phase 4: OpenAI Embed | PASS (code verified) | 1536-dim vector (blocked by OpenAI quota during initial test) |

### Known Gotchas

| Issue | Fix |
|---|---|
| CrUX returns CLS as string `"0.02"` | `toNum()` coercion helper |
| Linkup returns >15 tech stack items | Arrays truncated before Zod validation |
| Linkup returns non-standard `headcount_band` values (e.g. `"1000-5000"`) | `normalizeHeadcountBand()` coercion in `src/lib/linkup/service.ts` — maps first integer to correct bucket before Zod validation |
| Anthropic API rejects `.min()`/`.max()` in JSON Schema | Use `.describe("Integer from 1 to 5")` instead |
| Anthropic rate limit: 50 req/min hit during large Phase 3 batches | Phase 3 concurrency reduced to 3 + 1500ms per-lead delay (~40 req/min effective) |
| Trigger.dev `trigger.config.ts` `maxDuration` is required in v4 | Set to `300` seconds (5 min ceiling for worst-case Phase 1 batches) |
| Pipeline stops after Phase 1 if chaining not wired | Phases now auto-chain on success: 1→2→3→4. Use **Continue Pipeline** button to unstick leads at any intermediate `_done` status |
| Supabase JS has no native bulk-update-with-different-values | Grouped by routing outcome for metadata; per-lead parallel updates for `fit_score` |

---

## Changelog

### 2026-03-06 — Deployment Hardening + Pipeline Fixes

**Deployment blockers resolved:**
- Created `trigger.config.ts` with `project`, `runtime: "node"`, `logLevel`, `dirs`, `maxDuration: 300`
- Added `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `TRIGGER_SECRET_KEY` to `.env.local`
- Added `npm run dev:trigger` and `npm run deploy:trigger` scripts to `package.json` (CLI binary is `trigger.dev`, not `trigger`)
- Created `.env.example` with all 9 variable names

**Bug fixes:**
- `src/lib/linkup/service.ts` — added `normalizeHeadcountBand()` to coerce Linkup's non-standard headcount values (e.g. `"1000-5000"`, `"101-200"`) to valid Zod enum values before validation
- `src/trigger/phase3.ts` — reduced concurrency from 5 → 3, added 1500ms per-lead delay to stay under Anthropic's 50 req/min rate limit

**Pipeline chaining:**
- `phase1.ts` → `phase2.ts` → `phase3.ts` → `phase4.ts` now auto-chain on the happy path; each phase triggers the next with successful leads only
- Phase 2→3 transition fetches `linkup_data` + `crux_data` from DB at batch-end (not available in phase 2 payload)

**Continue Pipeline feature:**
- `src/app/api/projects/[id]/continue/route.ts` — POST endpoint that queries leads by status (`phase1_done`, `phase2_done`, `phase3_done`) and triggers the correct next phase per group
- `src/app/projects/[id]/page.tsx` — "Continue Pipeline (N)" button, visible when `stuckCount > 0`; shows per-phase push count on completion

---

### 2026-03-07 — Scoring UI, Safety Guards & Realtime Results

**Scoring trigger UI:**
- `src/app/projects/[id]/page.tsx` — "Score Project" seed-ID input + button, visible for test/live projects when all leads are `phase4_done`; POSTs to `/api/projects/[id]/score` then navigates to results
- `src/app/projects/[id]/page.tsx` — "View Results →" link, visible when any lead has a non-null `fit_score`

**API safety guards:**
- `src/app/api/projects/[id]/centroids/route.ts` — fetches project before queuing; returns 400 if `project_type !== "seed"`
- `src/app/api/projects/[id]/score/route.ts` — validates test project is not a seed; validates seed project has at least one centroid before queuing

**Scoring service — non-embedded lead handling:**
- `src/lib/scoring/service.ts` — after scoring completes, queries `phase4_done` leads with null `fit_score` (no embedding, skipped by RPC) and bulk-sets `routing_flag = "unscored"`, `cluster_label = "No embedding"`

**Realtime results page:**
- `src/app/projects/[id]/results/page.tsx` — Supabase Realtime subscription on `leads` filtered by `project_id`; merges incoming updates into the store via `updateLead` without replacing all leads or re-running threshold logic
- `src/lib/store/resultsStore.ts` — added `updateLead(leadId, updates)` action for partial, per-lead store updates
- `src/components/results/TestResultsView.tsx` — animated "Scoring in progress" banner, visible while any `phase4_done` lead has a null `fit_score`; disappears automatically as Realtime updates arrive

---

### 2026-04-08 — CIV-7 + CIV-39: Auth + RLS

**Authentication (Google OAuth):**
- `@supabase/ssr` installed — replaces raw `@supabase/supabase-js` in browser/server client utilities
- `src/proxy.ts` — Next.js 16 auth gate (replaces deprecated `middleware.ts`); redirects all unauthenticated requests to `/login?next=<path>`
- `src/app/login/page.tsx` — Google OAuth sign-in page; dark Ares branding; handles `not_authorized` and `auth_failed` error states
- `src/app/auth/callback/route.ts` — exchanges OAuth code for session; beta gate checks `allowed_emails` table; signs out unauthorized users
- `src/lib/supabase/browser.ts` — updated to `createSupabaseBrowserClient()` via `@supabase/ssr`
- `src/lib/supabase/server.ts` — new `createSupabaseServerClient()` reads session from request cookies

**API route auth guards:**
- All 5 API routes (`/api/projects` + 4 `[id]` sub-routes) now call `supabase.auth.getUser()` at handler entry — return 401 if not authenticated
- `POST /api/projects` enforces `user_id: user.id` on project insert — RLS INSERT policy enforces this too
- Trigger.dev task dispatch (`tasks.trigger()`) unaffected — uses `TRIGGER_SECRET_KEY` independently

**RLS + ownership (2 migrations):**
- `20260313000300_add_allowed_emails.sql` — `allowed_emails` table, seeded with bootstrap user
- `20260313000400_add_user_ownership_and_rls.sql` — `user_id uuid` added to `projects`; RLS enabled on `projects`, `leads`, `centroids`, `scoring_runs`, `allowed_emails`; 13 policies total
- Trigger.dev tasks / clustering / scoring use `SUPABASE_SERVICE_ROLE_KEY` — automatically bypasses RLS, no changes needed

**Backfill required after first sign-in:**
```sql
SELECT id FROM auth.users WHERE email = 'yigitcivilo@gmail.com';
UPDATE projects SET user_id = '<uuid>' WHERE user_id IS NULL;
```

---

### 2026-04-07 — CIV-13: Completeness-Aware Scoring

**nl_summary filler fix (`src/lib/llm/service.ts`):**
- System prompt updated to instruct Haiku to omit missing fields from `nl_summary` rather than inject "N/A", "unknown", etc. into the semantic embedding channel
- Added optional `domain` parameter to `standardizeProfile()` for contextual warn logging
- Post-generation filler detection: regex `/\b(N\/A|unknown|not available|no data|unavailable|unspecified|undetermined)\b/i` — logs `[CIV-13]` warning on match, does not throw

**Completeness as display metadata (`src/lib/scoring/service.ts`):**
- `completeness_score` (0.0–1.0 = fraction of 5 numeric fields non-null) computed and written to `leads` table on every scoring run
- Intentionally not applied as a scoring multiplier — leads missing CrUX data are already penalized by falling back to text-only scoring (losing the 30% numeric channel); a second multiplicative penalty would double-punish a data collection artifact
- Scoring log now emits `[Scoring] <lead_id> score: 0.6800 (completeness: 0.40)` for observability

---

### 2026-04-11 — CIV-40: Dashboard Shell Foundation

**Design system + shell:**
- shadcn/ui initialized (base-nova style, Tailwind v4). Components: button, card, table, badge, dialog, dropdown-menu, separator, skeleton, avatar
- Ares design tokens in `globals.css` `:root` — backgrounds (4), borders (3), text (4), accent/gold (4), status (5) + Tailwind v4 `@theme inline` mappings
- Geist font via `geist` npm package, Sonner toasts (dark theme, bottom-right)
- Shell components: Sidebar (200px fixed, nav, user/logout), Topbar (48px sticky, breadcrumb + avatar), Shell wrapper
- Reusable patterns: EmptyState, PageHeader in `src/components/shared/`

**Route group migration:**
- `src/app/(dashboard)/` route group wraps all authenticated pages in Shell
- Pages moved from `src/app/projects/` → `src/app/(dashboard)/projects/` — URLs unchanged
- Root `/` redirects to `/projects`; login page remains outside group (no shell)

---

### 2026-04-12 — CIV-41: Projects List + Design Token Migration

**Projects list with real data:**
- `src/lib/schemas/project.ts` — shared types: Project, ProjectWithStats, PipelineStatus, derivePipelineStatus()
- `src/components/projects/project-card.tsx` — card component with pipeline status badge, type badge, lead count, relative date
- `src/app/(dashboard)/projects/page.tsx` — fetches projects + lead statuses (two queries, no N+1), card grid (1/2/3 cols responsive), loading skeletons, empty state

**Design token migration (cosmetic only):**
- All 5 dashboard pages + 2 result view components restyled with Ares design tokens
- Replaced `bg-gray-*`, `border-gray-*`, `text-gray-*`, `bg-indigo-*`, `bg-emerald-*` with `bg-bg-*`, `border-border-*`, `text-text-*`, `bg-accent-gold`, `bg-status-*`
- Zero logic, state, or structure changes — purely cosmetic class swap
