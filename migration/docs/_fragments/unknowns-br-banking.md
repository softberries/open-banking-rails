### U-200 BUG? Cross-tenant bank account takeover through a global `uid` lookup
- **What is unclear:** When a connection is created, existing accounts are matched with `BankAccount.find_by(uid:)` across all tenants
  before the credential-scoped IBAN+currency fallback. If a second tenant's bank session returns a `uid` that already belongs to
  another tenant's account, that account (and all its transactions) is reassigned to the second tenant's credential and connection.
  Should the Kotlin rebuild scope the uid lookup to the credential (or user)?
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:85-87` (unscoped) vs `:92` (scoped
  fallback). `bank_accounts.uid` is globally unique (`app/models/bank_account.rb:41,66`), so a scoped lookup would turn a takeover into
  a uniqueness error. The investigator observed the takeover while seeding two tenants (BRIEF known findings). No spec covers it.
  Rule BR-076.
- **Who/what can resolve:** product owner / original author. Also decide whether `uid` uniqueness should become `(tpp_credential_id, uid)`.
- **Human question?** yes (bug to keep or fix; data-isolation impact).
- **Proposed default:** Fix it. Match by `uid` only within the same credential, and make uniqueness per credential.

### U-201 BUG? Auto-sync cadences fire one interval late (daily becomes every 2 days)
- **What is unclear:** The dispatcher computes the next slot with `last_dispatched_at = now`. Each tick runs after the slot (cron
  latency plus 0-300 s jitter), so `now + interval` lands a few minutes after the next slot. Snapping then adds one more day:
  daily → 48 h, every_2_days → 72 h, weekly → 8 days. Is this intended?
- **Evidence for / against:** `app/services/auto_sync/dispatcher.rb:70-75`; `app/services/auto_sync/next_run_calculator.rb:44-53`.
  Specs only test `last_dispatched_at` exactly equal to the slot (`spec/services/auto_sync/next_run_calculator_spec.rb:26,35`).
  `spec/system/auto_sync_tick_spec.rb:17` only asserts `next_run_at > now + 12h`. Rule BR-130.
- **Who/what can resolve:** original author; running the dispatcher for two days in a staging environment.
- **Human question?** yes (bug to keep or fix).
- **Proposed default:** Compute the next run from the previous slot (`scheduled_for`) rather than from the dispatch time, so a daily
  schedule fires once per day at `preferred_hour` plus jitter.

### U-202 Schedules always use UTC because users have no time zone
- **What is unclear:** The scheduler asks for `user.timezone` only if the user has one. The `users` table has no such column, so
  `preferred_hour` is an hour in UTC. Users in Poland (UTC+1/+2) get 08:00 UTC = 09:00/10:00 local time. Was a per-user time zone
  planned, or should the default be `Europe/Warsaw`?
- **Evidence for / against:** `app/services/auto_sync/dispatcher.rb:94-96`; `app/services/auto_sync/schedule_upserter.rb:86-88`;
  `app/models/user.rb:5-15`; no `config.time_zone`; the showcase seeder uses `Europe/Warsaw`
  (`app/services/seeders/showcase.rb:52`). Rule BR-131.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent / migration choice).
- **Proposed default:** Add a user time-zone preference (default `Europe/Warsaw`) and interpret `preferred_hour` in it.

### U-203 BUG? Invalid "add bank connection" form returns HTTP 204 with an empty page
- **What is unclear:** On validation failure, `create` sets `flash.now[:alert]` and calls `new`, but nothing renders. Rails falls back
  to `head :no_content`, so the user gets a blank response instead of the form with errors.
- **Evidence for / against:** `app/controllers/admin/bank_connections_controller.rb:47-50`;
  [oracle](../oracle/http/POST_admin_bank_connections.json) case `invalid_blank_aspsp` → 204;
  `../oracle/server.log.txt` line 15001 "No template found for Admin::BankConnectionsController#create, rendering head :no_content".
  No spec covers this path. Rule BR-065.
- **Who/what can resolve:** original author.
- **Human question?** no (clearly a defect).
- **Proposed default:** Re-render the "new" form with HTTP 422 and the alert "<joined validation messages>".

### U-204 Sync schedule is not carried over when a connection is replaced
- **What is unclear:** Re-authorization creates a new connection. The old connection (now `replaced`) keeps its sync schedule, so the
  dispatcher re-pauses the old schedule every 6 hours forever. The new connection has no schedule until the user sets one again.
  Should the schedule move to the new connection?
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:95-106` (no schedule handling);
  `app/services/auto_sync/dispatcher.rb:51-54`; `app/models/bank_connection.rb:53`. Rules BR-080, BR-129.
