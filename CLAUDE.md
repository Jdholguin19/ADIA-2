# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ADIA: upload an XLSX/CSV, get an executive dashboard (KPIs + alerts) and an AI
copilot that answers questions about the data. React 18 + Vite 6 + Tailwind 4 (PWA)
talking **directly** to Supabase. No custom backend — business logic lives in plpgsql,
security in RLS. UI text and SQL comments are in Spanish; keep it that way.

## Commands

```bash
npm run dev              # app + /api/chat inside the Vite dev server
npm run build            # tsc -b && vite build
npm run typecheck        # tsc -b --noEmit
npm run migrate          # apply supabase/migrations/*.sql (ledger: public.schema_migrations)
npm run migrate:status   # list applied/pending
npm run db:query -- "select 1"
npm run load -- file.xlsx   # full ingest through the same path the browser uses
npm run kb               # seed glossary + question→SQL exemplars, generate embeddings
npm run verify           # build + check:secrets + test:sandbox
```

### Tests

There is no unit-test framework. Verification is three end-to-end scripts that run
against the **real** Supabase project:

```bash
npm run test:sandbox     # 27 assertions: 12 SQL attacks, grain guard, real figures, RLS
npm run test:chat        # login → /api/chat → SSE, the three canonical questions
npm run test:routes      # 12 assertions: tab links resolve correctly (no browser needed)
npm run check:secrets    # fails if any secret reached dist/
```

Run a subset by passing args: `node scripts/test-sandbox.mjs <dataset_id>` and
`node scripts/test-chat.mjs <dataset_id> "your question"`. `test:chat` needs
`npm run dev` running.

## The one idea the whole design turns on

This is **not RAG over rows**. It is a text-to-SQL agent with a retrieval-augmented
prompt. Vectors index *meaning* (real column values, glossary, past questions);
every **number** comes from SQL executed at answer time. Retrieving 8 chunks out of
93k rows cannot count 4,000 people — it produces a confident wrong number.

The sample dataset is a **monthly panel** (one row per person per month), which makes
"how many workers?" have three plausible answers: `count(*)` → 93,484 (row-months),
`count(distinct names)` → 5,647 (everyone ever), and `count(distinct names)` **with a
period filter** → 3,978 (correct). `app.detect_grain` produces a `counting_rule`
string that is threaded into **three** places at once — the LLM system prompt
(`public.dataset_context`), the SQL linter (`app.lint_sql` rejects `count(*)` without
a period filter and explains why), and the dashboard UI. Changing any of these
without the others reintroduces the bug.

## Data pipeline

`public.rebuild_dataset(id)` orchestrates, in this order — the order matters:

```
validate_types → build_silver → profile_dataset → detect_grain
→ detect_derived_columns → build_value_dictionary → build_dashboard → run_alerts
```

`profile_dataset` **resets** roles and `derived_rule`, so `detect_derived_columns`
must run after it. Running them out of order silently yields fewer derived rules.

- **Bronze** `public.dataset_rows` — jsonb, list-partitioned per dataset, immutable.
- **Silver** `ds.t_<padded id>` — real typed table, RLS-enabled, the only relation
  the LLM ever names. `ds.t_<id>_q` holds quarantined rows.

Casting happens **once at load**, never on read. A view casting jsonb would blow up
on a single bad cell (`'222,91  c) Rem'`) for *every* query touching that column,
because Postgres gives no evaluation-order guarantee between `WHERE` and the
`SELECT` list.

A row with **one** bad cell is kept, that cell nulled, the failure recorded in
`_issues`. Only structurally corrupt rows (≥ 2 bad cells, `p_max_bad_cells`) are
quarantined. This is deliberate: whole-row quarantine deleted 5 real employees from
the November headcount.

`app.validate_types` is the safety net for the client's sample-based type guess: it
scans **all** bronze rows and widens types (bigint→numeric→text). A bigint column
with *any* fractional value always widens — that's a narrow type, not a bad row.

