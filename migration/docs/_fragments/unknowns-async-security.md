# Unknowns and findings - async-security (U-800..U-849)

Owner docs: `60-async-and-integrations.md`, `70-security-and-config.md`. Paths relative to `/workspace/ruby-service-investigator/src`; oracle links relative to `docs/`.

### U-800 BUG? TransactionSyncJob Sidekiq retries re-run the circuit breaker
- **What is unclear:** When an exception escapes `TransactionSyncJob#perform`, the run is marked failed and the exception is re-raised, so Sidekiq retries up to 3 times. Each retry hits `return if run.terminal?`, but the `ensure` block still calls `AutoSync::CircuitBreaker.observe` for scheduled runs. One failed scheduled run could therefore add up to 4 to `consecutive_failures`, which trips the 24 h pause (threshold 3) after a single incident.
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:10`, `:16`, `:31-36`, `:41-46`; `app/services/auto_sync/circuit_breaker.rb:36-41`; `app/models/sync_schedule.rb:35`. There is no job spec. Specs only cover the breaker in isolation (`spec/services/auto_sync/circuit_breaker_spec.rb:44`, `:57`). Per-account API failures are caught and do not raise, so only "infrastructure" exceptions (DB errors, `RecordNotUnique`, bugs) trigger this.
- **Who/what can resolve:** original author; a spec that raises inside the job with Sidekiq retries enabled.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** In Kotlin, observe the breaker exactly once per run, when it reaches a terminal state, and do not retry runs that are already terminal.

### U-801 Retry policy of LlmEnrichmentJob and TransactionSyncJob is ineffective
- **What is unclear:** Both jobs mark the run failed before re-raising, and both return immediately when the run is terminal. Sidekiq retries (25 for LlmEnrichmentJob, 3 for TransactionSyncJob) therefore never redo the work; they only create noise and, for LlmEnrichmentJob, finally put the job in the Dead set. A `RecordNotFound` for a deleted run is retried 25 times.
- **Evidence for / against:** `app/jobs/llm_enrichment_job.rb:9-10`, `:48-50`; `app/jobs/transaction_sync_job.rb:6-10`, `:15-16`, `:31-33`; `inventory/jobs.json`.
- **Who/what can resolve:** original author.
- **Human question?** yes (intent: should a failed run ever be retried automatically?)
- **Proposed default:** No automatic retry of business work. The user re-queues a new run. Infrastructure-level retry only before the run has started.

### U-802 FailingJob behaviour and whether to keep the debug tooling
- **What is unclear:** The Sidekiq worker log was not captured, so the exact retry sequence of `FailingJob` is not observed. The dashboard about 96 s after the enqueue showed 53 processed, 3 failed, 1 retry, 0 dead. The likely explanation: ActiveJob made 3 attempts (`retry_on ... attempts: 3`, wait 3 s), then Sidekiq retries ran. This is inferred. Also open: whether the dev-only debug page (`/admin/debug*`) and FailingJob should exist in Kotlin at all.
- **Evidence for / against:** `app/jobs/failing_job.rb:6`; `config/routes.rb:33-42`; `oracle/server.log.txt:15708`; [oracle UI](../../oracle/ui/sidekiq_dashboard.html); [oracle](../../oracle/http/POST_admin_debug_enqueue_failing_job.json) -> 204.
- **Who/what can resolve:** run Sidekiq with log capture; product owner on scope.
- **Human question?** yes (scope)
- **Proposed default:** Drop it from the functional scope. If kept, make it a dev-profile-only endpoint that enqueues a job which always throws.

### U-803 BUG? Runs can get stuck in queued/running (no reaper)
- **What is unclear:** The dispatcher and queuers create the run, then enqueue the job after commit. If the enqueue fails (Redis down), the run stays `queued` forever. For scheduled runs the schedule has already advanced to the next slot. If a worker dies mid-job, the run stays `running`. Nothing sweeps stale runs.
- **Evidence for / against:** `app/services/auto_sync/dispatcher.rb:59-79`; `app/services/transaction_syncs/queuer.rb:27-36`; `app/services/llm_enrichments/queuer.rb:32-41`; no sweeper job in `app/jobs` or `config/schedule.yml`.
- **Who/what can resolve:** original author / product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Use a transactional outbox, or enqueue in the same transaction (DB-backed queue), plus a periodic reaper that fails runs stuck longer than N minutes with a clear error.

### U-804 No locking between concurrent syncs of the same account
- **What is unclear:** Two transaction syncs for the same connection/account can run at once (oracle runs 8 and 9 overlapped). If both insert the same new `external_id`, the unique index `(bank_account_id, external_id)` raises `RecordNotUnique`. That exception is not a `SyncAccountTransactions::Failed`, so it escapes and fails the whole run instead of one account.
- **Evidence for / against:** [operation_runs](../../oracle/operation_runs_after_capture.jsonl) runs 8 (started 12:50:56.187) and 9 (started 12:50:56.233, finished 12:50:58.377); `inventory/schema.rb:103`; `app/services/enable_banking/operations/sync_account_transactions.rb:55-77`; `sync_connection_transactions.rb:38`.
- **Who/what can resolve:** original author.
- **Human question?** no
- **Proposed default:** Take a per-account (or per-connection) lock (advisory lock) during sync and use insert-on-conflict-do-nothing semantics.

### U-805 BUG? Inverted sync window accepted
- **What is unclear:** `POST /api/v1/transaction_syncs` with `date_from` after `date_to` is accepted (201), and the run succeeds with 0 rows. Nobody validates the window. Open: is this intended?
- **Evidence for / against:** [oracle](../../oracle/http/POST_api__version_transaction_syncs.json) case date_to_before_from -> 201; run 8 in [operation_runs](../../oracle/operation_runs_after_capture.jsonl) `status: succeeded`, `inserted/updated/skipped 0`; `app/services/transaction_syncs/queuer.rb:7-11`. Compare the analytics endpoint, which raises "from must be <= to" (known finding).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Reject with 400/422 "date_from must be on or before date_to".

### U-806 Unknown/foreign bank_connection_id silently widens the sync to all connections
- **What is unclear:** `TransactionSyncs::Queuer#resolve_subject` falls back to the user when the connection id is not one of the user's active connections. A typo or a foreign id therefore triggers a full user-wide sync instead of an error.
- **Evidence for / against:** `app/services/transaction_syncs/queuer.rb:44-47`; [oracle](../../oracle/http/POST_api__version_transaction_syncs.json) case other_tenant_connection -> 201, run 9 `subject_type: "User"`. There is no data leak.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Return 404 for an id that does not belong to the caller. Fall back to a user-wide sync only when the id is omitted.

