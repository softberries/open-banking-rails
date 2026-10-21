# 60 - Background processing, mailers, external integrations, operations tooling


> **Decisions apply.** Where Phase-4 decisions change behaviour for Kotlin, the [deviation register](decisions.md#deviation-register--where-the-kotlin-expectation-differs-from-the-ruby-oracle) (X-01…X-27) overrides the Ruby behaviour described here; unknowns carry a **Resolution** line ([unknowns.md](unknowns.md)).

Scope: everything that happens outside the HTTP request/response cycle, plus every outbound integration and
the operator tooling (rake tasks, backup/restore scripts, observability stack). Source paths are relative to
`/workspace/ruby-service-investigator/src` (commit `cd3bf605`). Oracle links are relative to `docs/`.

Certainty marks: **[V]** = observed in the oracle run or asserted by a passing spec (cited), **[I]** = inferred from reading code.

Related documents: business rules for sync/enrichment live in `20-business-rules.md` (banking/sync rules BR-050..BR-199,
LLM enrichment rules BR-200..BR-299 - exact ids are cross-linked there); HTTP endpoints that enqueue work are in `30-http-api.md`;
the `operation_runs` / `sync_schedules` tables are in `50-data.md`; ENV vars and initializers in `70-security-and-config.md`.

---

## 1. Runtime topology

| Process | Command | Role | Evidence |
|---|---|---|---|
| web | `./bin/rails server -b 0.0.0.0` (Puma) | HTTP, ActionCable WebSocket endpoint (`/cable`), enqueues jobs | `docker-compose.prod.yml:79-103`; dev: `Procfile.dev:1` [I] |
| worker | `bundle exec sidekiq -C config/sidekiq.yml` | Executes all background jobs; the only process that registers cron entries | `docker-compose.prod.yml:105-121`, `Procfile.dev:3` [I] |
| migrate | `./bin/docker-migrate` (one-shot) | Pre-migration `pg_dump` then `db:prepare`; app/worker start only after it completes successfully | `docker-compose.prod.yml:63-77`, `bin/docker-migrate:1-39` [I] |
| db | `postgres:17-alpine` | Primary data store | `docker-compose.prod.yml:35-49` [I] |
| redis | `redis:7-alpine` | Sidekiq queues/retry/schedule sets, sidekiq-cron state, ActionCable pub/sub | `docker-compose.prod.yml:51-61` [I] |
| db-backup | `prodrigestivill/postgres-backup-local:17` | Scheduled logical backups into `./backups` | `docker-compose.prod.yml:123-141` [I] |

In the oracle run Sidekiq **v7.3.10** against Redis **7.4.2** at `redis://127.0.0.1:6379` was running next to Puma
[V] [oracle UI](../oracle/ui/sidekiq_dashboard.html) (dashboard footer).

---

## 2. Background processing configuration

### 2.1 Adapter, queues, concurrency

- ActiveJob adapter is **Sidekiq** in every environment: `config.active_job.queue_adapter = :sidekiq` (`config/application.rb:45`) [V]
  (dev log lines `[ActiveJob] Enqueued TransactionSyncJob (Job ID: ...) to Sidekiq(default) with arguments: 5`, `oracle/server.log.txt:1980`).
- In the test environment Sidekiq runs in `Sidekiq::Testing.fake!` mode, switched to `inline!` for system specs (`spec/rails_helper.rb:14`, `:52-60`; helper `spec/support/sidekiq_helpers.rb`) [I].
- `config/sidekiq.yml:1-3`: `concurrency: 5`, single queue `default` [I]. Every application job uses `queue_as :default` (see per-job sections) [V] (`inventory/jobs.json`).
- No queue priorities, no weights, no separate queue for mail or broadcasts [I].
- Server-side logger uses Sidekiq's JSON formatter (`config/initializers/sidekiq.rb:4`) [I].
- Redis connection for Sidekiq is **not configured explicitly**; Sidekiq reads `REDIS_URL` from the environment and falls back to `redis://localhost:6379/0` (`config/initializers/sidekiq.rb` sets no URL; `inventory/env.txt` implicit section) [I]. Production compose sets `REDIS_URL=redis://redis:6379/0` (`docker-compose.prod.yml:18`) [I].
- Database pool: `max_connections = RAILS_MAX_THREADS` (default 5) (`config/database.yml:9`), equal to Sidekiq concurrency 5 in production compose (`RAILS_MAX_THREADS: 5`, `docker-compose.prod.yml:24`) [I].

### 2.2 Redis usage per environment

| Use | development | test | production | Evidence |
|---|---|---|---|---|
| Sidekiq (queues, retries, scheduled, dead, cron) | `REDIS_URL` (`.env.example:10` = `redis://localhost:6379/0`), else Sidekiq default `redis://localhost:6379/0` | not used (fake/inline) | `redis://redis:6379/0` | [I] |
| ActionCable pub/sub | adapter `redis`, `ENV.fetch("REDIS_URL") { "redis://localhost:6379/1" }`, channel prefix `open_banking_rails_development` | adapter `test` | adapter `redis`, same URL expression, prefix `open_banking_rails_production` | `config/cable.yml:1-15` [I] |
| `Rails.cache` | `:memory_store` (`config/environments/development.rb:38`) | `:null_store` (`config/environments/test.rb:23`) | not set -> Rails default (file store under `tmp/cache`) | [I]; no application code calls `Rails.cache` (grep) [I] |

Development uses Redis (not `:async`) for ActionCable on purpose so broadcasts fired inside the Sidekiq process reach
browsers connected to Puma (`config/cable.yml:2-4`) [I].

### 2.3 Retry semantics (applies to all jobs)

Because jobs are ActiveJob classes executed by Sidekiq, two retry layers exist [I]:

1. **ActiveJob `retry_on`** (only `FailingJob` uses it): the exception is rescued, the job is re-enqueued with a delay; Sidekiq sees a success.
2. **Sidekiq retry**: when an exception escapes `perform`, Sidekiq retries with its exponential backoff. `retry: true` means Sidekiq's default
   of 25 retries, after which the job goes to the Dead set; `dead: false` discards it instead. Effective options per class are in
   `inventory/jobs.json` [V] (introspected).

No job uses `discard_on`, unique-job locks, `sidekiq_retries_exhausted`, or a custom `sidekiq_retry_in` [I] (grep of `app/jobs`).

---

## 3. OperationRun - progress tracking contract

Long operations are tracked in `operation_runs` (ADR `docs/adr/0009-operation-run-tracker.md`). Jobs are thin wrappers that own the run record;
synchronous callers (rake, console) bypass it (ADR 0009 "Decision") [I].

| Item | Value | Evidence |
|---|---|---|
| `kind` whitelist | `transaction_sync`, `balance_refresh`, `connection_refresh`, `account_details_refresh`, `llm_enrichment`, `llm_connection_test`, `data_export`, `data_import` | `app/models/operation_run.rb:41-50` [I] |
| kinds actually written by code | `transaction_sync` (queuer, dispatcher), `llm_enrichment` (queuer), `llm_connection_test` (synchronous, in request), `data_export`/`data_import` (synchronous) | `app/services/transaction_syncs/queuer.rb:27`, `app/services/auto_sync/dispatcher.rb:60`, `app/services/llm_enrichments/queuer.rb:32`, `app/services/llm/connection_test_runner.rb:53`; [V] oracle runs 1-15 in [operation_runs](../oracle/operation_runs_after_capture.jsonl). `balance_refresh`, `connection_refresh`, `account_details_refresh` are declared but never created (grep) [I] |
| statuses | `queued` -> `running` -> one of `succeeded` / `partial` / `failed` (terminal) | `app/models/operation_run.rb:52-54`, `:85-99`; [V] `spec/models/operation_run_spec.rb:40`, `:51`, `:64`, `:85` |
| triggers | `manual`, `scheduled` | `app/models/operation_run.rb:53` [I] |
| `start!` | sets `status=running`, `started_at=now` | `:85-87` [V] `spec/models/operation_run_spec.rb:40` |
| `fail!(error:)` | `status=failed`, `finished_at=now`, `error=error.to_s`, optional summary | `:97-99`, `:149-154` [V] `spec/models/operation_run_spec.rb:75` |
| scheduled idempotency | partial UNIQUE index `(subject_type, subject_id, kind, scheduled_for) WHERE scheduled_for IS NOT NULL` | `app/models/operation_run.rb:31` [V] `spec/models/operation_run_spec.rb:111`, `:124` |
| `duration_seconds` | `nil` before start; `(finished_at or now) - started_at`, truncated to integer seconds | `:113-117` [V] `spec/models/operation_run_spec.rb:100` |

### 3.1 Live progress (Turbo Streams over ActionCable)

- Only kinds in `STREAMED_KINDS = transaction_sync, llm_enrichment` broadcast (`app/models/operation_run.rb:65-67`) [V] `spec/models/operation_run_spec.rb:166`.
- Trigger: **after every committed update** of such a run (start, each per-account/per-batch summary update, finish) [I].
- Mechanism: `broadcast_replace_later_to("operation_run_<id>", target: "progress_operation_run_<id>", partial: "admin/<kind plural>/run_progress", locals: { run: })`
  (`app/models/operation_run.rb:140-147`). "later" means a Turbo broadcast render job is enqueued on Sidekiq, which renders the partial
  (`app/views/admin/transaction_syncs/_run_progress.html.erb`, `app/views/admin/llm_enrichments/_run_progress.html.erb`) and publishes it via ActionCable [I].
- Subscription: the run show pages call `turbo_stream_from "operation_run_#{@run.id}"` (`app/views/admin/transaction_syncs/show.html.erb:1`,
  `app/views/admin/llm_enrichments/show.html.erb:1`). The stream name is signed by turbo-rails with the app secret, so a client cannot
  subscribe to an arbitrary run id without a page that embeds the signed name [I].
- Observed: WebSocket connect + `Turbo::StreamsChannel` subscribe/unsubscribe in the dev log (`oracle/server.log.txt:19601-19602`, `:19697-19698`) [V].
- There is no `app/channels` directory and no `ApplicationCable::Connection` - the WebSocket connection does not identify a user; protection relies on signed stream names [I].

Kotlin equivalent: a per-run server-push channel (SSE or WebSocket) keyed by an unguessable/signed run token, pushing the re-rendered progress fragment
(or JSON) on each state change.

---

## 4. Jobs

<a id="job-applicationjob"></a>
### 4.1 ApplicationJob

- File `app/jobs/application_job.rb:1-2`: empty subclass of `ActiveJob::Base`; no `retry_on`, `discard_on`, callbacks or queue settings [I].
- Effective Sidekiq options inherited by subclasses: `retry: true` (Sidekiq default 25 retries then Dead set), queue `default` [V] (`inventory/jobs.json`).

<a id="job-autosync-dispatcherjob"></a>
### 4.2 AutoSync::DispatcherJob

| Aspect | Behaviour | Evidence |
|---|---|---|
| Trigger | sidekiq-cron entry `auto_sync_dispatcher`, every minute (see 4.6). No other caller. | `config/schedule.yml:6-9`; grep [I] |
| Arguments | none | `app/jobs/auto_sync/dispatcher_job.rb:7` [I] |
| Queue / retry | `default`; Sidekiq `retry: true` (25) | `:5`; `inventory/jobs.json` [V] |
| Work | calls `AutoSync::Dispatcher.call` and logs `[AutoSync::DispatcherJob] {examined: N, dispatched: N, skipped: N}` at INFO | `app/jobs/auto_sync/dispatcher_job.rb:8-9`, `app/services/auto_sync/dispatcher.rb:12-14` [I] |

**Dispatcher algorithm** (`app/services/auto_sync/dispatcher.rb`), business rules in `20-business-rules.md` (BR-050..BR-199 range):

1. Select `SyncSchedule.due`: `enabled = true AND (next_run_at IS NULL OR next_run_at <= now) AND (paused_until IS NULL OR paused_until <= now)`
   (`app/models/sync_schedule.rb:46-51`) [V] `spec/models/sync_schedule_spec.rb:31`, `:47`, `:63`; `spec/services/auto_sync/dispatcher_spec.rb:71`.
2. For each due schedule (batched `find_each`):
   - If the connection `status != "authorized"` or it has no owning user: set `paused_until = now + 6 hours` (`REVOKED_BACKOFF`), do not touch
     `consecutive_failures`, count as skipped (`:49-54`) [V] `spec/services/auto_sync/dispatcher_spec.rb:27`.
   - Otherwise, in one DB transaction: create `OperationRun(kind: "transaction_sync", trigger: "scheduled", subject: connection,
     triggered_by_user: owner, scheduled_for: schedule.next_run_at || now, params: {})` and update the schedule
     (`next_run_at = NextRunCalculator(...)`, `last_dispatched_at = now`) (`:56-77`) [V] `spec/services/auto_sync/dispatcher_spec.rb:6`, `:41`.
   - After commit: `TransactionSyncJob.perform_later(run_id)` (`:79`) [V] `spec/services/auto_sync/dispatcher_spec.rb:6`.
   - A concurrent tick for the same slot hits the partial unique index -> `RecordNotUnique` -> counted as skipped, no second run (`:81-82`)
     [V] `spec/services/auto_sync/dispatcher_spec.rb:55`.
3. Time zone for slot computation: `user.timezone` if the user model responds to it, else `"UTC"` (`:94-96`). The `users` table has **no**
   timezone column (`inventory/schema.rb:347-360`), so slots are computed in **UTC** today [I]. Slot rules (preferred hour, cadence
   `daily`/`every_2_days`/`weekly`, 0..300 s random jitter, fire-once-after-downtime) are in `app/services/auto_sync/next_run_calculator.rb`
   [V] `spec/services/auto_sync/next_run_calculator_spec.rb:10-67`.
4. End-to-end journeys: [V] `spec/system/auto_sync_tick_spec.rb:17`, `:53`, `:77`; circuit breaker `spec/system/auto_sync_circuit_breaker_spec.rb:17`, `:50`, `:83`.

Failure handling: an exception outside the per-schedule `RecordNotUnique` rescue aborts the whole tick and is retried by Sidekiq; the next
cron tick (1 minute later) re-scans anyway [I]. If enqueueing fails after the transaction committed, the run stays `queued` forever and the
schedule has already advanced (see U-803) [I].

Oracle: no `trigger = scheduled` run appears in [operation_runs](../oracle/operation_runs_after_capture.jsonl) - no schedule was due during the
~5-minute capture [V].

<a id="job-failingjob"></a>
### 4.3 FailingJob (development debug aid)

| Aspect | Behaviour | Evidence |
|---|---|---|
| Trigger | `POST /admin/debug/enqueue_failing_job` (route exists only when `Rails.env.development?`), param `error_type` default `"runtime"`; responds `204 No Content` | `config/routes.rb:33-42`, `app/controllers/admin/debug_controller.rb:28-31`; [V] [oracle](../oracle/http/POST_admin_debug_enqueue_failing_job.json) case default -> 204 |
| Arguments | keyword `error_type:` one of `"runtime"` -> `RuntimeError "FailingJob: intentional RuntimeError"`, `"argument"` -> `ArgumentError "FailingJob: intentional ArgumentError"`, `"zero_division"` -> `ZeroDivisionError`; any other value -> completes without error | `app/jobs/failing_job.rb:8-17` [I] |
| Retry | ActiveJob `retry_on StandardError, wait: 3.seconds, attempts: 3`, then Sidekiq `retry: true` (25) once ActiveJob gives up | `app/jobs/failing_job.rb:6`; `inventory/jobs.json` [I] |
| Enqueue observed | `[ActiveJob] Enqueued FailingJob (Job ID: 8b3d64c8-...) to Sidekiq(default) with arguments: {error_type: "runtime"}` | `oracle/server.log.txt:15708` [V] |

The Sidekiq worker log was **not** captured. About 96 s after the enqueue the Sidekiq dashboard showed **53 processed, 3 failed, 0 busy,
0 enqueued, 1 retry, 0 scheduled, 0 dead** [V] [oracle UI](../oracle/ui/sidekiq_dashboard.html). This matches: three ActiveJob attempts
3 s apart (rescued, so not "failed"), then the exception reaches Sidekiq and the job sits in the retry set, with some Sidekiq retries already
done. Treat this explanation as [I] (see U-802). The class is loaded in every environment, but only the dev-only route enqueues it [I].
Kotlin: optional; only needed if the debug page is kept (see U-802).

<a id="job-llmenrichmentjob"></a>
### 4.4 LlmEnrichmentJob

| Aspect | Behaviour | Evidence |
|---|---|---|
| Trigger | `LlmEnrichments::Queuer.call(user:, input: {limit})`, which is called from the admin `POST /admin/llm_enrichments`, Grape `POST /api/v1/llm_enrichments`, and MCP tool `operations.queue_llm_enrichment` | `app/controllers/admin/llm_enrichments_controller.rb:33`, `lib/api/resources/llm_enrichments.rb:35`, `lib/mcp/tools/operations/queue_llm_enrichment.rb:18` [I] |
| Pre-condition at enqueue | user must have a configured `LlmSetting` (api_key present), else the queuer returns failure `"Configure an LLM provider in Preferences before running enrichment."` and **no** run/job is created | `app/services/llm_enrichments/queuer.rb:28-30` [I] |
| Run created | `kind: "llm_enrichment"`, `status: queued`, `trigger: manual`, `subject` = user, `triggered_by_user` = user, `params: {"limit": <limit or 50>}`, `summary: {}` | `app/services/llm_enrichments/queuer.rb:32-40`; [V] oracle runs 6, 10, 11 (`params {"limit": 5}`) |
| Arguments | `operation_run_id` (integer) | `app/jobs/llm_enrichment_job.rb:8`; [V] `oracle/server.log.txt:1997` "with arguments: 6" |
| Queue / retry | `default`; Sidekiq `retry: true` (25, then Dead) | `inventory/jobs.json` [V] |

**Steps** (`app/jobs/llm_enrichment_job.rb:8-51`) [I] unless marked:

1. Load the run (`RecordNotFound` escapes -> Sidekiq retry). If it is already terminal, return without doing anything (idempotency guard for redelivery/retries).
2. `start!`. Initial summary `{"total_groups":0,"auto_applied":0,"pending_review":0,"skipped":0,"batches":[]}`.
3. `limit = params["limit"].to_i` (default `Llm::EnrichmentRunner::DEFAULT_LIMIT = 50`). User = run subject if it is a User, else `triggered_by_user`;
   if neither: raise `"OperationRun <id> has no resolvable user — cannot enrich"`.
4. Call `Llm::EnrichmentRunner.call(user:, limit:, on_batch:)` (rules BR-200..BR-299 in `20-business-rules.md`). After **each batch** the job appends
   `{"index","size","status" ("succeeded"|"failed"),"auto","pending","skipped","errors":[{"title","error"}],"request","response"}` to
   `summary.batches` and saves the run, which triggers a progress broadcast. `request` is the exact list of items sent to the LLM, `response` the raw
   parsed JSON [V] oracle run 10 summary (`"request": [{"index": 0, "title": "WYNAGRODZENIE", "counterparty_name": "Some Company sp. z o.o."}]`, `"response": {"results": []}`).
5. Final status:
   - errors present and `auto_applied == 0` and `pending_review == 0` -> `failed`, error `"All batches failed. First: <first error>"`;
   - errors present otherwise -> `partial`, error `"<n> item(s) failed."`;
   - no errors -> `succeeded`.
6. Any `StandardError`: `fail!(error: "<ExceptionClass>: <message>", summary:)` and re-raise (Sidekiq retry; the retry finds a terminal run and stops - see U-801).

Batching/throttling inside the runner: groups capped at `limit`, batches of 15 (`Llm::MerchantSuggester::BATCH_SIZE`), a 2-second sleep between
batches (`throttle_seconds: 2`) (`app/services/llm/enrichment_runner.rb:14`, `:33-34`, `:80`; `app/services/llm/merchant_suggester.rb:7`) [I].
Concurrency: no lock; two runs for the same user may run in parallel. Merchant/rule upserts use `find_or_initialize_by` (slug, field/kind/pattern) [I].

Observed outcomes [V] ([operation_runs](../oracle/operation_runs_after_capture.jsonl)): run 6 succeeded with 0 groups (`batches: []`); runs 10 and 11
succeeded with 1 and 3 items sent, all returned as skipped by the fake LLM (`"response": {"results": []}`).

<a id="job-transactionsyncjob"></a>
### 4.5 TransactionSyncJob

| Aspect | Behaviour | Evidence |
|---|---|---|
| Triggers | (a) manual: `TransactionSyncs::Queuer.call` from admin `POST /admin/transaction_syncs`, Grape `POST /api/v1/transaction_syncs`, MCP `operations.queue_transaction_sync`; (b) scheduled: `AutoSync::Dispatcher` | `app/controllers/admin/transaction_syncs_controller.rb:28`, `lib/api/resources/transaction_syncs.rb:36`, `lib/mcp/tools/operations/queue_transaction_sync.rb:20`, `app/services/auto_sync/dispatcher.rb:79` [I] |
| Run created (manual) | `kind: "transaction_sync"`, `status: queued`, `trigger: manual`, `subject` = the user's **active** BankConnection with the given id, otherwise **the user** (unknown, inactive or another tenant's id silently falls back to a user-wide sync), `params` = `{date_from, date_to}` as strings, blank values omitted | `app/services/transaction_syncs/queuer.rb:7-11`, `:27-35`, `:44-47`; [V] [oracle](../oracle/http/POST_api__version_transaction_syncs.json) case other_tenant_connection -> 201, run 9 `subject_type: "User"` (see U-806) |
| Arguments | `operation_run_id` | `app/jobs/transaction_sync_job.rb:14`; [V] `oracle/server.log.txt:1980`, `:5462`, `:5484`, `:5506` |
| Queue / retry | `default`; `sidekiq_options retry: 3, dead: false` - at most 3 Sidekiq retries, then discarded (not moved to Dead) | `app/jobs/transaction_sync_job.rb:6-10`; `inventory/jobs.json` [V] |