## SQL sandbox

`public.exec_analysis_sql` is **SECURITY INVOKER** on purpose.

> PostgreSQL forbids `SET ROLE`/`RESET ROLE` inside a `SECURITY DEFINER` function
> (`role` carries `GUC_NOT_WHILE_SEC_REST`): `42501 cannot set parameter "role"
> within security-definer function`. Verified against this Postgres 17.6. Any
> "drop privileges to a restricted role" sandbox design **cannot work**. See
> `0011_invoker_sandbox.sql`.

Layers: authz → rate limit → `app.lint_sql` (grammar, relation/function allowlist,
grain guard) → `app.bind_params` (values become quoted literals) → forced `LIMIT` →
`EXPLAIN (FORMAT JSON)` + `app.assert_plan_safe` (validates the **plan**, not the
text — a regex can be fooled, a plan cannot lie about what it reads) → execute →
audit. Errors are **returned, not raised**, so the model can read them and repair on
the next tool iteration; that repair loop is where most accuracy comes from.

RLS is the actual security boundary. Every policy on `ds.*` and the child tables is
declared `to authenticated, adia_sql` — keep that convention if you add tables.

## Chat handler

`src/server/chat/handler.ts` is platform-agnostic (pure Web APIs, no deps) with four
adapters:

| Adapter | Where |
|---|---|
| `vite-chat-plugin.ts` | local dev, `/api/chat` (key stays in the node process) |
| `supabase/functions/chat/index.ts` | Supabase Edge Function (Deno) |
| `functions/api/chat.ts` | Cloudflare **Pages** Function — dead code on this project's actual deploy, kept in case it ever moves back to classic Pages |
| `src/server/chat/worker.ts` | Cloudflare **Workers** `main` entry — this is the one that actually runs in production |

**`wrangler.jsonc` (`main` + `assets`) is committed on purpose.** This project's
Cloudflare dashboard build runs `wrangler deploy` (Workers), not `wrangler pages
deploy` (classic Pages) — the dashboard's "Vite" framework preset defaults new
projects to the Workers-with-assets model. Without a committed `wrangler.jsonc`,
Cloudflare auto-generates an *assets-only* one on every build (no `main`), so
`functions/api/chat.ts` — the Pages Functions convention — never runs: any request
to `/api/chat` falls through to the assets binding and gets treated as an SPA
route. `worker.ts` is the fix: it intercepts `/api/chat` before delegating
everything else to `env.ASSETS.fetch()`. The Worker env needs `OPENAI_API_KEY`
(secret) **and** `SUPABASE_URL` / `SUPABASE_ANON_KEY` (plain vars, same values as
their `VITE_`-prefixed counterparts, just not embedded in the bundle) — set all
three in the dashboard under Settings → Variables and Secrets, or a build with only
`OPENAI_API_KEY` set will 500 on every message.

**The Deno adapter imports `supabase/functions/_shared/handler.ts`, which is a copy.**
After editing the handler, run
`cp src/server/chat/handler.ts supabase/functions/_shared/handler.ts`. `worker.ts`
and `functions/api/chat.ts` import `handler.ts` directly, so they never drift.

`openai()` self-heals: on `Unsupported value: '<param>'` it strips that param and
retries, instead of a per-model capability table that rots (gpt-5.5 only accepts
`temperature: 1`; gpt-5.4-mini accepts 0).

### Semantic cache — do not weaken the literal gate

Cosine alone makes the cache a wrong-number generator: *"¿cuántos conserjes tengo?"*
and *"¿cuántos conserjes tenía en marzo de 2016?"* sit at ~0.94. At threshold 0.93
that's a hit, the SQL re-executes, and you get a correct figure for the **wrong
period** that nobody notices. Re-executing protects against stale *data*, not stale
*parameters*.

So `extractLiterals()` pulls years, months, amounts, quoted strings and comparison
operators, and a hit additionally requires an **exact literal-set match**. Cache
entries store them in `param_schema.literals`. Verified: repeat hits in 0.8 s vs
4.1 s; the March variant correctly misses and returns 82 instead of 78.