### U-807 Mail sender addresses are placeholders and not configurable
- **What is unclear:** Devise mails go out from `please-change-me-at-config-initializers-devise@example.com`, and `ApplicationMailer` defaults to `from@example.com`. No ENV var exists to set a real sender, so production reset mails will likely be rejected or marked as spam.
- **Evidence for / against:** `config/initializers/devise.rb:27`; `app/mailers/application_mailer.rb:2`; `oracle/server.log.txt:194-195`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Add a `MAIL_FROM` setting (default `no-reply@<APP_HOST>`).

### U-808 BUG? No brute-force protection; password reset allows account enumeration
- **What is unclear:** There is no lockout (`lockable` off), no rate limiting (no rack-attack, no `rate_limit`) on sign-in, password reset, setup, API or MCP. Devise paranoid mode is off: an unknown email gets a 422 re-render, a known email a 303 plus an email.
- **Evidence for / against:** `app/models/user.rb:2`; `config/initializers/devise.rb:93`; `Gemfile`; [oracle](../../oracle/http/POST_admin_password.json) cases unknown_email -> 422, known_email -> 303.
- **Who/what can resolve:** product owner / security review.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Kotlin adds per-IP and per-account throttling on auth endpoints and returns the same neutral response for password reset requests.

### U-809 Referenced password-reset "rake-task escape hatch" does not exist
- **What is unclear:** `config/environments/production.rb:71-72` says "password reset has a rake-task escape hatch". No such task is in `lib/tasks` (`inventory/rake_tasks.json`). ADR 0011 instead mentions a "documented `bin/rails runner` one-liner".
- **Evidence for / against:** `lib/tasks/*.rake`; `docs/adr/0011-first-run-setup.md` "Consequences".
- **Who/what can resolve:** original author.
- **Human question?** yes (scope)
- **Proposed default:** Provide an admin CLI command `reset-password --email ...` in Kotlin.

### U-810 BUG? Sidekiq Web is available to every signed-in user
- **What is unclear:** `/sidekiq` is mounted behind `authenticate :user` only. Any tenant can see every queue and job argument and can retry, delete or kill jobs, including those of other tenants.
- **Evidence for / against:** `config/routes.rb:12-14`; [oracle](../../oracle/http/GET_sidekiq.json) case authenticated -> 200 (there is no other-tenant case, but the guard does not distinguish users).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Do not expose a raw queue dashboard in Kotlin, or restrict it to an operator role or a separate port.