**Steps** (`app/jobs/transaction_sync_job.rb:14-36`) [I] unless marked:

1. Load the run. If it is terminal, return (redelivery guard) - but the `ensure` block still runs (step 7).
2. `start!`; `summary = {accounts: []}`.
3. Dispatch by subject type (`:100-122`):
   - `User` -> `EnableBanking::Operations::SyncUserTransactions` (each active connection of the user, ordered by id);
   - `BankConnection` -> `SyncConnectionTransactions` (each active current account of the connection, ordered by id; stamps `last_synced_at`);
   - `BankAccount` -> `SyncAccountTransactions` for one account (a `Failed` exception is captured as an outcome);
   - anything else (including a deleted subject) -> `fail!("Unsupported subject: <type>#<id>")`; the finalizer in step 5 then overwrites that error with `"No accounts in scope"` (see U-821).
   `date_from`/`date_to` come from `params`; when absent, the account operation uses `transactions_synced_at - 7 days`, or the bank backfill horizon
   (revolut 90, pko_bank_polski 780, mbank 90, default 90 days) for never-synced accounts, and `Date.current` as the end date
   (`app/services/enable_banking/operations/sync_account_transactions.rb:16`, `:27-28`, `:90-96`; `app/services/enable_banking/backfill_window.rb:6-20`)
   [V] `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:124`, `:172`. Detailed rules: `20-business-rules.md` BR-050..BR-199.