The cache is written from **both** exits of the tool loop (early return when the
model answers, and loop exhaustion). Only writing the second one leaves it empty —
that was a real bug.

## Routing

`/d/:id` is a **layout route** (`DatasetShell` renders `<Outlet />`), with the five
tabs as children. That nesting is load-bearing, not cosmetic.

React Router resolves a relative `to` against **the route the link is rendered in**.
When the routes were flat (`/d/:id/chat` as its own top-level route) and the shell was
rendered *inside* each leaf element, a tab link `to="alertas"` clicked from
`/d/1/chat` resolved to `/d/1/chat/alertas`, matched nothing, fell through to
`path="*"` and bounced the user to the dataset list. Clicking the active tab twice did
the same (`/d/1/chat/chat`). As a layout route, the shell renders in the `/d/:id`
context, so its relative links resolve against `/d/:id` from any tab.

Tab definitions live in `src/nav.ts` — a dependency-free module so
`scripts/test-routes.mjs` imports the *same* values the app uses instead of a copy
that can drift. That test SSRs the real `NavLink`s in a `MemoryRouter` and asserts the
hrefs from every tab; its last assertion rebuilds the **old** flat structure and
requires it to fail, so the test can't silently stop catching the regression.

Relative links elsewhere are fragile — `..` from an *index* route is subtly
version-dependent. Cross-links inside a page (e.g. dashboard → alerts) use an absolute
path built from `id`.

## Normalized values (encoding drift)

`build_silver` creates a `<col>_norm` column beside every category column, seeded with
the raw value. `dataset_value_map` holds confirmed equivalences; `app.apply_value_map`
fills `_norm` from it, always recomputing **from the raw column** so reapplying is
idempotent and a bad mapping can be corrected.

The raw column is never modified — that's what keeps the file auditable.

`app.norm_col(dataset_id, col)` returns the physical column to use. `dashboard_slice`,
`build_value_dictionary` and `dataset_context` all route through it, so the dashboard,
the filter dropdowns and the LLM see canonical labels while the API still speaks in
logical column names.

For the sample dataset the user confirmed `1=LOSEP, 2=CT, 3=LOEI`; code `4` is labelled
as unlabelled-at-source rather than guessed. Apply a mapping with:

```bash
npm run map -- 1 labor_regime '{"1":"LOSEP","2":"CT","3":"LOEI"}'
```

`dataset_context` lists the `_norm` columns and their confirmed equivalences, which is
why the model writes `labor_regime_norm = 'LOSEP'` instead of splitting the series at
the 2015-06 boundary. If you add a normalization path, update that context too.

## Dashboard filters and the chat

`public.dashboard_slice(dataset_id, period, filters, search)` recomputes every KPI live
with the **same definitions** as the precomputed `build_dashboard`, so there is only one
set of arithmetic. Column names arriving from the browser are validated against
`dataset_columns` before interpolation.

`width_bucket` raises `2201G` when its bounds are equal, which happens whenever a filter
narrows to a single value — the histogram checks the bounds first and degrades to one
bucket.

Dashboard filters live in a Zustand store (`src/lib/filters.ts`) and are sent with every
chat message. **They are part of `dashboardLiterals()` and therefore of the cache gate**:
without that, "¿cuántos hay?" under a CONSERJE filter and the same question unfiltered
share a cache entry and the second gets the first one's number. Same failure class as
the month literal.

## Shared inference module

`src/lib/ingest/infer.js` is plain **JavaScript** on purpose: it is imported by both
the browser Web Worker and the node scripts. Duplicating this logic is the easiest
way to make client and server disagree about types. Types live in the hand-written
`infer.d.ts` beside it — update both together.

## Migrations

Append-only, numbered, applied in filename order, tracked in `public.schema_migrations`.
Each file runs in one transaction. Never edit an applied migration — add a new one
that `create or replace`s the function. The numbered sequence reads as a repair log;
headers explain *why* each fix exists.