- **Who/what can resolve:** product owner.
- **Human question?** yes.
- **Proposed default:** On replace, move (re-point) the schedule to the new connection and clear `paused_until` and
  `consecutive_failures`.

### U-205 PKO backfill horizon never applies to connections named "PKO BP"
- **What is unclear:** The horizon table is keyed by slug `pko_bank_polski` (26 months), but connections created from the bank name
  `PKO BP` get slug `pko_bp` and use the 90-day default. What exact ASPSP name does Enable Banking use for PKO?
- **Evidence for / against:** `app/services/enable_banking/backfill_window.rb:6-10`;
  `app/services/enable_banking/operations/create_connection.rb:35`; the oracle shows `bank_slug` `pko_bp`
  ([oracle](../oracle/http/GET_api__version_bank_connections.json)). The repo's own specs also use slug `pko_bp`
  (`spec/system/auto_sync_tick_spec.rb:19`). Rule BR-100.
- **Who/what can resolve:** checking Enable Banking's `/aspsps` list for PKO; original author.
- **Human question?** no.
- **Proposed default:** Key horizons by the actual slug produced from the ASPSP name, and add `pko_bp`.

### U-206 BUG? Sidekiq retry of a failed scheduled sync counts the failure twice
- **What is unclear:** On an unexpected error the job marks the run `failed`, notifies the circuit breaker (in the ensure step) and
  re-raises. The retry (up to 3) finds a terminal run and returns, but the ensure step notifies the breaker again, adding another
  `consecutive_failures`. One bad run can therefore count as 2. The retries also never re-attempt the sync.
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:10,16,31-36,41-46`; `app/services/auto_sync/circuit_breaker.rb:36-41`.
  Rules BR-116, BR-119.
- **Who/what can resolve:** original author; a test with Sidekiq retries.
- **Human question?** no.
- **Proposed default:** Notify the breaker exactly once per run (e.g. when the run transitions to terminal), and drop Sidekiq retries
  for this job.

### U-207 Normalisation and validation errors fail the whole sync run
- **What is unclear:** Only the per-account HTTP failure is isolated. A single malformed transaction aborts the run for all remaining
  accounts: unknown `credit_debit_indicator`, missing id, amount or currency, a lower-case or unknown currency, a missing
  `booking_date`, or an invalid date parameter. Should a bad row be skipped (and logged), or fail only that account?
- **Evidence for / against:** `app/services/enable_banking/transaction_normalizer.rb:24,70,104-105`; `app/models/bank_transaction.rb:70-71`;
  `app/services/enable_banking/operations/sync_connection_transactions.rb:38`; `app/jobs/transaction_sync_job.rb:31-33`. Rule BR-110.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (behaviour choice).
- **Proposed default:** Fail only the affected account with a per-account error, keep processing the other accounts, and log the
  offending payload id.

### U-208 Pending transactions: id changes and disappearing holds
- **What is unclear:** De-duplication is by `(bank_account_id, external_id)`. Some banks give a pending transaction a different id
  once it is booked, which creates a second (booked) row next to the stale pending one. Pending rows that the bank drops (cancelled
  holds) are never removed. Is this acceptable?
- **Evidence for / against:** `app/services/enable_banking/operations/sync_account_transactions.rb:5-10,65-76`; no status filter is
  sent, so most banks return booked rows only (`app/services/enable_banking/api/get_account_transactions.rb:9-10`). Rule BR-103.
- **Who/what can resolve:** original author; real bank data.
- **Human question?** yes.
- **Proposed default:** Keep the current behaviour. Optionally delete local pending rows in the synced window that the bank no longer
  returns.

### U-209 Manual sync silently widens to all connections when the connection id is invalid or foreign
- **What is unclear:** If `bank_connection_id` is blank, unknown, not authorized, or another tenant's, the run's subject becomes the
  user and all of the user's authorized connections are synced, with no error. Is that intended (especially for the API)?
- **Evidence for / against:** `app/services/transaction_syncs/queuer.rb:44-47`;
  [oracle](../oracle/http/POST_api__version_transaction_syncs.json) case `other_tenant_connection` → 201;
  `../oracle/operation_runs_after_capture.jsonl` runs 9 and 13 (`subject_type` `User`). Rules BR-015, BR-115.
- **Who/what can resolve:** product owner.
- **Human question?** yes.
- **Proposed default:** A blank id means "all connections". A non-blank id that is not an authorized connection of the user returns
  404 (API) or an alert (UI).

### U-210 No validation of sync date parameters
- **What is unclear:** `date_from > date_to` is accepted (and the run succeeds with nothing fetched). An unparsable date string makes
  the whole run fail with a date-parsing error. Should requests be validated up front?
- **Evidence for / against:** `app/services/transaction_syncs/queuer.rb:7-11`;
  `app/services/enable_banking/operations/sync_account_transactions.rb:27-28`;
  [oracle](../oracle/http/POST_api__version_transaction_syncs.json) case `date_to_before_from` → 201;
  `../oracle/operation_runs_after_capture.jsonl` run 8 `succeeded`. Rule BR-100.
- **Who/what can resolve:** product owner.
- **Human question?** no.
- **Proposed default:** Validate ISO dates and `date_from <= date_to`, and reject invalid requests (422 / alert).

### U-211 PAT accepted without the `Bearer` scheme
- **What is unclear:** The authenticator strips an optional `Bearer ` prefix, so `Authorization: obrl_…` (no scheme) also
  authenticates. Specs only prove that non-`obrl_` values (e.g. `Basic …`) are rejected.
- **Evidence for / against:** `lib/api/helpers/auth_helper.rb:17-21`; `app/controllers/mcp_controller.rb:20-22`;
  `spec/support/auth_helpers.rb:64`. Rule BR-019.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** Keep it lenient for compatibility with existing clients, and document it.

### U-212 PAT name uniqueness: case-insensitive in the app, case-sensitive in the DB
- **What is unclear:** The application check rejects names that differ only by case. The DB index `(user_id, name)` is
  case-sensitive, so concurrent requests could slip through.
- **Evidence for / against:** `app/models/personal_access_token.rb:21,34-36`. Rule BR-017.
- **Who/what can resolve:** none needed.
- **Human question?** no.
- **Proposed default:** Enforce case-insensitive uniqueness in the DB (index on `lower(name)`).

### U-213 Data import: size cap and counters not as documented
- **What is unclear:** (a) `MAX_BUNDLE_BYTES` (10 MiB) is described as a cap on the decrypted size, but only the encrypted blob is
  checked (against 20 MiB), and the decompressed JSON is never measured. (b) `Result.failed` and `Result.warnings` are never populated,
  so they are always 0 and `[]`.
- **Evidence for / against:** `app/services/data_exchange/operations/import.rb:18,52-54,124-141`; `app/services/data_exchange/result.rb:12-20`.
  Rules BR-154, BR-156.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** Enforce the 10 MiB limit on the decompressed plaintext too, and keep `failed` and `warnings` in the summary
  shape for compatibility.

### U-214 Importing a primary credential next to an existing primary fails the whole import
- **What is unclear:** `primary` is copied on insert. If the bundle contains a credential with `primary = true` under a new
  `(name, provider)` and the user already has a primary credential, validation fails ("Primary another credential is already primary
  for this user") and the whole import rolls back.
- **Evidence for / against:** `app/services/data_exchange/resources/tpp_credential_resource.rb:5-18`;
  `app/models/tpp_credential.rb:73,123-129`; `app/services/data_exchange/operations/import.rb:113-117`. Rule BR-155.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** On insert, set `primary = false` when the user already has a primary credential.

### U-215 Scope of data exchange (no transactions, categories, merchants…)
- **What is unclear:** Only credentials, connections and accounts are exchanged. Bank and manual transactions, categories, merchants,
  rules, enrichments, schedules and LLM settings are not. Is the bundle meant for instance migration (then it is incomplete) or only
  for moving bank wiring?
- **Evidence for / against:** `app/services/data_exchange/registry.rb:9-13`; `app/services/data_exchange/resources/base.rb:78-82`
  (comment mentions Enrichment ownership, suggesting more resources were planned). Rule BR-153.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** Rebuild exactly the three resources and format version 1 so existing bundles stay importable.

### U-216 Connection creation without `access` flags leads to a database error (HTTP 500)
- **What is unclear:** `access_balances` and `access_transactions` are copied from the session payload even when absent (NULL), but
  the columns are NOT NULL. The resulting database error is not a validation error, so it escapes the "Could not save records" handling
  and becomes a 500 on `/callback`.
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:42-43,27-28`;
  `app/models/bank_connection.rb:8-9`. Rule BR-075.