4. **Per-account progress**: after each account the job appends an entry and saves the run (which broadcasts):
   - success: `{bank_account_id, iban, bank, status: "succeeded", inserted, updated, skipped, pages_fetched, truncated, date_from, date_to}`;
   - failure: `{bank_account_id, iban, bank, status: "failed", error: <message>}` (`:124-148`).
   Per-account API failures do not stop the run (`app/services/enable_banking/operations/sync_connection_transactions.rb:32-40`) [V] `spec/system/manual_sync_flow_spec.rb:71`.
5. `OperationRunFinalizer.call(run, summary)` (`app/services/operation_run_finalizer.rb:15-22`):
   no accounts -> `failed` `"No accounts in scope"`; all succeeded -> `succeeded`; some -> `partial` `"<n> account(s) failed"`; none ->
   `failed` `"All <n> account(s) failed"` [V] `spec/services/operation_run_finalizer_spec.rb:6`, `:16`, `:26`, `:37`, `:48`.
6. Best-effort post-processing, errors only logged (`[TransactionSyncJob] Enrichment failed for run=<id>: ...`):
   rule-based enrichment of transactions without enrichment in the run's scope (`Enrichment::TransactionEnricher.enrich_pending`), then, if the owner has
   `track_cash = true`, ATM withdrawal linking for `payment_method = "blik_atm"`, `direction = "debit"` transactions in scope (`Cash::AtmWithdrawalLinker.link!`
   each, per-transaction errors logged) (`:50-81`). Note: this runs even when the finalizer marked the run failed [I].