**Adding a defaulted parameter to an existing plpgsql function creates an overload,
it does not replace it.** Calls then fail with `42725 ... is not unique`. Drop the
old signature explicitly (see `0014_drop_overload.sql`).

## Postgres gotchas that cost real time here

- `text[] || 'literal'` is **ambiguous** (`anyarray||anyelement` vs
  `anyarray||anyarray`) and resolves to the array form, throwing `22P02 malformed
  array literal`. Always `|| 'x'::text`.
- `round(double precision, integer)` **does not exist**. `percentile_cont` returns
  float8 → cast: `round(x::numeric, 2)`.
- The trigram operator lives in the `extensions` schema. In dynamic SQL write
  `a operator(extensions.%) b`, and remember `%` must be escaped as `%%` inside
  `format()`.
- `pg_trgm.similarity_threshold` cannot be set in a function `SET` clause here
  (permission denied); filter with an explicit `similarity(...) >= x`.
- The `authenticated` role has `statement_timeout = 8s`. Long-running functions
  carry their own `set statement_timeout` clause (legal, USERSET, restored on exit).
  PostgREST's ~60 s gateway timeout is separate and cannot be raised.
- PostgREST only exposes `public`. The silver table lives in `ds`, so the browser
  reaches it through `public.dataset_page(...)`, never directly.
- Hand-inserting into `auth.users` requires the token columns (`confirmation_token`,
  `recovery_token`, `email_change_token_new`, `email_change`, …) to be `''` and not
  `NULL` — GoTrue is Go and cannot scan NULL into a string, giving an opaque
  `500 Database error querying schema` on login.

## Database connectivity

`db.<ref>.supabase.co:5432` is **IPv6-only**, and this machine loses IPv6 routing
intermittently — every script then dies with `ENOTFOUND` even though `nslookup`
resolves, because `getaddrinfo` returns nothing usable.

`scripts/db.mjs` therefore tries the direct host first and **falls back to the IPv4
pooler** automatically, printing one `[db] host directo inalcanzable; usando …` line.
Note the pooler username is `postgres.<ref>`, not `postgres`. Set
`SUPABASE_POOLER_HOST` to pin a region and skip the probe. A credentials error stops
the loop rather than trying every region.

## Charts

Follow `references/palette.md` from the `dataviz` skill. Series colors are the
validated slots exposed as `--s1/--s2/--s3` in `src/index.css`; light-mode `--s3` is
below 3:1 contrast, so charts using it must ship visible labels or a table view
(`Dashboard.tsx` has a chart/table toggle for exactly this). **Never** put two
measures of different scale on a dual axis — headcount and payroll cost are two
separate charts.

## Verification baseline

Cross-checked against an independent Python profiling of the sample file. If a change
moves these, something broke:

| | |
|---|---|
| Silver / quarantined / partial-cell rows | 93,484 / 56 / 31 |
| Headcount 2016-11 | 3,978 |
| Payroll 2016-11 | $3,609,277.41 |
| Conserjes 2016-11 | 76 exact, 78 grouping variants |
| > $5,000 in 2016-11 | 1 (the mayor, $5,263.53) |
| Historical median | $666.75 |
| Duplicate (person, period) | 3, $5,315.26 impact |
| Alerts | 15 · sandbox 27/27 |

## Known rough edges

- `package.json` has a dead `seed:user` script pointing at a nonexistent
  `scripts/seed-user.mjs`; user seeding actually lives in `scripts/load-file.mjs`.
- Confirming an encoding-drift mapping still has no UI; it goes through
  `public.set_value_map` (RPC, ready for one) or `npm run map`.
- The "Alertas" tab and the dashboard's alert card are hidden at the user's request.
  The route `/d/:id/alertas` and the whole alert engine still work.
- `chat_sessions`/`chat_messages` exist but the chat does not persist history yet.
