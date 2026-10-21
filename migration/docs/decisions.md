# Decisions — open-banking-rails → Kotlin

Decisions that shape the Kotlin rebuild. Each entry: question, answer, consequences, source. Service-specific decisions live
here only; general Ruby→Kotlin migration rules are additionally stored in Context Fabric (marked **→ CF**).

## Inherited decisions

Prior knowledge gathered in Phase 0 (2026-10-21):

- **Context Fabric search** (project `ruby-to-kotlin-migration-demo`): `wiki_find` exact search `kotlin|ruby→kotlin|spring|ktor` across all
  wiki pages and raw sources → **no matches**; meaning search "ruby to kotlin migration decisions conventions" → only Rails-internal pages
  (service objects, testing, database operations, AI insights); `repo_insights` and `architecture` → no migration guidance.
  **Result: no earlier Ruby→Kotlin decisions exist.** There is no `agents_md` tool in this Context Fabric deployment; the project
  AGENTS.md at `/project-workspace/wiki/AGENTS.md` was read instead. There is also no project-level `CLAUDE.md` defining a target stack.

| ID | Inherited decision | Source | Applies to this migration |
|---|---|---|---|
| ID-1 | **PostgreSQL** is the primary relational store | project AGENTS.md "Standards → Data & messaging"; Context Fabric `architecture` | Yes — keep PostgreSQL (17); schema features used: `ltree`, jsonb, views (50-data.md) |
| ID-2 | **Redis** for caching and session management | same | Partially — the Rails app uses Redis for Sidekiq, ActionCable and (prod) cache; sessions are cookie-based. With D-001 (JobRunr, Postgres-backed) and D-004 (Turbo Streams over WebSocket/SSE) the Kotlin service does not need Redis unless it runs several web instances |
| ID-3 | Synchronous service communication via **HTTP/gRPC** | same | Yes — the service has no message broker; external calls are HTTPS (Enable Banking, LLM providers) |
| ID-4 | **Structured request logging** (Lograge in Ruby) | project AGENTS.md "Observability & logging" | Yes — Kotlin equivalent: one structured JSON log line per request (e.g. logstash-logback-encoder) with the same fields as `config/initializers/lograge.rb` |
| ID-5 | **OpenTelemetry** with OTLP exporters for traces, logs and metrics, automatic instrumentation, logger correlation | same | Yes — OTel Java agent or Spring Boot OTel starter; same `OTEL_*` env contract (70-security-and-config.md) |
| ID-6 | Repo conventions (thin controllers, verb-named services with Input/Result, adapters around every external API, in-memory fakes for tests, English-only UI copy) | repo `AGENTS.md`, `docs/adr/*` | As design intent only: the Kotlin rebuild must preserve **behaviour**; structure may follow Kotlin idioms. The adapter + fake pattern is recommended to keep the oracle comparable |

## Decisions taken in this investigation