### U-811 BUG? /admin/versions exposes all tenants' audit trail (verified)
- **What is unclear:** `Admin::VersionsController` reads `PaperTrail::Version` without any user filter. Other tenants see IBANs, account names, manual-transaction amounts and notes. `raw_balances` appears only as ciphertext because PaperTrail serialises the encrypted value.
- **Evidence for / against:** `app/controllers/admin/versions_controller.rb:5-11`; [oracle](../../oracle/http/GET_admin_versions.json) case other_tenant_sees_all_versions -> 200; [oracle](../../oracle/http/GET_admin_versions__id.json) case other_tenant_reads_main_version -> 200; `oracle/server.log.txt:1719-1766`. Also, `BankAccount` has `has_paper_trail` without `skip: [:raw_balances]` (`app/models/bank_account.rb:71`), which contradicts ADR 0004 "PaperTrail skips them".
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Scope versions to items owned by the current user and exclude encrypted columns from audit payloads.

### U-812 CORS allows any origin on every path
- **What is unclear:** `Rack::Cors` allows origin `*` with all methods for all resources, including the admin HTML. Credentials are not allowed, so cookies are not sent cross-origin, but the intent (API-only? MCP clients in browsers?) is undocumented.
- **Evidence for / against:** `config/initializers/cors.rb:1-6`; [oracle](../../oracle/http/OPTIONS_api__version_merchants.json) -> `access-control-allow-origin: *`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** Allow `*` only for `/api/**` and `/mcp` (bearer-token endpoints) and send no CORS headers elsewhere.

### U-813 No Content-Security-Policy; third-party CDNs loaded at runtime
- **What is unclear:** No CSP is configured. Pages load Google Fonts, jsDelivr (Chart.js) and unpkg (Swagger UI) at runtime without SRI. For a self-hosted finance app this leaks visits to third parties and fails when offline. Open: should Kotlin self-host these assets?
- **Evidence for / against:** `config/initializers/content_security_policy.rb:7-29`; `app/views/layouts/admin.html.erb:19-21`; `config/importmap.rb:12-13`; `app/views/swagger/index.html.erb:7`, `:11`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Self-host fonts and JS and add a strict CSP (`default-src 'self'`).

### U-814 OpenTelemetry defaults in production
- **What is unclear:** The production compose sets no `OTEL_*` variables, so the SDK starts with default OTLP exporters pointing at `localhost:4318` inside the container, where nothing listens. The effect (error log noise, memory) is unobserved: the oracle had the SDK disabled. The observability stack is dev-only.
- **Evidence for / against:** `config/initializers/opentelemetry.rb:5-8`; `docker-compose.prod.yml:15-32`; `oracle/server.log.txt:4`.
- **Who/what can resolve:** running the prod image; product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Telemetry export off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

### U-815 No alerts defined
- **What is unclear:** `docker/prometheus/rules/alerts.yaml` is empty, and Prometheus loads only `rules/*.yml` (a `.yaml` file would be ignored anyway). Alertmanager routes to a `null` receiver. Open: were alerts planned, and which ones?
- **Evidence for / against:** `docker/prometheus/prometheus.yaml:5-6`; `docker/prometheus/rules/alerts.yaml` (0 bytes); `docker/alertmanager/alertmanager.yaml:4-12`.
- **Who/what can resolve:** original author.
- **Human question?** yes (scope)
- **Proposed default:** No alerting in scope. Optionally add a basic HTTP 5xx-rate and job-failure alert.

### U-816 LLM privacy statement vs data actually sent
- **What is unclear:** `config/initializers/ruby_llm.rb:9-10` claims "only normalized titles + counterparty names are ever sent". `MerchantSuggester` actually sends `title_raw`, sometimes `title_normalized`, `counterparty_name`, and the user's whole list of active leaf category paths. No amounts or IBANs are sent. The prompts are Polish. Open: is sending raw titles acceptable, and is the Polish prompt fixed product behaviour?
- **Evidence for / against:** `app/services/llm/merchant_suggester.rb:58-64`, `:76-214`; [operation_runs](../../oracle/operation_runs_after_capture.jsonl) run 10 `request` contains raw titles.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Keep the current payload (raw + normalized title, counterparty name, category paths) and the prompt text verbatim, and correct the documentation.