7. `ensure`: if the run is terminal and `trigger == "scheduled"`, call `AutoSync::CircuitBreaker.observe(run:)`; errors logged
   `[TransactionSyncJob] CircuitBreaker failed for run=...` (`:34-46`). Circuit breaker: success resets `consecutive_failures = 0`, `paused_until = nil`; any other
   terminal status increments `consecutive_failures`, and at `>= 3` (`SyncSchedule::FAILURE_THRESHOLD`) sets `paused_until = now + 24 h`; only for BankConnection
   subjects; manual runs are exempt (`app/services/auto_sync/circuit_breaker.rb:15-46`) [V] `spec/services/auto_sync/circuit_breaker_spec.rb:6-71`,
   `spec/system/auto_sync_circuit_breaker_spec.rb:17`, `:83`.
8. Any escaping `StandardError`: `fail!(error: "<Class>: <message>", summary:)`, re-raise -> Sidekiq retry (up to 3) - see U-800 about retries also re-running step 7.

Idempotency and locking: there is no job-level lock. Re-syncing is idempotent at row level: unique index `(bank_account_id, external_id)`
(`inventory/schema.rb:103`); booked rows are skipped, pending rows overwritten (`sync_account_transactions.rb:65-76`) [V]
`spec/services/enable_banking/operations/sync_account_transactions_spec.rb:27`, `:46`, `:79`. Parallel runs over the same account are possible:
oracle runs 8 and 9 overlapped in time [V] (see U-804).

Observed outcomes [V] ([operation_runs](../oracle/operation_runs_after_capture.jsonl)):