Asked via `ask_user` on 2026-10-21. **→ CF** = also a general Ruby→Kotlin rule for Context Fabric (queued in
[pending-context-fabric.md](pending-context-fabric.md) because the Context Fabric server's authorisation expired during the session).

### D-001 Target stack (round 1, Q1)
- **Question:** No target stack was defined. Which stack should the Kotlin service use?
- **Options offered:** (1) Spring Boot 3 + jOOQ/JDBC + Flyway + Spring Security + JobRunr *(recommended)*; (2) Spring Boot 3 + Spring Data JPA/Hibernate + Flyway + Spring Security + JobRunr; (3) Ktor + Exposed; (4) other.
- **Answer:** **(2) Spring Boot 3 + Kotlin, Spring Data JPA/Hibernate + Flyway, Spring Security, JobRunr.**
- **Consequences:** gem→JVM table in 00-overview.md resolved accordingly (Spring MVC controllers for UI/API, Spring Security form login +
  bearer-token filter, JPA entities, Flyway baseline, JobRunr for jobs/cron/retries/dashboard). SQL-heavy parts need native queries or
  custom types with JPA: the `ledger_entries` UNION view (map as a read-only `@Immutable` entity), `ltree` columns and `<@`/`@>` operators
  (custom Hibernate type or native SQL), jsonb (`@JdbcTypeCode(SqlTypes.JSON)`), partial unique indexes (DB-level only). Redis is no longer
  required for jobs (JobRunr uses Postgres); see D-004 for realtime. Service-specific; not stored in CF (not stated as a general default).

### D-002 Behaviour parity policy (round 1, Q2) **→ CF**
- **Question:** ~55 suspected bugs were found. What is the parity policy?
- **Answer:** **Preserve all behaviour for valid input; fix defects that are security/tenant-isolation issues or crashes (500) on invalid
  input; every other deviation needs an explicit decision; each fix is recorded as a decision and covered by a test.**
- **Consequences:** every `BUG?` unknown is classified (see "Classification of suspected bugs" below): *fix-security*, *fix-500*, or
  *preserve unless decided*. Invalid input that crashes today must return a 4xx with the endpoint's normal error format
  (API: 400 `{"message":"Invalid parameters.","details":[…]}`; HTML: 422 re-render or redirect with alert; MCP: JSON-RPC error / `isError`).
  Behaviour bugs on valid input (e.g. MCP default limit 1, daily auto-sync every 2 days, ATM top-up category) stay as-is until decided.

### D-003 Multi-tenancy (round 1, Q3)
- **Question:** Is strict isolation between multiple users of one instance a requirement?
- **Answer:** **Yes — multiple users per instance must be strictly isolated; fix all listed leaks.**
- **Consequences:** fix in Kotlin (each with a test): bank-account lookup by provider uid scoped to the owning credential/user and the
  global unique index on `bank_accounts.uid` replaced by a per-credential unique index (U-101/U-200/U-506); audit log readable only for
  the user's own records (needs an owner column or join; U-121/U-500/U-811); job dashboard restricted (U-501/U-810 — see D-006);
  category tree queries scoped by user (U-100/U-300/U-700/U-712); foreign category ids rejected (404/422) in merchant default category and
  hidden categories (U-320/U-524/U-604); foreign/inactive connection id on manual sync rejected instead of widening to all connections
  (U-209/U-605/U-806/U-512); hidden-category guard applied consistently (U-304/U-505/U-521/U-701). U-411 (hidden categories are UI-only in API)
  remains a separate decision.

### D-004 UI approach (round 1, Q4)
- **Question:** How should the Kotlin service deliver the admin UI?
- **Answer:** **Server-rendered templates in Kotlin (e.g. JTE/Thymeleaf) keeping the existing Hotwire/Stimulus JS, Tailwind CSS and URLs;
  Turbo Streams via WebSocket/SSE.**
- **Consequences:** 40-ui.md is the page contract (same URLs, form field names, flash strings, Turbo Stream targets); the 21 Stimulus
  controllers, `application.css` design tokens and importmap pins are reused verbatim; Rails form-helper conventions (`authenticity_token`,
  `_method` override for PATCH/PUT/DELETE, `turbo_confirm`, `data-turbo-method`) must be reproduced; Turbo Streams for the two run pages are
  served over Spring WebSocket or SSE (Turbo supports `<turbo-stream-source>` for SSE), so Redis pub/sub is not required with a single web
  instance. Service-specific.

### D-005 Data compatibility (round 1, Q5)
- **Question:** Must the Kotlin service work on existing Rails-created data?
- **Answer:** **Yes, in place: same schema (Flyway baseline from schema.rb), read/write Rails ActiveRecord-encryption format with the
  same ENV keys, import existing `.obrbundle` files.**
- **Consequences:** Flyway `V1__baseline.sql` generated from the final schema (+ `ledger_entries` v04 view), `baselineOnMigrate` for
  existing DBs (U-107); a byte-compatible implementation of Rails 8.1 ActiveRecord Encryption (AES-256-GCM, JSON message envelope with
  `p`/`h.iv`/`h.at`, key derivation PBKDF2-SHA256 from `ACTIVE_RECORD_ENCRYPTION_*`, deterministic IV for deterministic attributes) is a
  hard requirement with golden tests against ciphertexts produced by the Ruby app (U-106/U-818); `versions.object/object_changes` (YAML
  written by PaperTrail) must stay readable or be left as historical data (U-105); `.obrbundle` v1 import must be supported (BR-150..157);
  ENV variable names keep their meaning (70-security-and-config.md). Service-specific.

### D-006 Framework/unused feature scope (round 1, Q6) **→ CF**
- **Question:** What to do with unused framework routes/engines and tooling UIs?
- **Answer:** **Do not port unused framework engines/routes (ActionMailbox, Conductor, ActiveStorage, ActionText, Turbo Native, gutentag)
  or dev debug routes; replace Sidekiq Web with the job runner's own dashboard behind auth; serve OpenAPI 3 at the same docs URL.**
- **Consequences:** 26 framework routes + 6 `/admin/debug*` routes + `/sidekiq` are out of scope (marked in 30-http-api.md); `gutentag_*`
  tables are not created in new installs (left untouched in existing DBs); JobRunr dashboard served behind the admin login — with D-003 it must
  not expose other users' job arguments, so either restrict it to an operator role or disable it in multi-user instances; `/api/v1/docs`
  serves Swagger UI over an OpenAPI 3 document (springdoc) — the `swagger_doc` JSON changes format (2.0 → 3.0), API behaviour does not.

### Classification of suspected bugs under D-002 / D-003

| Class | Unknowns | Kotlin behaviour |
|---|---|---|
| **Fix — tenant isolation / security (D-003)** | U-101, U-200, U-506 (account uid takeover); U-121, U-500, U-811 (audit log); U-501, U-810 (job dashboard); U-100, U-300, U-700, U-712 (category tree); U-320, U-524, U-604 (foreign category ids); U-209, U-512, U-605, U-806 (foreign/inactive connection id widens sync); U-304, U-505, U-521, U-701 (hidden-category guard) | Scope every lookup to the current user; reject foreign ids with 404 (lookups) or 422 (references in payloads); tests per leak |
| **Fix — 500 on invalid input (D-002)** | U-402, U-603, U-515 (`from > to`); U-503 (unknown LLM provider); U-602 (malformed MCP JSON); U-309, U-513 (classification without mode); U-514 (non-file bundle); U-216 (connection without access flags); U-416, U-610, U-614 (other unvalidated inputs); U-119, U-303 (FK error deleting a hidden category); U-203, U-502, U-702 (invalid bank-connection form → empty 204) | Return the endpoint's normal validation error (API 400 `Invalid parameters.`/422, HTML 422 re-render with alert, MCP `isError` result or JSON-RPC −32700/−32602) |
| **Preserve until decided (valid-input behaviour)** | U-201, U-206, U-800, U-803 (sync scheduling/retries); U-301, U-302 (category form/move); U-306, U-307, U-308 (LLM pipeline); U-400, U-401, U-104 (ATM top-up category/kind); U-403, U-404 (cash API/wallet); U-600, U-601 (MCP default limit); U-805 (inverted sync window — accepted, succeeds); U-808 (brute force/enumeration); U-822 (SMTP config); U-102 (dead delegates — not reachable); U-703, U-708 (UI markup) | Behaviour as documented in 20/30/40 until a later decision (round 2/3 below) changes it |

### D-007 Time zone (round 2, Q1)
- **Question:** Rails runs in UTC ("today", periods, cash default date, schedule preferred_hour). Which semantics?
- **Answer:** **One instance-wide time zone from an ENV variable (e.g. `APP_TIME_ZONE`, default `Europe/Warsaw`) used for "today", periods and schedules.**
- **Consequences:** deviation from Ruby (UTC) — BR-310..316 (periods/"today"), BR-340+ (cash default booking date) and the scheduling rules
  (preferred_hour) are evaluated in `APP_TIME_ZONE`; timestamps stay stored as UTC `timestamp`; new ENV var added to 70-security-and-config.md;
  parity tests against the oracle must run with `APP_TIME_ZONE=UTC`. Resolves U-405, U-202, U-120.

### D-008 Sync scheduling defects (round 2, Q2)
- **Answer:** **Fix all four:** slot-based next-run computation (daily = every day at preferred_hour, weekly = every 7 days), each failed run
  counted once by the circuit breaker, stale `queued`/`running` runs reaped (marked failed after a timeout), per-connection lock for concurrent syncs.
- **Consequences:** deviations recorded against U-201, U-206, U-800, U-801, U-803, U-804, U-221 (circuit-breaker re-trip follows the corrected
  counting); each needs a test. Reaper timeout value to be chosen by the Kotlin team (proposed 1 h, configurable).

### D-009 Analytics semantics (round 2, Q3)
- **Answer:** **Keep current semantics exactly (as documented in BR-3xx); revisit after the migration.**
- **Consequences:** U-406, U-407, U-409, U-413, U-414, U-412 are preserved behaviour; parity tests compare the Kotlin analytics endpoints
  with the oracle samples numerically.

### D-010 LLM behaviour vs documented intent (round 2, Q4)
- **Answer:** **Keep exact code behaviour (parity)** — raw title is sent alongside the normalised one, LLM suggestions may overwrite existing
  merchants as the code does today, a blank key is kept on provider change, one invalid regex/missing key aborts the run.
- **Consequences:** U-306, U-307, U-312, U-316, U-318, U-816 are preserved behaviour; the in-app privacy note text is ported as-is (it is
  inaccurate — flagged for a post-migration fix); BR-2xx rules stand as written.

### D-011 Batch of functional defects (round 2, Q5)
- **Answer:** **Fix the whole batch.**
- **Consequences:** recorded deviations, each with a test: MCP `transactions.list`/`merchants.list` default limits 25/50 (U-600, U-601);
  ATM top-ups get the seeded ATM category — path `money.transfers.atm` ("Bankomat", kind `transfer`,
  `app/services/seeders/categories.rb:146`) instead of the never-seeded slug `cash_atm_topup` (`app/services/cash/atm_withdrawal_linker.rb:48`) —
  and counterparty kind `self` (U-104, U-400, U-401); `PATCH /api/v1/cash_transactions/:id`
  updates only supplied fields (U-403); no wallet is created when the cash entry fails (U-404); blank slug on the category form is generated
  from the name (U-301); slugs transliterate Polish/accented letters consistently, existing slugs unchanged (U-305); merchant `source` filter
  accepts `system` (U-607); 404 messages no longer include SQL (`{"message":"Not found"}`-style, U-606).

### D-012 Security hardening beyond tenant isolation (round 2, Q6)
- **Answer:** **Out of scope: exact parity, harden later.**
- **Consequences:** D-002's "security defects" are interpreted as **tenant-isolation defects (D-003)** only. Preserved: password-reset
  enumeration and no sign-in rate limiting (U-223, U-507, U-808), CORS `*` on all paths (U-812, U-517), no CSP and runtime CDNs (U-813),
  readable/replayable OAuth state within 30 min (U-219, U-519), production TLS default off (U-819), no regex timeout (U-313), session lifetime
  (U-520). Listed as post-migration hardening backlog in unknowns.md.

### D-013 Data exchange scope (round 3, Q1)
- **Answer:** **Keep the current scope exactly** (credentials/connections/accounts backup for moving instances); extend later.
- **Consequences:** BR-150..157 unchanged; U-215 resolved as intended scope; U-213/U-214 (size cap/counters, duplicate primary credential on import) stay preserved behaviour.

### D-014 AI insight card (round 3, Q2) **→ CF**
- **Answer:** **Out of scope — rebuild what exists in code; track the AI insight as a future feature.**
- **Consequences:** ADR 0008 / README / wiki describe a feature absent at `cd3bf60`; not ported (U-314, U-408; also the ADR 0010 recurrence facet). General rule: documentation-only features are not part of a migration's scope.

### D-015 Hidden categories in API/MCP (round 3, Q3)
- **Answer:** **Keep current behaviour:** hiding is a UI-only screen-share privacy feature; API/MCP clients see everything.
- **Consequences:** U-411 resolved as intended; API/MCP parity with the oracle.

### D-016 User deletion (round 3, Q4)
- **Answer:** **Out of scope** — no user-deletion feature (parity); cascade behaviour documented for operators (10-domain-model.md, 50-data.md).
- **Consequences:** U-110 closed as "no feature"; Kotlin FKs and JPA cascades must still reproduce the documented `dependent:`/`ON DELETE` behaviour for deletions that do exist (connections, credentials, categories…).

### D-017 Re-running seeders (round 3, Q5)
- **Answer:** **Keep exact behaviour** — re-seeding (onboarding "seed taxonomy", seed tasks) matches rows by slug and overwrites user edits to seeded rows.
- **Consequences:** U-109/U-315 preserved behaviour; seeder data files are ported verbatim (118 categories, 27 merchants / 29 rules per user).

### D-018 Inverted date windows (round 3, Q6)
- **Answer:** **Reject** manual sync requests with `date_to` < `date_from` with a validation error (API 400 `Invalid parameters.` / admin alert), consistent with analytics (D-002).
- **Consequences:** deviation from Ruby (U-210, U-805): oracle cases `date_to_before_from → 201` become 400 in Kotlin; test required.

## Deviation register — where the Kotlin expectation differs from the Ruby oracle

Every row needs a Kotlin test. Oracle samples for these cases document **Ruby** behaviour and must not be used as the Kotlin expectation.

| # | Decision | Area / routes / rules | Ruby (oracle) | Kotlin expectation |
|---|---|---|---|---|
| X-01 | D-003 | `GET /callback` connection creation (BR-050..099 account matching), `bank_accounts.uid` unique index | account matched by global `uid` → another tenant's account re-pointed | match by `uid` within the same credential/user; unique index `(tpp_credential_id, uid)` |
| X-02 | D-003 | `GET /admin/versions`, `GET /admin/versions/:id` | all tenants' versions, 200 | only versions of records owned by the current user; foreign id → 404 |
| X-03 | D-003, D-006 | `/sidekiq` mount | Sidekiq Web for any signed-in user | JobRunr dashboard, operator-only or disabled in multi-user instances |
| X-04 | D-003 | category breadcrumbs/ancestry everywhere (40-ui.md), category "in use" checks | ancestors duplicated across tenants | user-scoped ancestry |
| X-05 | D-003 | merchant create/update `default_category_id` (admin, API, MCP), preferences app `hidden_category_ids` | foreign ids accepted | 422 (admin re-render / API `{"message","details"}` / MCP `isError`) |
| X-06 | D-003, D-018 | `POST /admin/transaction_syncs`, `POST /api/v1/transaction_syncs`, MCP `transaction_syncs.create` | foreign/inactive connection → sync of all connections (201); `date_to < date_from` accepted (201) | foreign → 404; inactive → 422; inverted window → 400 `Invalid parameters.` / admin alert |
| X-07 | D-003 | merchant edit / update / destroy hidden-category guard | guard dead on edit, absent on update/destroy | guard applied consistently (behaviour as documented for `show`) |
| X-08 | D-002 | `GET /api/v1/analytics/*`, MCP analytics tools, `/admin/analytics*` with `from > to` | 500 | 400 `Invalid parameters.` (API), `isError` (MCP), alert + default period (HTML) |
| X-09 | D-002 | `PATCH /admin/settings/preferences/llm` unknown provider | 500 | 422 re-render with validation message |
| X-10 | D-002 | `POST /mcp` malformed JSON / unexpected tool argument keys | 500 HTML / JSON-RPC internal error | JSON-RPC parse error −32700 / invalid params −32602 |
| X-11 | D-002 | classification without `mode` (`PATCH /admin/bank_transactions/:id/enrichment`, API, MCP) | 500 | 422 / 400 |
| X-12 | D-002 | data import with non-file `bundle` | 500 | redirect with alert "Bundle file is required." |
| X-13 | D-002 | `POST /admin/bank_connections` invalid form | 204 empty body | 422 re-render with errors |
| X-14 | D-002 | deleting a hidden but unused category | FK error 500 | delete succeeds (hidden rows removed) |
| X-15 | D-002 | other unvalidated inputs (U-216, U-416, U-610, U-614) | 500 | 400/422 |
| X-16 | D-006 | ActionMailbox, Conductor, ActiveStorage, Turbo Native routes, `/admin/debug*` | present (404/422/500) | not present (404) |
| X-17 | D-006 | `GET /api/v1/swagger_doc*` | Swagger 2.0 JSON | OpenAPI 3 JSON (UI at `/api/v1/docs` unchanged) |
| X-18 | D-007 | "today", default periods, cash default booking date, schedule `preferred_hour` | UTC | `APP_TIME_ZONE` (default Europe/Warsaw) |
| X-19 | D-008 | auto-sync next run, circuit breaker, stale runs, concurrency | daily ≈ every 2 days; double-counted failures; no reaper; no lock | slot-based cadence; one count per failed run; reaper; per-connection lock |
| X-20 | D-011 | MCP `transactions.list` / `merchants.list` without `limit` | 1 row | 25 / 50 rows |
| X-21 | D-011 | ATM top-up created by `Cash::AtmWithdrawalLinker` | uncategorised, counterparty kind `unknown` | category `money.transfers.atm`, counterparty kind `self` |
| X-22 | D-011 | `PATCH /api/v1/cash_transactions/:id` | omitted fields cleared | omitted fields unchanged |
| X-23 | D-011 | cash entry failing validation | wallet created anyway | no wallet created |
| X-24 | D-011 | admin category form with blank slug | always fails | slug generated from name |
| X-25 | D-011 | slug generation (merchants/categories) | Polish letters dropped (`Żabka` → `abka`) | transliterated (`zabka`); existing slugs unchanged |
| X-26 | D-011 | `GET /api/v1/merchants?source=system`, MCP `merchants.list` | 400 (enum excludes `system`) | accepted |
| X-27 | D-011 | 404 error messages (API/MCP) | include SQL fragments | generic message without SQL |