### U-817 First-run setup is unauthenticated and not race-safe
- **What is unclear:** On a fresh instance, whoever reaches `/setup` first becomes the owner; there is no setup token. `SetupController#create` checks `User.exists?` and then saves without a lock, so two concurrent POSTs with different emails could create two users.
- **Evidence for / against:** `app/controllers/setup_controller.rb:12-25`; `app/controllers/application_controller.rb:9-15`; `docs/adr/0011-first-run-setup.md`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Keep the UX, but serialise creation (advisory lock or single-row guard). Optionally require a one-time setup token printed to the container log.

### U-818 Compatibility with existing Rails-encrypted data
- **What is unclear:** Existing databases hold AR-encryption ciphertext (`{"p","h":{"iv","at"}}`, AES-256-GCM, key derived from `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY` + salt). The Kotlin service must either reproduce Rails' key derivation and envelope format or run a one-time re-encryption migration. Backups, exports and the data-exchange fingerprint depend on these keys.
- **Evidence for / against:** `config/initializers/active_record_encryption.rb:15-24`; encrypted attributes in `inventory/models.json`; `oracle/server.log.txt` raw_balances insert; `app/services/data_exchange/operations/export.rb:94-100`.
- **Who/what can resolve:** migration architect.
- **Human question?** yes (migration choice)
- **Proposed default:** Implement a Rails-compatible decryptor (PBKDF2-SHA256 key derivation, AES-256-GCM, JSON envelope), re-encrypt lazily, and keep the same three ENV secrets.

### U-819 Production compose defaults disable TLS enforcement; no session timeout
- **What is unclear:** Code defaults `FORCE_SSL=true` and `APP_PROTOCOL=https`, but `docker-compose.prod.yml` defaults to `FORCE_SSL=false` and `APP_PROTOCOL=http`. Default deployments therefore send session cookies without `Secure` and without HSTS. Sessions also never time out (no `timeoutable`), and remember-me lasts 2 weeks. Open: are these the intended defaults?
- **Evidence for / against:** `config/environments/production.rb:27-31`, `:66`; `docker-compose.prod.yml:20`, `:22`; `config/initializers/devise.rb:170`, `:194`; `.env.example:31-34`.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Mirror the compose defaults (HTTP behind a user-provided proxy) but document them prominently. Add an idle timeout (for example 30 min, configurable).

### U-820 LLM_MERCHANT_AUTO_APPROVE_THRESHOLD is undocumented and read at class load
- **What is unclear:** The threshold is read once when `Llm::EnrichmentRunner` loads, so changing it needs a restart. It is absent from `.env.example` and compose. `MerchantSuggester::Result#confident?` has its own default of 0.85, but the runner always passes its threshold. Invalid values (`"abc"`) become 0.0, which auto-approves everything.
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:9`, `:101`, `:160`, `:174`; `app/services/llm/merchant_suggester.rb:10-12`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** A validated config property in [0,1], default 0.85; fail at startup when the value is invalid.

### U-821 TransactionSyncJob error message overwritten for unsupported or deleted subjects
- **What is unclear:** For a subject that is neither User, BankConnection nor BankAccount (or was deleted), the job calls `fail!("Unsupported subject: ...")`. `OperationRunFinalizer` then runs on an empty summary and overwrites the error with `"No accounts in scope"`.
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:26-28`, `:119-121`; `app/services/operation_run_finalizer.rb:17`.
- **Who/what can resolve:** original author.
- **Human question?** no
- **Proposed default:** Stop after the unsupported-subject failure and keep that message.

### U-822 BUG? SMTP configuration pitfalls in production
- **What is unclear:** (a) Without `SMTP_ADDRESS`, Rails falls back to SMTP on localhost:25 with the production default `raise_delivery_errors = true`, so `POST /admin/password` would probably answer 500 (not observed). (b) The compose file passes `SMTP_PORT`, `SMTP_AUTHENTICATION` and `SMTP_STARTTLS` as empty strings when unset. `ENV.fetch` returns `""` rather than the default, which gives port 0, authentication `:""` and STARTTLS off when an operator sets only `SMTP_ADDRESS`. Delivery is synchronous in the request.
- **Evidence for / against:** `config/environments/production.rb:55-57`, `:69-83`; `docker-compose.prod.yml:26-32`; synchronous delivery in `oracle/server.log.txt:192-214`.
- **Who/what can resolve:** running the prod image with and without SMTP vars.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Treat empty strings as unset. Send mail asynchronously and do not fail the reset request on SMTP errors (log them instead).