| Run | Subject | Params | Result |
|---|---|---|---|
| 1-4 | BankConnection 1-4 | `{"connection_id": n}` | succeeded, `summary {"synced_at": ...}` - written by the showcase seeder, not by the job (`app/services/seeders/showcase.rb:276`) |
| 5 | BankConnection 1 | `{}` | succeeded; window 2026-10-14..2026-10-21 (7-day incremental overlap) |
| 7, 12 | BankConnection 1 | `date_from 2026-07-13`, `date_to 2026-10-21` | succeeded, 39 rows skipped (already booked) |
| 8 | BankConnection 1 | `date_from 2026-10-21`, `date_to 2026-07-13` (inverted) | **succeeded** with 0 rows - an inverted window is accepted (see U-805) |
| 9, 13 | User 1 | `{}` (run 9: request asked for another tenant's connection 3) | succeeded |

<a id="cron-auto-sync-dispatcher"></a>
### 4.6 cron:auto_sync_dispatcher

| Field | Value | Evidence |
|---|---|---|
| Entry name | `auto_sync_dispatcher` | `config/schedule.yml:6` |
| Cron | `* * * * *` (every minute; sidekiq-cron evaluates it in the Sidekiq process time zone, UTC in the container) | `config/schedule.yml:7` [I] |
| Job class | `AutoSync::DispatcherJob`, no arguments | `config/schedule.yml:8` |
| Description | `"Scans SyncSchedule.due and dispatches scheduled transaction syncs."` | `config/schedule.yml:9` |
| Registration | `Sidekiq::Cron::Job.load_from_hash!(YAML.load_file("config/schedule.yml"))` inside `Sidekiq.configure_server`, i.e. **only when a Sidekiq server process boots**, never in Puma/console | `config/initializers/sidekiq.rb:3-13` [I] |
| Web UI | the sidekiq-cron web extension is not required, so `/sidekiq` has no Cron tab | `config/routes.rb:1` requires only `sidekiq/web`; [V] dashboard nav "Dashboard Busy Queues Retries Scheduled Dead Metrics" in [oracle UI](../oracle/ui/sidekiq_dashboard.html) |

Real scheduling decisions (which connection, when) live in Postgres (`sync_schedules`), not in cron (`config/schedule.yml:1-5`) [I].
Kotlin: one scheduler trigger per minute in exactly one worker instance (e.g. ShedLock/Quartz cluster lock), calling the dispatcher.

---

## 5. Mailers

<a id="mailer-devise-mailer"></a>
### 5.1 Devise::Mailer

Devise modules enabled on `User`: `database_authenticatable, recoverable, rememberable, validatable` (`app/models/user.rb:2`) [I]. Which of the
Devise mailer actions can actually fire:

| Action | Enabled? | Why | Evidence |
|---|---|---|---|
| `reset_password_instructions` | **yes** | `:recoverable` module; sent on `POST /admin/password` for a known email | [V] `oracle/server.log.txt:185-213`; [V] `spec/requests/public_spec.rb:224` |
| `password_change` | no | `send_password_change_notification` left at default `false` | `config/initializers/devise.rb:134-135` [I] |
| `email_changed` | no | `send_email_changed_notification` default `false` | `config/initializers/devise.rb:131-132` [I] |
| `confirmation_instructions` | no | `:confirmable` not enabled (`reconfirmable = true` is set but has no effect) | `config/initializers/devise.rb:163`, `app/models/user.rb:2` [I] |
| `unlock_instructions` | no | `:lockable` not enabled | `app/models/user.rb:2` [I] |

Observed reset email (development) [V] `oracle/server.log.txt:192-213`:

- `From:` and `Reply-To:` `please-change-me-at-config-initializers-devise@example.com` (from `config.mailer_sender`, `config/initializers/devise.rb:27`; see U-807)
- `Subject: Reset password instructions`, `Content-Type: text/html; charset=UTF-8`
- Body (Devise 5.0.4 built-in template `devise/mailer/reset_password_instructions.html.erb`; the app has no `app/views/devise` overrides):

```
<p>Hello other@example.com!</p>
<p>Someone has requested a link to change your password. You can do this through the link below.</p>
<p><a href="http://localhost:3000/admin/password/edit?reset_password_token=...">Change my password</a></p>
<p>If you didn't request this, please ignore this email.</p>
<p>Your password won't change until you access the link above and create a new one.</p>
```

- Delivery is **synchronous inside the request** (Devise default `deliver_now`; the log shows `Delivered mail` within the `POST /admin/password` request that answered
  303 after 525 ms) [V] `oracle/server.log.txt:192`, `:214`.
- Reset token validity: 6 hours (`config.reset_password_within = 6.hours`, `config/initializers/devise.rb:230`); users are signed in automatically after reset (default) [I].
- Link host: development `localhost:3000` (`config/environments/development.rb:50`); test `example.com` (`config/environments/test.rb:40`); production
  `APP_HOST` split into host and port plus `APP_PROTOCOL` (default `https`) (`config/environments/production.rb:61-67`) [I].
- Transport: production SMTP settings only if `SMTP_ADDRESS` is set (address, port default 587, domain, user name, password, authentication default `plain`,
  STARTTLS default on) (`config/environments/production.rb:73-83`); otherwise Rails' default SMTP to localhost:25 (see U-822). Development
  `raise_delivery_errors = false` (`config/environments/development.rb:44`); test uses the `:test` delivery method (`config/environments/test.rb:37`) [I].
- In development the full email including the raw reset token is written to the log [V] `oracle/server.log.txt:204-209`.

<a id="mailer-applicationmailer"></a>
### 5.2 ApplicationMailer

- `app/mailers/application_mailer.rb:1-4`: `default from: "from@example.com"`, `layout "mailer"`. No subclasses, no actions (`inventory/mailers.json` lists none) [V].
- Layouts exist: `app/views/layouts/mailer.html.erb` (bare HTML wrapper with an empty `<style>`) and `app/views/layouts/mailer.text.erb` (`<%= yield %>`) [I].
- Devise::Mailer does **not** inherit from ApplicationMailer (Devise's `parent_mailer` default is `ActionMailer::Base`, `config/initializers/devise.rb:33`) [I].
- Kotlin: needed only as the base for future mail; currently dead code (see U-807).

---

## 6. External integrations

### 6.1 Enable Banking API (PSD2 aggregator)

| Item | Value | Evidence |
|---|---|---|
| Base URL | `https://api.enablebanking.com` (constant; not configurable by ENV) | `app/services/enable_banking/client.rb:8`, `:12` [I] |
| HTTP client | Faraday 2: JSON request encoding, JSON response parsing when `Content-Type` ends in `json`, default adapter (Net::HTTP) | `client.rb:56-64` [I] |
| Timeouts | open 5 s, read 30 s | `client.rb:9-10`, `:60-61` [I] |
| Auth | `Authorization: Bearer <JWT>`, a fresh JWT for every request | `client.rb:34`, `:52-54` [I] |
| JWT | RS256; header `{typ: "JWT", alg: "RS256", kid: <TppCredential.application_id>}`; payload `{iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600}`; signed with `TppCredential.private_key_pem` (both encrypted at rest) | `app/services/enable_banking/jwt_signer.rb:12-31` [V] `spec/services/enable_banking/jwt_signer_spec.rb:7`, `:22`, `:41`, `:55` |
| Bad key | `EnableBanking::ConfigError "Invalid RSA private key: <msg>"`; operations wrap it as `<Operation>::Failed "Configuration error: <msg>"` | `jwt_signer.rb:35-39`, `app/services/enable_banking/operations/base.rb:11-16` [V] `spec/services/enable_banking/jwt_signer_spec.rb:32` |
| PSU headers | `PSU-IP-Address` from `ENV["PSU_IP_ADDRESS"]` and `PSU-User-Agent` from `ENV["PSU_USER_AGENT"]`, sent only when set (some banks, e.g. mBank, require them). Global per deployment, not per end user | `client.rb:4`, `:35-36` [I] |
| Result mapping | every response becomes `Result{success, status, data, headers, error}`; non-2xx: `error` = `"<error> - <message> - <detail>"` (present parts of a JSON body), or the JSON body, or the text body, or `"HTTP <status>"`. `Faraday::ConnectionFailed`, `TimeoutError`, `SSLError` -> `success: false, status: 0, error: "<ExceptionClass>: <message>"`. No exceptions for HTTP errors | `client.rb:41-50`, `:66-75`, `app/services/enable_banking/result.rb:13-15` [I] |
| Rate limits / 429 | **no special handling**: a 429 is an ordinary failed Result (account marked failed in the run). No retry, no Retry-After handling. Long-term back-off only through the scheduled-sync circuit breaker | grep `429` (none); `app/models/sync_schedule.rb:29-30` [I] |
| Auth-shaped failures | 401/403/410 from `/accounts/{uid}/transactions` trigger a `GET /sessions/{id}` probe (RefreshConnection) that may flip the connection status | `sync_account_transactions.rb:24`, `:104-112` [V] `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:140`, `:156` |

Endpoints used:

| Method + path | Wrapper | Called by | Notes |
|---|---|---|---|
| `GET /application` | `Api::GetApplication` | `Operations::VerifyCredential` (TPP credential "test connection") | health check of JWT + kid (`api/get_application.rb:5-6`) |
| `GET /aspsps?country=XX` | `Api::ListAspsps` | `Admin::BankConnectionsController` (bank picker) | `admin/bank_connections_controller.rb:34-36` |
| `POST /auth` | `Api::StartAuth` | `Operations::StartAuth` (UI connect/reauth, rake `banking:start_auth`) | body `{access: {valid_until: now + valid_days (default 180) in UTC ISO-8601, balances: true, transactions: true}, aspsp: {name, country}, state, redirect_url: credential.redirect_url, psu_type}` (+ optional `auth_method`, `language`) (`api/start_auth.rb:27-43`) |
| `POST /sessions` | `Api::CreateSession` | `Operations::CreateConnection` (OAuth callback, rake `banking:finish_auth`) | body `{code}`; only source of full account data (`api/create_session.rb:5-6`) |
| `GET /sessions/{id}` | `Api::GetSession` | `Operations::RefreshConnection` | lifecycle fields only (`api/get_session.rb:5-8`) |
| `DELETE /sessions/{id}` | `Api::CloseSession` | `Operations::CloseConnection` | best effort (`api/close_session.rb:5`) |
| `GET /accounts/{uid}/details` | `Api::GetAccountDetails` | `Operations::RefreshAccountDetails` | |
| `GET /accounts/{uid}/balances` | `Api::GetAccountBalances` | `Operations::RefreshAccountBalances` | |
| `GET /accounts/{uid}/transactions` | `Api::GetAccountTransactions` | `Operations::SyncAccountTransactions` | query `date_from`, `date_to` (ISO dates), optional `transaction_status`, `continuation_key`; follows `continuation_key` up to 100 pages; returns `transactions`, `pages_fetched`, `truncated` (true when stopped with a continuation key left) (`api/get_account_transactions.rb:12-65`) |

Fakes: the oracle and specs replace the transport with in-memory fakes (`spec/support/fakes/enable_banking_client.rb`), so no real Enable Banking
traffic was observed [V] (BRIEF; `inventory`). The adapter shape is described in `docs/adr/0013-enable-banking-adapter-shape.md`.

### 6.2 OAuth callback from the bank (`GET /callback`)

Inbound redirect from the bank after `POST /auth`, at `/callback` (`config/routes.rb:25`); the path must equal the redirect URL registered at Enable Banking
and stored on the TppCredential (`app/controllers/oauth_callbacks_controller.rb:3-5`) [I]. It requires a signed-in session (anonymous -> sign-in redirect) [V]
[oracle](../oracle/http/GET_callback.json) case anonymous_no_params -> 302 `/admin/sign_in`. The `state` parameter is a Rails `MessageVerifier` token (purpose
`enable_banking:oauth_state`) carrying `user_id, tpp_credential_id, aspsp_name, aspsp_country, psu_type, replaces_connection_id, expires_at (now + 30 min), nonce`
(`app/services/enable_banking/state.rb:7-36`) [V] `spec/services/enable_banking/state_spec.rb:6`, `:30`, `:38`, `:46`, `:52`. Rejections redirect to
`/admin/bank_connections` with these exact alerts (`oauth_callbacks_controller.rb:10-18`) [V] `spec/requests/public_spec.rb:102-170`, oracle cases bank_error_param /
invalid_state / missing_state -> 302:
`"Authorization was cancelled or failed at the bank."`, `"Invalid or expired state. Start the flow again."`, `"State user mismatch."`,
`"Authorization code missing."`, `"TPP credential no longer exists."`, or the `CreateConnection::Failed` message. Success:
redirect to the connection page with `"Bank connected - <bank_name>, <n> account(s)."` [V] `spec/system/oauth_callback_success_spec.rb:16`.
Full endpoint contract: `30-http-api.md`.

### 6.3 LLM providers (via ruby_llm)

| Item | Value | Evidence |
|---|---|---|
| Library | `ruby_llm ~> 1.15`; global config holds **no API keys**: `request_timeout = 60` s, `max_retries = 2` (library-level transport retries) | `Gemfile:43`, `config/initializers/ruby_llm.rb:11-14` [I] |
| Keys | per user, `LlmSetting.api_key` (AR-encrypted), bound per call with `RubyLLM.context` | `app/services/llm/client.rb:35-47`, `app/models/llm_setting.rb:28`; ADR `docs/adr/0012-per-user-llm-credentials.md` [I] |
| Providers / models | `openai` (label "OpenAI", default `gpt-5-mini`; allowed `gpt-5-mini, gpt-5-nano, gpt-5.4-mini, gpt-5.4-nano, gpt-4.1-mini, gpt-4o-mini`); `gemini` (label "Google Gemini", default `gemini-2.5-flash`; allowed `gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash`) | `app/services/llm/providers.rb:7-31` [I] |
| Call shape | `chat(model:).with_instructions(system_prompt).with_schema(json_schema).ask(user_prompt)`; result must be a Hash or a JSON string | `app/services/llm/clients/openai.rb:11-15`, `gemini.rb:7-13` [I] |
| Error mapping | `RubyLLM::Error` -> `Llm::Client::Error "OpenAI API error: <Class>: <msg>"` / `"Gemini API error: ..."`; non-JSON -> `"... returned non-JSON content: ..."`; other shapes -> `"Unexpected response shape from <Provider>: <class>"` | `openai.rb:24-27`, `:43-48`; `gemini.rb:14-28` [V] observed `"OpenAI API error: RubyLLM::UnauthorizedError: Incorrect API key provided: ..."` (oracle run 14) |
| Rate limits | OpenAI only: on `RubyLLM::RateLimitError` sleep and retry up to 4 times; wait = N+1 s parsed from `"retry after Ns"` or `"please try again in N s"`, else 30 s. Gemini has no app-level retry | `openai.rb:6`, `:16-23`, `:33-41` [V] `spec/services/llm/clients/openai_spec.rb:7`, `:36` |
| Not configured | `Llm::Client.for(user:)` raises `NotConfiguredError "User has not configured an LLM provider - see /admin/settings/preferences"` | `client.rb:24-31` [I] |

Data sent to the provider (merchant suggestion, `app/services/llm/merchant_suggester.rb`) [I]:

- System prompt (Polish, fixed text, `:76-192`) plus the list of the user's **active leaf category paths** (`:183`, `:209-214`).
- User prompt: `"Sklasyfikuj poniższe transakcje:\n[ { index: i, title_raw: "...", title_normalized: "...", counterparty_name: "..." }, ... ]"` - `title_normalized`
  only when it differs from the raw title ignoring case, `counterparty_name` only when present (`:194-205`).
- JSON schema `BATCH_SCHEMA` (`:15-39`). No amounts, IBANs or account ids are sent; the raw title **is** sent (the initializer comment says
  "only normalized titles", see U-816).
- The connection test (`POST /admin/settings/preferences/llm/test`, synchronous in the request, run kind `llm_connection_test`) sends the system prompt
  `You are a connectivity probe. Reply with exactly the JSON {"ok": true, "echo": "<the sent_at value from the user message>"}.`, user prompt
  `ping sent_at=<ISO-8601 now>` and a schema requiring `ok` (boolean) and `echo` (string) (`app/services/llm/connection_test_runner.rb:68-83`)
  [V] `spec/services/llm/connection_test_runner_spec.rb:46`, `:74`. It calls `setting.build_client` directly, not `Llm::Client.for`; in the oracle this
  bypassed the LLM fake and produced a real call to OpenAI, which failed with the fake key (run 14 `failed`) [V] [operation_runs](../oracle/operation_runs_after_capture.jsonl).

### 6.4 Third-party assets loaded by browsers at runtime

| Asset | Where | Evidence |
|---|---|---|
| Google Fonts (Inter 300-800) `https://fonts.googleapis.com/css2?...`, preconnect `fonts.gstatic.com` | admin and auth layouts | `app/views/layouts/admin.html.erb:19-21`, `app/views/layouts/admin_auth.html.erb:11-13` [I] |
| jsDelivr ESM: `chart.js@4.5.1`, `chartjs-plugin-datalabels@2.2.0` (importmap pins, preloaded) | analytics charts | `config/importmap.rb:12-13` [I] |
| unpkg `swagger-ui-dist@5` CSS + JS | `/api/:version/docs` | `app/views/swagger/index.html.erb:7`, `:11` [I] |

No Subresource Integrity attributes and no CSP restrict these (see `70-security-and-config.md`) [I].

### 6.5 OpenTelemetry export

The OTel SDK is configured with `service_name = ENV["OTEL_SERVICE_NAME"] || "open-banking-rails"` and `use_all` instrumentations
(`config/initializers/opentelemetry.rb:5-8`); exporter selection and endpoint come from standard `OTEL_*` variables. `.env.example:18-23` points to
`http://localhost:4318` over `http/protobuf` for traces, metrics and logs. The production compose sets no `OTEL_*` variables (`docker-compose.prod.yml:15-32`)
[I] (see U-814). In the oracle run `OTEL_SDK_DISABLED=true`, so the SDK was off (`oracle/server.log.txt:4` "Environment variable OTEL_SDK_DISABLED is defined as true. SDK is disabled.") [V].

### 6.6 ActionCable

Endpoint `/cable` (Rails default mount), served by Puma, Redis adapter in dev/prod (section 2.2). The only channel used is turbo-rails' `Turbo::StreamsChannel`;
the app defines no channels [V] (`oracle/server.log.txt:19601-19602`; no `app/channels` directory).

### 6.7 Webhooks

None. The app exposes no inbound webhook endpoint (the bank redirect `/callback` is a browser redirect, not a server-to-server webhook) and sends no outbound
webhooks (routes in `config/routes.rb`; grep) [I].

---

## 7. Rake tasks

All tasks load the Rails environment and work **across all users** (operator tools; no tenant restriction) [I]. Output goes to stdout. None is scheduled.
Kotlin: CLI commands or admin-only maintenance jobs.

<a id="rake-banking-backfill-counterparty-kind"></a>
### 7.1 banking:backfill_counterparty_kind

`lib/tasks/banking.rake:4-34` [I]. For every user (`find_each`): recompute `counterparty_kind` with `Banking::CounterpartyResolver.for(tx, user:)` for every
BankTransaction and ManualTransaction of that user, and write it with `update_column` (no validations, callbacks or PaperTrail) only when it changed. Prints
`  user=<email>` per user, then `users processed:`, `bank rows updated:`, `manual rows updated:` counts. No ENV vars.

<a id="rake-banking-backfill-payment-methods"></a>
### 7.2 banking:backfill_payment_methods

`lib/tasks/banking.rake:36-100` [I]. ENV `DRY_RUN=1` previews (prints `DRY RUN — no changes will be persisted.`). For each user's BankTransactions (batches of 500):
recompute `payment_method` with `EnableBanking::PaymentMethodInferer.call(type_hint, bank_transaction_code, title, counterparty_name, direction)`; for changed rows
(unless dry run) `update_column(:payment_method)`, then recompute `counterparty_kind` and update it if changed. Users with at least one change get
`Enrichment::TransactionEnricher.rebuild!(user:)`. Prints per-user `payment_method_changes=<n>`, a transitions table
(`<count>  type_hint=<x>  <old> -> <new>`, sorted by count desc), and totals; in dry-run mode `Re-run without DRY_RUN=1 to apply.` when anything would change.

<a id="rake-banking-diagnose-duplicate-accounts"></a>
### 7.3 banking:diagnose_duplicate_accounts

`lib/tasks/duplicate_bank_accounts.rake:13-41` [I]. Read-only. Groups synced BankAccounts with non-blank IBAN by `(tpp_credential_id, iban, currency)` and lists
groups with more than one row (`USER <email>  CREDENTIAL <name> (id=..)`, per account id, first 8 chars of uid, bank/status/connection id, transaction counts,
created date), or prints `No duplicates found.` Background: Enable Banking reissues account UIDs on re-auth (`:3-5`).

<a id="rake-banking-merge-duplicate-accounts"></a>
### 7.4 banking:merge_duplicate_accounts

`lib/tasks/duplicate_bank_accounts.rake:43-110` [I]. ENV `CANONICAL_ID` (required, `abort "CANONICAL_ID=... required (the BankAccount to keep)"`), `DUP_ID`
(required, `"DUP_ID=... required (the BankAccount to drop)"`), `CONFIRM=1` to write (dry run by default, prints `DRY RUN. Re-run with CONFIRM=1 to apply.`).
Refuses (abort) when: same record; canonical has no IBAN; IBAN mismatch; currency mismatch; tpp_credential mismatch; dup is a cash wallet (exact messages at
`:52-57`). In one transaction: delete dup bank transactions whose `external_id` already exists on canonical; re-point the remaining dup bank transactions and
all dup manual transactions to canonical; destroy dup; canonical takes over dup's `uid`, `current_bank_connection_id`, `all_account_ids` (if present),
`account_servicer`, `raw_account_resource` (if present).

<a id="rake-banking-start-auth"></a>
### 7.5 banking:start_auth

`lib/tasks/eb_auth.rake:28-75` [I]. Fallback for the bank-linking flow when the UI OAuth redirect cannot be used. ENV: `USER_EMAIL` (required), `ASPSP`
(required), `COUNTRY` (default `PL`), `PSU_TYPE` (default `personal`), `DAYS` (default `180`, validated by `BankConnectionRequestForm`), `REDIRECT_URL` (in-memory
override of the credential's redirect URL, not saved), `CREDENTIAL_ID` (default: user's primary credential; abort
`"User has no primary TppCredential. Pass CREDENTIAL_ID=... or set a primary."`). Calls `EnableBanking::Operations::StartAuth` (-> `POST /auth`) and prints the
bank URL plus instructions to run `banking:finish_auth CODE=... STATE=...`. Errors: `abort "start_auth failed: <msg>"`; invalid form `abort "Invalid form: ..."`.

<a id="rake-banking-finish-auth"></a>
### 7.6 banking:finish_auth

`lib/tasks/eb_auth.rake:77-107` [I]. ENV `CODE` and `STATE` (both required). Decodes the state (abort `"Invalid or expired state token (TTL is 30 minutes - re-run start_auth)."`),
loads the credential from the state (abort `"TPP credential from state no longer exists."`), calls `EnableBanking::Operations::CreateConnection` (-> `POST /sessions`)
and prints the new connection (id, bank, status, psu_type, valid_until, accounts with uid prefix/IBAN/currency/name). Unlike `/callback`, there is no
check against a signed-in user [I]. Errors: `abort "finish_auth failed: <msg>"`.

<a id="rake-cash-backfill-atm-links"></a>
### 7.7 cash:backfill_atm_links

`lib/tasks/cash.rake:4-40` [I]. For users with `track_cash = true`: run `Cash::AtmWithdrawalLinker.link!` on every BankTransaction with `payment_method = "blik_atm"`
and `direction = "debit"`; counts linked vs no-op per user and in total; if anything was linked, prints a reminder to reconcile cash wallets in the UI. Same
linker as `TransactionSyncJob` step 6 (`app/jobs/transaction_sync_job.rb:63-81`).

Not in scope of the coverage keys but present: `lib/tasks/annotate_rb.rake` (development-only schema annotations, skipped when `ANNOTATERB_SKIP_ON_DB_TASKS` is set) [I].
The "rake-task escape hatch" for password reset mentioned in `config/environments/production.rb:71-72` does not exist (see U-809).

---

## 8. Backup, restore, upgrade

| Tool | Behaviour | Evidence |
|---|---|---|
| `bin/docker-entrypoint` | Container entrypoint for all prod services: creates any missing secrets in `$SECRETS_DIR` and exports them, then runs the command (details in `70-security-and-config.md`) | `bin/docker-entrypoint:16-44` [I] |
| `bin/docker-migrate` | Needs `DATABASE_URL` (else `[migrate] DATABASE_URL not set; aborting`, exit 1). Writes `$BACKUPS_DIR/pre-migration-<UTC yyyymmddTHHMMSSZ>.sql.gz` using `pg_dump --clean --if-exists --no-owner --no-privileges` piped to gzip; if the dump fails (first boot) it logs `pre-migration backup skipped ...`, prints pg_dump stderr and deletes the partial file; then `exec ./bin/rails db:prepare` | `bin/docker-migrate:13-39` [I] |
| `db-backup` service | `prodrigestivill/postgres-backup-local:17`, `SCHEDULE=${BACKUP_SCHEDULE:-@daily}`, keep 7 daily / 4 weekly / 6 monthly (overridable), same pg_dump options, output `./backups` | `docker-compose.prod.yml:123-141` [I] |
| `restore` service (profile `restore`) | `psql` restore of a given `.sql.gz` path, or the newest `*.sql.gz` under `/backups`; error `[restore] no dump found - pass an explicit path or place one under ./backups/` | `docker-compose.prod.yml:143-170` [I] |
| `bin/restore [path]` | stops `app` and `worker`, runs the restore profile, starts `app` and `worker` | `bin/restore:10-35` [I] |
| `bin/upgrade [pull\|build]` | default `pull` (GHCR image) or `build` (local); then `docker compose up -d` (the migrate service backs up and migrates first) and `ps`; usage error exit 2 | `bin/upgrade:11-51` [I] |

Encrypted columns in a dump can only be decrypted with the same `app_secrets` volume (the AR encryption keys), so it must be backed up together with
`./backups/` (`docs/adr/0014-self-hosted-deployment.md` "Consequences") [I].

---

## 9. Observability stack (`docker/`, dev compose profile `observability`)

Opt-in through `docker compose --profile observability up -d` (`docker-compose.yml:1-8`); not part of the production compose [I].

| Component | Image | Configuration | Evidence |
|---|---|---|---|
| OTel Collector | `otel/opentelemetry-collector-contrib:0.148.0`, ports 4317 (gRPC), 4318 (HTTP), 8889 (Prometheus exporter), 13133, 1888, 8888, 55679 | receivers OTLP; pipelines: traces -> batch -> Tempo + debug; traces -> filter (keep only Rack, PG, ActiveJob instrumentation spans) -> `spanmetrics` connector (namespace `app`, histogram buckets 2 ms..10 s, dimensions `http.route`, `http.status_code`, `http.method`, `db.system`, `messaging.destination`, `messaging.active_job.adapter.name`, `exception.type`, exemplars on) -> Prometheus exporter; logs -> batch -> drop severity < INFO -> Loki + debug | `docker/otel/otel-collector-config.yaml:1-104` [I] |
| Tempo | `grafana/tempo:2.10.3` | local storage, block retention 24 h | `docker/tempo/tempo.yaml:1-26` [I] |
| Loki | `grafana/loki:3.6.7` | filesystem tsdb v13, retention 7 d, auth disabled | `docker/loki/loki-config.yaml:1-36` [I] |
| Prometheus | `prom/prometheus:v3.10.0` | scrape every 15 s (collector every 10 s): otel-collector:8889, itself, loki, tempo; retention 7 d / 2 GB; `rule_files: /etc/prometheus/rules/*.yml` | `docker/prometheus/prometheus.yaml:1-34`, `docker-compose.yml:55-71` [I] |
| Alertmanager | `prom/alertmanager:v0.31.1` | single route to receiver `"null"` (alerts go nowhere) | `docker/alertmanager/alertmanager.yaml:1-12` [I] |
| Grafana | `grafana/grafana:12.4.1`, port 3001 | admin/admin, sign-up disabled; datasources Prometheus (default), Tempo (trace-to-logs to Loki), Loki; file dashboard provider (no dashboard JSON files in the repo) | `docker-compose.yml:107-123`, `docker/grafana/provisioning/datasources/datasources.yaml:1-26`, `docker/grafana/provisioning/dashboards/dashboards.yaml:1-10` [I] |

**Alerts defined: none.** `docker/prometheus/rules/alerts.yaml` is an empty (0-byte) file, and Prometheus only loads `*.yml`, so it would be ignored even
if it had content; Alertmanager routes to a null receiver (see U-815) [I].