- **Who/what can resolve:** checking Enable Banking's `POST /sessions` contract (whether `access` is always returned).
- **Human question?** no.
- **Proposed default:** Default missing flags to `true` (the column default).

### U-217 Credential deletion may report success without deleting
- **What is unclear:** The controller checks only for bank connections. The model also restricts deletion while bank accounts exist.
  If a credential had accounts but no connections, the destroy fails silently and the UI still shows "Credential deleted.".
- **Evidence for / against:** `app/controllers/admin/tpp_credentials_controller.rb:42-50`; `app/models/tpp_credential.rb:42-43`. Rule BR-054.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** Check the destroy result and show the refusal alert when it fails.

### U-218 "Unsupported subject" error is overwritten
- **What is unclear:** For a run whose subject is neither a user, a connection nor an account (e.g. the subject was deleted), the job
  fails the run with "Unsupported subject: …". The finaliser then runs anyway and overwrites the error with "No accounts in scope".
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:28,119-121`; `app/services/operation_run_finalizer.rb:17`. Rule BR-116.
- **Who/what can resolve:** none needed.
- **Human question?** no.
- **Proposed default:** Stop after the unsupported-subject failure and keep its message.

### U-219 OAuth state payload is readable (signed, not encrypted)
- **What is unclear:** The state token is Base64 JSON plus an HMAC. Anyone who sees the bank redirect URL can read the user id,
  credential id, bank and replaced connection id. Tampering is prevented. Is the disclosure acceptable? Must the Kotlin rebuild accept
  tokens issued by the Ruby app during cut-over (30-minute TTL)?
- **Evidence for / against:** `app/services/enable_banking/state.rb:12-24`;
  [oracle](../oracle/http/POST_admin_bank_connections.json) case `default` (decoded payload in BR-068).
- **Who/what can resolve:** security owner / product owner.
- **Human question?** yes (security / migration choice).
- **Proposed default:** Keep "signed, 30-minute TTL, bound to user and credential". In-flight tokens need not stay compatible: users
  restart the flow.

### U-220 Replaced connection's consent is left open at the provider
- **What is unclear:** When a connection is replaced, the old one is set to `replaced` locally, but `DELETE /sessions/{id}` is not
  called. Closing the connection does call it. Should replacement revoke the old consent?
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:98-100` vs
  `app/services/enable_banking/operations/close_connection.rb:20-26`. Rule BR-080.
- **Who/what can resolve:** product owner.
- **Human question?** yes.
- **Proposed default:** Best-effort close of the old remote session after a successful replacement.

### U-221 Circuit breaker re-trips after a single failure once the cooldown ends
- **What is unclear:** `consecutive_failures` is only reset by a success. After the 24 h pause, the next non-success makes the count 4
  (≥ 3) and pauses again immediately. A `partial` run (some accounts failed) also counts as a failure. Intended?
- **Evidence for / against:** `app/services/auto_sync/circuit_breaker.rb:22-41`. Rule BR-133.
- **Who/what can resolve:** product owner.
- **Human question?** yes.
- **Proposed default:** Keep the current behaviour (conservative).

### U-222 Post-sign-in redirect target
- **What is unclear:** After sign-in, Devise redirects to the last stored protected location. In the oracle this was `/api/v9/docs`,
  a URL captured earlier as anonymous, rather than `/admin`. Should the target be restricted to admin paths?
- **Evidence for / against:** [oracle](../oracle/http/POST_admin_sign_in.json) case `valid_credentials` → 303 `http://127.0.0.1:3000/api/v9/docs`;
  `spec/requests/public_spec.rb:193` expects `/admin` without a stored location. Rule BR-007.
- **Who/what can resolve:** product owner.
- **Human question?** no.
- **Proposed default:** Redirect to the stored location only if it is an internal path, otherwise to `/admin`.

### U-223 Password reset reveals whether an e-mail is registered
- **What is unclear:** Devise paranoid mode is off. An unknown e-mail on `POST /admin/password` returns 422 with a "not found" error,
  while a known e-mail redirects. This allows checking whether an account exists. Intended for a self-hosted single-user app?
- **Evidence for / against:** `config/initializers/devise.rb:93`; [oracle](../oracle/http/POST_admin_password.json) case
  `unknown_email` → 422, case `known_email` → 303. Rule BR-010.
- **Who/what can resolve:** product owner / security owner.
- **Human question?** yes.
- **Proposed default:** Enable paranoid behaviour: always redirect with "If your email address exists in our database, you will
  receive a password recovery link at your email address in a few minutes.".
