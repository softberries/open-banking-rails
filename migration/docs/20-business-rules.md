# 20 — Business rules

> Numbered, testable rules of open-banking-rails at commit `cd3bf60`. Each rule: **Rule**, **Evidence** (`path:line`, repo-relative), **Status**
> **[V]** verified (oracle run or passing spec) / **[I]** inferred from code, **Covered by** (spec id or "untested"), **Oracle** sample where observed.
> Numbering: **BR-001–049** identity, first-run, tenancy, API tokens, preferences · **BR-050–199** banking (Enable Banking), sync, scheduling,
> operation runs, data exchange, rake tasks · **BR-200–299** categories, merchants, rules, enrichment, LLM · **BR-300–399** cash, ledger,
> analytics, money, time, presentation. Gaps in numbering are intentional (reserved). Total rules: **225**.
> Each part ends with a **service catalogue** (one anchored entry per file in `app/services/**` and `app/forms/**`).
> Open questions referenced as U-### are in [unknowns.md](unknowns.md); decisions in [decisions.md](decisions.md).

> **Decisions apply.** Where Phase-4 decisions change behaviour for Kotlin, the [deviation register](decisions.md#deviation-register--where-the-kotlin-expectation-differs-from-the-ruby-oracle) (X-01…X-27) overrides the Ruby behaviour described here; unknowns carry a **Resolution** line ([unknowns.md](unknowns.md)).


## Rule index

| Range | Part | Count |
|---|---|---|
| BR-001–199 | [Part A — Identity, tenancy, banking, sync, operations, data exchange](#part-a--identity-tenancy-banking-sync-operations-data-exchange) | 105 |
| BR-200–299 | [Part B — Categories, merchants, rules, enrichment, LLM](#part-b--categories-merchants-rules-enrichment-llm) | 67 |
| BR-300–399 | [Part C — Cash, ledger, analytics, money, time, presentation](#part-c--cash-ledger-analytics-money-time-presentation-rules) | 53 |

## Part A — Identity, tenancy, banking, sync, operations, data exchange

Conventions used in this part:

- Evidence paths are relative to the source checkout (`src/`). Spec references point at examples in `inventory/specs.json`; the
  real run (`inventory/specs_run.json`) recorded 825 examples and 0 failures, so a cited spec counts as **[V]**.
- Oracle links are relative to `docs/` (e.g. `../oracle/http/...`). Oracle data comes from a development server whose Enable Banking
  adapter is the repo's in-memory fake (`spec/support/fakes/enable_banking_client.rb`).
- **Application time zone:** nothing sets `config.time_zone` (searched `config/`, `app/`, `lib/`), so Rails falls back to **UTC**.
  `Time.current` and `Date.current` therefore run in UTC unless code wraps them in `Time.use_zone`. Only the showcase seeder does that
  (`app/services/seeders/showcase.rb:52`, `Europe/Warsaw`). [I]
- **Money:** amounts are integers in the currency's minor unit ("cents") plus an ISO-4217 code. Bank transactions store the absolute
  value, and `direction` carries the sign (BR-104, BR-111). The default currency for money-rails is PLN
  (`config/initializers/money.rb`). [I]
- In flash strings, a hyphen that looks like a dash is an ASCII hyphen-minus (`-`). Quoted strings are copied byte-for-byte from the code.

---

<a id="br-001"></a>
### BR-001 First-run gate: everything redirects to `/setup` while no user exists
- **Rule:** Every request through the HTML application controller checks whether at least one `User` row exists. If none exists and the
  request path is neither `/setup` nor `/up` (the health check), the response is a redirect to `/setup`. Once any user exists, the
  check passes. This check runs on every request: there is no caching, and the ADR accepts the per-request query. The JSON API (Grape)
  and `/mcp` (`ActionController::API`) do not inherit this filter. [V]
- **Evidence:** `app/controllers/application_controller.rb:5-15`; `docs/adr/0011-first-run-setup.md:15-21,34-35`; `app/controllers/mcp_controller.rb:3`.
- **Status:** [V]
- **Covered by:** `spec/system/first_run_setup_spec.rb:16` (empty-DB visit to root goes to /setup); `spec/system/first_run_setup_spec.rb:97` (deep link to /admin/analytics on fresh DB goes to /setup).
- **Oracle:** `../oracle/capture_log_setup.txt` line 1: `302 GET /admin/analytics [anon/no_users_redirects_to_setup]`.

<a id="br-002"></a>
### BR-002 Setup page is only available while no user exists
- **Rule:** `GET /setup` and `POST /setup` first check whether any user exists. If one does, the request is redirected without changing
  anything: a signed-in visitor goes to `/admin` and a signed-out visitor goes to `/admin/sign_in`. This makes `POST /setup` idempotent
  on the server: a second submission, for example from a stale tab, never creates a second user. If no user exists, `GET` renders the
  form ("Create your admin account") in the `admin_auth` layout. [V]
- **Evidence:** `app/controllers/setup_controller.rb:6-14,33-35`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:6`, `:14`, `:21`, `:67`, `:81`; `spec/system/first_run_setup_spec.rb:42`, `:50`; `spec/system/smoke/auth_spec.rb:30`, `:37`.
- **Oracle:** [oracle](../oracle/http/GET_setup.json) case `no_users` → 200, case `users_exist` → 302 `/admin/sign_in`; [oracle](../oracle/http/POST_setup.json) case `users_exist` → 302 `/admin/sign_in`.

<a id="br-003"></a>
### BR-003 Setup creates the first account, seeds the default taxonomy and signs the user in
- **Rule:** `POST /setup` accepts only `user[name]`, `user[email]`, `user[password]` and `user[password_confirmation]`. The user model's
  validations apply (BR-006). On success the steps run in this order: save the user, run the category seeder (BR-004), run the
  merchant-rule seeder (BR-004), sign the user in, and redirect to `/admin` with notice **"Welcome - your account is ready."**
  (`/admin` then redirects to `/admin/analytics`). On a validation failure the form is re-rendered with HTTP 422, no user is created
  and no seeder runs. The seeders run outside any database transaction, so if a seeder raises, the user remains created. [I] [V]
- **Evidence:** `app/controllers/setup_controller.rb:12-31`; `config/routes.rb:48`; `docs/adr/0011-first-run-setup.md:18-24`.
- **Status:** [V] (except the no-transaction remark, which is [I])
- **Covered by:** `spec/requests/public_spec.rb:29` (creates user, runs both seeders, signs in, notice matches /welcome/i); `spec/system/first_run_setup_spec.rb:25`, `:67` (password confirmation mismatch), `:82` (blank email); `spec/system/first_time_setup_spec.rb:16`, `:40`.
- **Oracle:** [oracle](../oracle/http/POST_setup.json) case `no_users_valid` → 302 `/admin`; case `no_users_invalid` → 422.

<a id="br-004"></a>
### BR-004 Default taxonomy seeded for a new user
- **Rule:** The category seeder upserts 118 category definitions for the user. It is keyed on `(user_id, slug)`, where
  `slug = path with "." replaced by "_"`. Each upsert sets `name`, `kind`, `color` (the palette value of the top-level domain unless the
  definition specifies one), `icon`, `essential` (default false), `path` and `position` (index in the list). Records are never deleted.
  The merchant-rule seeder requires the categories to exist and raises `Missing seeded category at path: <path>` otherwise. It upserts:
  (a) 25 retail merchants, each with one `contains` rule at priority 0; (b) merchant `atm_withdrawal` ("ATM") with an `exact` rule
  `payment_method = blik_atm` at priority 300; (c) merchant `mobile_wallet_topup` ("Top-up (own)") with three `title contains` rules
  ("Google Pay Top-Up by", "Apple Pay Top-Up by", "Top-Up by *") at priority 250. All system rules are case-insensitive and enabled.
  Both seeders are idempotent. The same seeders run from `POST /admin/onboarding/seed_taxonomy`. The detailed taxonomy belongs to the
  category part of this spec.
- **Evidence:** `app/services/seeders/categories.rb:4-6,175-191`; `app/services/seeders/merchant_rules.rb:4,44-49,75-130`.
- **Status:** [V] for idempotency and the ATM rule. The counts (118 / 25) come from counting the definitions [I]. The oracle MCP `categories.list` returned `"count":118` for the main user.
- **Covered by:** `spec/services/seeders/categories_spec.rb:6`, `:18`, `:31`; `spec/services/seeders/merchant_rules_spec.rb:6`, `:24`, `:39`; `spec/requests/onboarding_spec.rb:6`.
- **Oracle:** [oracle](../oracle/http/POST_mcp.json) case `tools_call:categories.list` (`count` 118).

<a id="br-005"></a>
### BR-005 No public registration; further users are created out-of-band
- **Rule:** Devise is mounted under the `/admin` path prefix with registrations skipped, so no sign-up route exists. The first user comes
  from `/setup` (BR-003). Every later user, such as a partner, is created from the Rails console. The data model stays multi-tenant
  (BR-013).
- **Evidence:** `config/routes.rb:4-10`; `docs/adr/0011-first-run-setup.md:19,29-30`.
- **Status:** [I]
- **Covered by:** untested (absence of route).

<a id="br-006"></a>
### BR-006 User account attributes and validation
- **Rule:** A user has `email` (required, unique, matched case-insensitively and stored downcased, surrounding whitespace stripped,
  format `^[^@\s]+@[^@\s]+$`), `password` (6 to 128 characters, confirmation must match; stored as bcrypt with cost 12, or cost 1 in the
  test environment), `name` (required), `track_cash` (default false), `reveal_hidden_categories` (default false). Devise modules:
  database authentication, recoverable, rememberable, validatable. No lockout, no session timeout, no e-mail confirmation.
  `display_name` = name, or e-mail when the name is blank. `initials` = upper-cased first letters of the first two whitespace-separated
  name parts, or `?` when the name is blank.
- **Evidence:** `app/models/user.rb:5-25,96-104`; `config/initializers/devise.rb:61,66,126,184,189`; inventory `schema.rb` (users).
- **Status:** [V] for name presence and the display helpers; [I] for the Devise settings.
- **Covered by:** `spec/requests/settings_spec.rb:26` (blank name → 422); `spec/models/user_spec.rb:88` (initials), `:96` (display_name).

<a id="br-007"></a>
### BR-007 Sign-in
- **Rule:** `GET /admin/sign_in` renders the e-mail/password form in the `admin_auth` layout. `POST /admin/sign_in` (CSRF token
  required): on success the user is redirected to the stored location (the last protected HTML page requested while anonymous) or
  otherwise to `/admin`. Devise's default flash is "Signed in successfully.". On a wrong e-mail or password the form is re-rendered with
  HTTP 422, the password is not echoed, and Devise's message is "Invalid Email or password." (`devise.failure.invalid`, with
  `%{authentication_keys}` = "Email"). A missing CSRF token raises `InvalidAuthenticityToken` (422 in development). There are no
  application overrides of Devise's redirect hooks.
- **Evidence:** `app/controllers/admin/sessions_controller.rb:3-6`; `config/routes.rb:4-10`; `config/locales/devise.en.yml:12,49`; search for `after_sign_in_path_for` found nothing.
- **Status:** [V] (redirect and 422); [I] for the exact message text (not captured).
- **Covered by:** `spec/requests/public_spec.rb:185`, `:193`, `:201`; `spec/system/smoke/auth_spec.rb:43`.
- **Oracle:** [oracle](../oracle/http/POST_admin_sign_in.json) case `wrong_password` → 422, case `missing_csrf_token` → 422, case `valid_credentials` → 303 to a previously stored location (`/api/v9/docs`) (see U-222).

<a id="br-008"></a>
### BR-008 Sign-out
- **Rule:** Sign-out only accepts `DELETE /admin/sign_out`. It destroys the session and expires **all** remember-me tokens of the user
  (`expire_all_remember_me_on_sign_out = true`). Protected pages then redirect to the sign-in page. Devise's flash is "Signed out
  successfully.".
- **Evidence:** `config/initializers/devise.rb:173,272`; `config/locales/devise.en.yml:50-51`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:208`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_sign_out.json) case `signed_in` → 204, case `not_signed_in` → 401. These responses were for a non-browser request format. Browser clients get a redirect, per the spec above.

<a id="br-009"></a>
### BR-009 Remember-me
- **Rule:** The rememberable module is on with Devise defaults: the cookie lasts 2 weeks (`remember_for` is commented out, so the
  default applies). A password change rotates the remember token. The in-app password change re-signs the user in (BR-024).
- **Evidence:** `app/models/user.rb:23`; `config/initializers/devise.rb:170`; `app/controllers/admin/settings/preferences_controller.rb:21-23`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-010"></a>
### BR-010 Password reset request
- **Rule:** `GET /admin/password/new` shows the request form. `POST /admin/password` with a known e-mail sends the Devise
  reset-password e-mail and redirects (303) to `/admin/sign_in` with "You will receive an email with instructions on how to reset your
  password in a few minutes.". Paranoid mode is **off**, so an unknown e-mail re-renders the form with HTTP 422 and a "not found" error,
  which reveals whether an account exists (see U-223). The reset token is valid for **6 hours**. Without SMTP, the README's documented
  fallback is `bin/rails runner "User.first.send_reset_password_instructions"`.
- **Evidence:** `config/initializers/devise.rb:93,230`; `config/locales/devise.en.yml:35`; `README.md:181-186`; `docs/adr/0011-first-run-setup.md:31`.
- **Status:** [V] (status codes and redirect); [I] (message text).
- **Covered by:** `spec/requests/public_spec.rb:217`, `:224`; `spec/system/smoke/auth_spec.rb:49`.
- **Oracle:** [oracle](../oracle/http/POST_admin_password.json) case `known_email` → 303 `/admin/sign_in`, case `unknown_email` → 422.

<a id="br-011"></a>
### BR-011 Password reset completion
- **Rule:** `GET /admin/password/edit?reset_password_token=…` renders the new-password form. The token is not checked at render time:
  a bogus token still gets 200. Without a token parameter the response redirects to `/admin/sign_in` with "You can't access this page
  without coming from a password reset email. If you do come from a password reset email, please make sure you used the full URL
  provided.". `PATCH`/`PUT /admin/password` with an invalid or expired token re-renders with 422. On success, Devise signs the user in
  with "Your password has been changed successfully. You are now signed in.".
- **Evidence:** `app/controllers/admin/passwords_controller.rb:3-6`; `config/locales/devise.en.yml:34,37`.
- **Status:** [V] (statuses); [I] (texts).
- **Covered by:** `spec/requests/public_spec.rb:232`.
- **Oracle:** [oracle](../oracle/http/GET_admin_password_edit.json) case `no_token` → 302 `/admin/sign_in`, case `bogus_token` → 200; [oracle](../oracle/http/PATCH_admin_password.json) case `bogus_token` → 422.

<a id="br-012"></a>
### BR-012 Authentication requirement for the admin UI and the bank callback
- **Rule:** Every `/admin/**` controller (`Admin::BaseController`), the bank callback `/callback` and the Sidekiq web UI (`/sidekiq`)
  require a signed-in session. Anonymous requests are redirected to `/admin/sign_in`. Devise's message is "You need to sign in or sign
  up before continuing.". Because Devise stores the requested GET location, a bank callback that arrives without a session continues
  after sign-in, provided the state token has not expired (BR-068). [I]
- **Evidence:** `app/controllers/admin/base_controller.rb:10`; `app/controllers/oauth_callbacks_controller.rb:7`; `config/routes.rb:12-14`; `config/locales/devise.en.yml:17`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:518`; `spec/requests/public_spec.rb:96`; `spec/system/smoke/auth_spec.rb:12`, `:18`, `:24`; `spec/system/oauth_callback_error_spec.rb:105`.
- **Oracle:** [oracle](../oracle/http/GET_callback.json) case `anonymous_no_params` → 302 `/admin/sign_in`.

<a id="br-013"></a>
### BR-013 Tenancy model and scoping rules
- **Rule:** The schema is shaped for multiple tenants: every domain record belongs to exactly one user, directly or through a parent.
  Every read and write in the UI, the API and MCP must be scoped to the acting user as follows:

  | Record | Ownership path (scope applied) | Evidence |
  |---|---|---|
  | TppCredential | `tpp_credentials.user_id` | `app/controllers/admin/tpp_credentials_controller.rb:66-68` |
  | BankConnection | `bank_connections → tpp_credentials.user_id` (`BankConnection.for_user`) | `app/models/bank_connection.rb:77`; `app/controllers/admin/bank_connections_controller.rb:111-113` |
  | BankAccount (synced) | `bank_accounts.tpp_credential_id → tpp_credentials.user_id` | `app/controllers/admin/bank_accounts_controller.rb:31-36` |
  | BankAccount (cash wallet) | `bank_accounts.manual_owner_id = user.id` (only one of the two ownership columns may be set, BR-090) | `app/models/user.rb:30-31,74-78` |
  | BankTransaction | `bank_transactions → bank_accounts → tpp_credentials.user_id` (`BankTransaction.for_user`) | `app/models/bank_transaction.rb:82` |
  | SyncSchedule | through its BankConnection (looked up with `for_user`) | `app/controllers/admin/sync_schedules_controller.rb:30-32` |
  | OperationRun | `operation_runs.triggered_by_user_id` (scheduled runs also record the connection owner here) | `app/controllers/admin/transaction_syncs_controller.rb:4-5,45-47`; `app/services/auto_sync/dispatcher.rb:64` |
  | PersonalAccessToken | `personal_access_tokens.user_id` | `app/controllers/admin/settings/api_tokens_controller.rb:33` |
  | Categories, merchants, rules, LLM setting, hidden categories | `user_id` | `app/models/user.rb:34-43` |

  An id that exists but belongs to another user is treated exactly like a missing id (BR-014).
- **Evidence:** as listed; `docs/adr/0011-first-run-setup.md:22-24,32-33`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_connection_spec.rb:83`; `spec/models/bank_transaction_spec.rb:83`; `spec/models/user_spec.rb:51`; `spec/requests/banking_spec.rb:6`, `:153`, `:303`, `:390`; `spec/system/cross_user_isolation_spec.rb:16`.

<a id="br-014"></a>
### BR-014 Cross-tenant access yields "not found"
- **Rule:** In the admin UI, requesting another tenant's credential, connection, account, transaction, sync run or schedule raises
  record-not-found, which is HTTP 404. The JSON API returns 404 with its standard envelope. MCP tools return a tool error such as
  `Error: Transaction not found.` with `isError: true`. In no case is the foreign record modified.
- **Evidence:** the scoped finders listed in BR-013.
- **Status:** [V]
- **Covered by:** `spec/support/shared_examples/cross_user_isolation.rb:11`, `:23`; `spec/system/cross_user_isolation_spec.rb:28`, `:38`, `:48`, `:58`, `:83`; `spec/requests/banking_spec.rb:317`, `:379`, `:404`, `:469`; `spec/requests/api/v1/banking_spec.rb:48`, `:98`, `:241`; `spec/requests/mcp/protocol_spec.rb:101`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_bank_connections__id.json) case `other_tenant_id` → 404; [oracle](../oracle/http/POST_mcp.json) case `tools_call:transactions.get:other_tenant` → `Error: Transaction not found.`.

<a id="br-015"></a>
### BR-015 Known tenancy gaps (do not replicate without a decision)
- **Rule:** Three paths break or blur BR-013:
  (1) Bank account matching during connection creation looks up `uid` across **all** tenants, so a second tenant can take over a first
  tenant's account (BR-076, U-200).
  (2) `/admin/versions` and `/admin/versions/:id` read audit versions without tenant scoping. The investigator observed this in oracle
  cases `other_tenant_*`; it is documented in the meta/audit part.
  (3) A manual sync request naming another tenant's connection id does not fail. The request silently becomes a sync of all the
  requester's own connections (BR-115, U-209).
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:85-87`; `app/services/transaction_syncs/queuer.rb:44-47`; BRIEF known findings.
- **Status:** [I] for (1); [V] for (3) via the oracle.
- **Covered by:** untested.
- **Oracle:** [oracle](../oracle/http/POST_api__version_transaction_syncs.json) case `other_tenant_connection` → 201 with `params: {}`; `../oracle/operation_runs_after_capture.jsonl` run id 9 has `subject_type: "User"`.

<a id="br-016"></a>
### BR-016 Personal access token (PAT) format
- **Rule:** Raw token = `"obrl_"` + URL-safe Base64 (no padding) of 32 cryptographically random bytes. That is 5 + 43 = **48
  characters** (body alphabet `A-Z a-z 0-9 - _`). The token never expires and has no scopes: it grants the owner's full API and MCP
  access.
- **Evidence:** `app/models/personal_access_token.rb:28-29`; `app/services/auth/personal_access_token_issuer.rb:25`.
- **Status:** [V]
- **Covered by:** `spec/services/auth/personal_access_token_issuer_spec.rb:30`.

<a id="br-017"></a>
### BR-017 PAT name rules
- **Rule:** The name is required and stripped of surrounding whitespace. After stripping it must be 1 to 50 characters. It must be
  unique per user, compared case-insensitively by the application validation; the DB index on `(user_id, name)` is case-sensitive (see U-212).
  Different users may use the same name. When validation fails, the form is re-rendered with HTTP 422 and an alert containing the
  joined full messages, e.g. "Name can't be blank" or "Name has already been taken". If no message is available, the alert is "Could
  not generate the token.".
- **Evidence:** `app/models/personal_access_token.rb:30,34-36`; `app/services/auth/personal_access_token_issuer.rb:5-9,35-36`; `app/controllers/admin/settings/api_tokens_controller.rb:24-28`.
- **Status:** [V]
- **Covered by:** `spec/models/personal_access_token_spec.rb:40`, `:49`; `spec/services/auth/personal_access_token_issuer_spec.rb:42`, `:51`; `spec/requests/settings_spec.rb:348`, `:363`; `spec/system/personal_access_token_lifecycle_spec.rb:151`.
- **Oracle:** [oracle](../oracle/http/POST_admin_settings_preferences_api_tokens.json) case `invalid_blank_name` → 422.

<a id="br-018"></a>
### BR-018 PAT storage and one-time display
- **Rule:** Only `token_digest` is stored: the lowercase hex SHA-256 of the raw token, unsalted, 64 characters, unique. `last_four` is
  the last 4 characters of the raw token, stored for display. The raw token is never persisted. After creation the raw token travels to
  the next page through the signed and encrypted session flash (`flash[:new_raw_token]`), only for that single redirect. The redirect
  goes to `/admin/settings/preferences/api_tokens` with notice **"Token \"<name>\" generated. Copy it now - it won't be shown again."**.
  Reloading the page no longer shows the token.
- **Evidence:** `app/models/personal_access_token.rb:52-54`; `app/services/auth/personal_access_token_issuer.rb:25-32`; `app/controllers/admin/settings/api_tokens_controller.rb:9,18-23`.
- **Status:** [V]
- **Covered by:** `spec/models/personal_access_token_spec.rb:59`, `:65`, `:30`; `spec/services/auth/personal_access_token_issuer_spec.rb:6`, `:19`; `spec/requests/settings_spec.rb:325`.
- **Oracle:** [oracle](../oracle/http/POST_admin_settings_preferences_api_tokens.json) case `default` → 302.

<a id="br-019"></a>
### BR-019 PAT authentication for the JSON API and MCP
- **Rule:** The bearer value is read from the `Authorization` header by removing a leading, case-insensitive `bearer` followed by
  whitespace. If the header carries no scheme, the whole header value is used (U-211). Authentication succeeds only if the value is a
  string that starts with `obrl_`, its SHA-256 digest matches a token with `revoked_at` NULL, and that token is found. On success,
  `last_used_at` and `updated_at` are set to the current time with a direct column update: no callbacks, no audit version, on every
  authenticated call. Every failure (missing, blank, non-string, wrong prefix, unknown digest, revoked) looks the same to callers.
  JSON API: HTTP 401 `{"message":"Invalid or missing access token."}`. MCP: HTTP 401 `{"error":"Invalid or missing access token."}`.
- **Evidence:** `app/services/auth/personal_access_token_authenticator.rb:4-30`; `app/models/personal_access_token.rb:47-50`; `lib/api/helpers/auth_helper.rb:11-21`; `app/controllers/mcp_controller.rb:19-25`.
- **Status:** [V]
- **Covered by:** `spec/services/auth/personal_access_token_authenticator_spec.rb:6`, `:17`, `:36`, `:48`; `spec/support/auth_helpers.rb:58`, `:64`, `:69`, `:74`; `spec/requests/api/v1/cross_cutting_spec.rb:100`; `spec/requests/mcp/protocol_spec.rb:6`, `:13`, `:20`; `spec/system/personal_access_token_lifecycle_spec.rb:16`, `:91`, `:123`.
- **Oracle:** [oracle](../oracle/http/POST_mcp.json) cases `no_token`, `revoked_token` → 401 `{"error": "Invalid or missing access token."}`.

<a id="br-020"></a>
### BR-020 PAT revoke vs delete (two-step removal)
- **Rule:** `DELETE /admin/settings/preferences/api_tokens/:id` (scoped to the current user) has two outcomes:
  - Active token: sets `revoked_at = now`, keeps the row, notice **"Token \"<name>\" revoked."**.
  - Already-revoked token: hard-deletes the row, notice **"Token \"<name>\" deleted."**.
  
  A revoked token fails authentication immediately (BR-019).
- **Evidence:** `app/controllers/admin/settings/api_tokens_controller.rb:32-44`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:384`, `:399`; `spec/models/personal_access_token_spec.rb:107`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_settings_preferences_api_tokens__id.json) cases `first_delete_revokes`, `second_delete_destroys_revoked` → 302.

<a id="br-021"></a>
### BR-021 PAT listing order
- **Rule:** The token list is ordered by `revoked_at DESC, created_at DESC`. In PostgreSQL, NULLs sort first under `DESC`, so all active
  tokens come first (newest first), followed by revoked tokens (most recently revoked first). The list shows `last_four`, never the
  digest.
- **Evidence:** `app/controllers/admin/settings/api_tokens_controller.rb:7`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:308`, `:299`.

<a id="br-022"></a>
### BR-022 PAT lifetime
- **Rule:** Tokens have no expiry date. Deleting a user deletes all of their tokens.
- **Evidence:** `app/models/personal_access_token.rb:5-25`; `app/models/user.rb:43`.
- **Status:** [V]
- **Covered by:** `spec/models/personal_access_token_spec.rb:120`.

<a id="br-023"></a>
### BR-023 Profile preference
- **Rule:** `PATCH /admin/settings/preferences/profile` accepts only `user[name]`. On success: redirect to the profile page with notice
  **"Profile saved."**. On failure (e.g. a blank name): re-render with 422 and alert = joined full messages.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:10-17,100-102`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:6`, `:15`, `:26`.

<a id="br-024"></a>
### BR-024 Password change from preferences
- **Rule:** `PATCH /admin/settings/preferences/password` takes `current_password`, `password` and `password_confirmation`. The change is
  applied only when `current_password` is correct (Devise `update_with_password`). On success the session is rebound with
  `bypass_sign_in`, so the user stays signed in, and the notice is **"Password changed."**. On failure: re-render the profile page with
  422 and alert = joined full messages. The user stays signed in.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:19-29,104-106`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:36`, `:54`.

<a id="br-025"></a>
### BR-025 App preferences (cash tracking, hidden categories)
- **Rule:** `PATCH /admin/settings/preferences/app` accepts `track_cash`, `reveal_hidden_categories` and `hidden_category_ids[]`. When
  `hidden_category_ids` is absent, it is treated as `[]`, which clears all hidden categories. On success the notice is **"App settings
  saved."**. If `track_cash` switched from false to true in this request, cash tracking is enabled (wallet creation plus linking of
  historical ATM withdrawals, documented in the cash part) and the notice gains the suffix **" Created a <CUR> wallet and linked <N>
  historical ATM withdrawal(s)."**. Switching it off, or saving while it is already on, does not run the enable step. On failure:
  re-render with 422 and the joined messages.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:33-47,108-114`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:70`, `:79`, `:90`, `:106`, `:116`.

<a id="br-026"></a>
### BR-026 Hidden-category semantics
- **Rule:** Hiding a category hides its whole subtree: every category of the user whose `path` is a descendant of (or equal to) a hidden
  category's path. When `reveal_hidden_categories` is true, nothing is hidden. A blank category id is never hidden.
- **Evidence:** `app/models/user.rb:47-66`.
- **Status:** [V]
- **Covered by:** `spec/models/user_spec.rb:27`, `:43`.

<a id="br-027"></a>
### BR-027 "Own identity" sets used for self-transfer detection
- **Rule:** Two normalised sets are derived from all accounts the user owns (synced accounts plus cash wallets):
  - `own_ibans`: primary IBANs plus every `all_account_ids` entry with `scheme_name == "IBAN"` that differs from the primary. All
    whitespace is removed, values are upper-cased, blanks and duplicates dropped.
  - `own_holder_names`: account `name` values, stripped, upper-cased, blanks and duplicates dropped.
  
  These sets drive BR-106.
- **Evidence:** `app/models/user.rb:74-94`; `app/models/bank_account.rb:101-107`.
- **Status:** [V]
- **Covered by:** `spec/models/user_spec.rb:51`, `:65`, `:78`; `spec/models/bank_account_spec.rb:117`.

<a id="br-028"></a>
### BR-028 LLM preference form (cross-reference)
- **Rule:** `PATCH /admin/settings/preferences/llm` saves `provider`, `api_key` and `model`. A blank `api_key` on an existing setting
  keeps the stored key. Notice "LLM settings saved."; failures re-render with 422. `POST …/llm/test` requires a configured setting,
  otherwise it shows alert **"Save a provider and API key first."**. On success the notice is "Connection OK - <provider label>
  (<effective model>)."; on failure the alert is "Test failed: <message>". The provider and client behaviour belong to the LLM part.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:49-83,116-118`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:127`, `:136`, `:149`, `:164`, `:176`, `:186`, `:200`.

---

<a id="br-050"></a>
### BR-050 TPP credential attributes and validation
- **Rule:** A TPP credential (the Enable Banking application registration) has:
  - `name` (required);
  - `provider` (required, only `"enable_banking"`, default);
  - `environment` (blank, `PRODUCTION` or `SANDBOX`);
  - `status` (`pending` default, `active`, `error`);
  - `application_id` (required; used as JWT `kid`);
  - `private_key_pem` (required; RSA private key);
  - `public_cert_pem` (optional);
  - `redirect_url` (required);
  - `primary` (default false);
  - `metadata` (JSON, default `{}`; replaced by the provider's `/application` response on a successful test);
  - `last_verified_at`, `last_verification_error`, `cert_expires_at`.
  
  `application_id` and `private_key_pem` are encrypted at rest (non-deterministic), excluded from audit versions and excluded from
  search/sort allowlists. The UI form permits `name provider environment redirect_url application_id private_key_pem public_cert_pem`.
  The "new" form defaults are provider `enable_banking` and environment `PRODUCTION`. Update success notice: **"Updated."**. A
  validation failure on create or update re-renders with 422.
- **Evidence:** `app/models/tpp_credential.rb:5-24,37-57,62-65`; `app/controllers/admin/tpp_credentials_controller.rb:14-40,70-75`; `docs/adr/0004-encryption-at-rest.md:16-21`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:25`, `:75`; `spec/models/tpp_credential_spec.rb:126`, `:137`.
- **Oracle:** [oracle](../oracle/http/POST_admin_tpp_credentials.json) case `invalid_blank_name` → 422, case `default` → 302 to the new credential.

<a id="br-051"></a>
### BR-051 First credential becomes primary automatically
- **Rule:** On `POST /admin/tpp_credentials`, if the user had no credentials before, the new credential is saved with `primary = true`.
  Later credentials are not primary. Success redirects to the credential page with notice **"TPP credential created. Run \"Test
  connection\" to verify it works."**.
- **Evidence:** `app/controllers/admin/tpp_credentials_controller.rb:18-29`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:35`, `:55`.

<a id="br-052"></a>
### BR-052 Exactly one primary credential per user
- **Rule:** At most one credential per user may have `primary = true`. This is enforced by a partial unique DB index
  (`index_one_primary_tpp_credential_per_user`, `WHERE primary = true`) and an application validation with error **"another credential
  is already primary for this user"** on `primary`. The full message reads "Primary another credential is already primary for this
  user". "Make primary" runs atomically in one transaction: set `primary = false` on all the user's other credentials, then set
  `primary = true` on this one. Notice: **"<name> is now the primary credential."**. Starting a bank connection always uses the primary
  credential (BR-066).
- **Evidence:** `app/models/tpp_credential.rb:27,71-73,105-110,123-129`; `app/controllers/admin/tpp_credentials_controller.rb:58-62`; `app/models/user.rb:68-70`.
- **Status:** [V]
- **Covered by:** `spec/models/tpp_credential_spec.rb:104`, `:116`; `spec/requests/banking_spec.rb:140`; `spec/requests/api/v1/banking_spec.rb:199`.
- **Oracle:** [oracle](../oracle/http/POST_admin_tpp_credentials__id_make_primary.json) case `default` → 302.

<a id="br-053"></a>
### BR-053 Certificate metadata
- **Rule:** On every save, `cert_expires_at` is set to the X.509 `not_after` of `public_cert_pem`. If the PEM is blank or cannot be
  parsed, it is set to NULL without raising. Derived values:
  - `cert_expired?` = `cert_expires_at < now`.
  - `cert_expiring_soon?` = `cert_expires_at < now + 30 days` (default window).
  - `cert_info` = subject, issuer, not_before, not_after, `days_remaining` (whole days until not_after, truncated toward zero), serial,
    signature algorithm, RSA key size in bits (nil for non-RSA keys).
- **Evidence:** `app/models/tpp_credential.rb:55,79-103,114-121`.
- **Status:** [V]
- **Covered by:** `spec/models/tpp_credential_spec.rb:53`, `:62`, `:70`, `:77`, `:92`, `:98`.

<a id="br-054"></a>
### BR-054 Credential deletion
- **Rule:** If the credential still has any bank connection (any status), deletion is refused. The user is redirected to the credential
  with alert **"Cannot delete - credential has bank connections. Remove them first."**. Otherwise the credential is destroyed and the
  user is redirected to the list with notice **"Credential deleted."**. The model also restricts deletion while bank accounts reference
  the credential; in that case the destroy silently fails but the notice is still shown (U-217). Closed connections are kept, not
  deleted (BR-087), so in practice a credential that has ever been connected cannot be deleted.
- **Evidence:** `app/controllers/admin/tpp_credentials_controller.rb:42-50`; `app/models/tpp_credential.rb:42-43`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:87`, `:100`; `spec/requests/api/v1/banking_spec.rb:174`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_tpp_credentials__id.json) case `default` → 302 `/admin/tpp_credentials`.

<a id="br-055"></a>
### BR-055 Test connection (credential verification) and redirect URL reconciliation
- **Rule:** "Test connection" calls `GET /application` on Enable Banking with a JWT signed by the credential (BR-060). The calling code
  never sees an exception; every outcome comes back as a result:

  | Outcome | Persisted changes | Result status | Message (exact) |
  |---|---|---|---|
  | HTTP failure (non-2xx or transport) | `status = "error"`, `last_verification_error = "HTTP <status>: <error>"` | failed | `Test failed: <error_message>` |
  | Key or config error (e.g. invalid RSA key) | `status = "error"`, `last_verification_error = <exception message>` | failed | `Configuration error: <message>` |
  | Success, `redirect_urls` empty or containing our URL | `status = "active"`, `last_verified_at = now`, `last_verification_error = NULL`, `metadata = response body` | ok | `Connection verified - metadata refreshed.` |
  | Success, exactly one registered URL that differs from ours | as above, plus `redirect_url := that URL` | ok | `Connection verified - metadata refreshed. Local redirect_url updated to match EB: <url>` |
  | Success, several registered URLs, ours not among them | as in row 3 (redirect_url unchanged) | warning | `Connection verified - metadata refreshed. ⚠ Local redirect_url (<ours>) is NOT in EB list. Choose one of: <url1>, <url2>` |

  `<error_message>` = the provider error text, or `HTTP <status>` when there is none (BR-062). In the UI, failed results show as a
  flash **alert**; ok and warning results show as a **notice**. Either way the user is redirected to the credential page.
- **Evidence:** `app/services/enable_banking/operations/verify_credential.rb:24-84`; `app/services/enable_banking/api/get_application.rb:5-14`; `app/controllers/admin/tpp_credentials_controller.rb:52-56`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/verify_credential_spec.rb:6`, `:20`, `:32`, `:47`, `:60`, `:74`; `spec/requests/banking_spec.rb:111`, `:126`; `spec/requests/api/v1/banking_spec.rb:186`.
- **Oracle:** [oracle](../oracle/http/POST_admin_tpp_credentials__id_test_connection.json) case `default` → 302; [oracle](../oracle/http/POST_api__version_tpp_credentials__id_test_connection.json) case `default` → 201 with `"status": "active"`.

<a id="br-060"></a>
### BR-060 JWT used to call the Enable Banking API
- **Rule:** **Every** HTTP request to Enable Banking carries a freshly signed JWT: `Authorization: Bearer <jwt>`. The JWT has:
  - header `{"typ":"JWT","alg":"RS256","kid":<credential.application_id>}`;
  - payload `{"iss":"enablebanking.com","aud":"api.enablebanking.com","iat":<now unix seconds>,"exp":<iat + 3600>}`;
  - an RS256 signature made with the credential's `private_key_pem`.
  
  The lifetime is 1 hour; the provider allows at most 24 hours. If the PEM is not a valid RSA key, a configuration error is raised:
  `Invalid RSA private key: <openssl message>`.
- **Evidence:** `app/services/enable_banking/jwt_signer.rb:4-40`; `app/services/enable_banking/client.rb:34,52-54`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/jwt_signer_spec.rb:7`, `:22`, `:32`, `:41`, `:55`; `spec/services/enable_banking/adapter_spec.rb:10`.

<a id="br-061"></a>
### BR-061 Enable Banking HTTP transport
- **Rule:**
  - Base URL: `https://api.enablebanking.com`.
  - Connection open timeout: 5 s. Read timeout: 30 s.
  - Request bodies are JSON (`Content-Type: application/json`). Responses whose media type ends in `json` are parsed as JSON.
  - Optional PSU headers: if the `PSU_IP_ADDRESS` env var is non-blank, every request sends `PSU-IP-Address: <value>`. Likewise
    `PSU_USER_AGENT` gives `PSU-User-Agent: <value>`. Unset or blank variables omit the header. Some banks, such as mBank, require them.
  - Query parameters are added only when present.
  - There is no retry at the transport level.
- **Evidence:** `app/services/enable_banking/client.rb:4-64`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/adapter_spec.rb:10`, `:23`, `:97`, `:114`.

<a id="br-062"></a>
### BR-062 Result and error mapping for provider calls
- **Rule:** The transport never raises for HTTP errors. Every call returns `{success, status, data, headers, error}` where
  `success` = 2xx.
  - Non-2xx with a JSON object body: `error` = the non-blank values of `error`, `message` and `detail`, joined with `" - "`. If all
    three are blank, `error` = the JSON-serialised body.
  - Non-2xx with a non-object body: `error` = the body text, or `"HTTP <status>"` when the body is empty.
  - Connection failure, timeout or TLS failure: `success = false`, `status = 0`, `data = nil`, and
    `error = "<ExceptionShortName>: <message>"` (e.g. `ConnectionFailed: …`, `TimeoutError: …`, `SSLError: …`).
  
  `error_message` = `error` if present, else `"HTTP <status>"`.
- **Evidence:** `app/services/enable_banking/client.rb:41-50,66-75`; `app/services/enable_banking/result.rb:4-20`; `docs/adr/0013-enable-banking-adapter-shape.md:21-30`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/adapter_spec.rb:38`, `:50`, `:62`, `:73`, `:85`.

<a id="br-063"></a>
### BR-063 Configuration errors become operation failures
- **Rule:** Every banking operation (start auth, create connection, refresh, sync, close, verify) converts a configuration or key error
  raised during the call into that operation's own failure, with message `"Configuration error: <message>"`. The controllers rescue
  these failures. HTTP non-2xx responses are handled per operation as described in each rule.
- **Evidence:** `app/services/enable_banking/operations/base.rb:5-16`; `app/services/enable_banking/error.rb:3-7`; `docs/adr/0013-enable-banking-adapter-shape.md:27-29`.
- **Status:** [V] (via verify: `spec/services/enable_banking/operations/verify_credential_spec.rb:60`); [I] for the other operations.
- **Covered by:** `spec/services/enable_banking/operations/verify_credential_spec.rb:60`.

<a id="br-065"></a>
### BR-065 Bank connection request form
- **Rule:** Fields and defaults:
  - `aspsp_name`: required (the bank name exactly as Enable Banking lists it).
  - `aspsp_country`: required, default `"PL"`.
  - `psu_type`: `personal` (default) or `business`.
  - `valid_days`: integer, `> 0` and `<= 180`, default 180.
  
  On `GET /admin/bank_connections/new`, the query params `aspsp_name`, `aspsp_country` (blank becomes `PL`), `psu_type` (blank becomes
  `personal`) and `replaces` pre-fill the form. `replaces` is kept only if it is a non-zero integer id of a connection owned by the
  current user; otherwise it is ignored.
  When `POST` validation fails, the code sets `flash.now[:alert]` to the joined messages (e.g. "Aspsp name can't be blank") and re-runs
  the `new` action. Because no template is rendered explicitly, the observed response is **HTTP 204 with an empty body** (U-203).
- **Evidence:** `app/forms/bank_connection_request_form.rb:3-16`; `app/controllers/admin/bank_connections_controller.rb:26-50,88-97`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:212` (foreign `replaces` ignored); the invalid-form path is untested.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_connections.json) case `invalid_blank_aspsp` → 204 (`server.log.txt` line 15001: "No template found for Admin::BankConnectionsController#create, rendering head :no_content").

<a id="br-066"></a>
### BR-066 Preconditions for connecting a bank; bank list
- **Rule:**
  - "New" and "create" require the user to have a primary credential. Otherwise: redirect to `/admin/tpp_credentials` with alert
    **"Configure a primary TPP credential before connecting banks."**.
  - The "new" page fetches the bank list with `GET /aspsps?country=<aspsp_country>` and shows `aspsps` sorted by name,
    case-insensitively.
  - If that call fails: redirect to `/admin/bank_connections` with alert **"Couldn't load bank list: <error>"**. `<error>` is the raw
    error and may be empty.
- **Evidence:** `app/controllers/admin/bank_connections_controller.rb:6,34-40,103-109`; `app/services/enable_banking/api/list_aspsps.rb:11-15`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:172`, `:182`, `:199`.
- **Oracle:** [oracle](../oracle/http/GET_admin_bank_connections_new.json) cases `default`, `with_aspsp` → 200.

<a id="br-067"></a>
### BR-067 Starting bank authorization
- **Rule:** On a valid form, `POST /auth` is sent to Enable Banking with this body:

  ```json
  {"access": {"valid_until": "<now + valid_days days, UTC, ISO-8601 to the second, e.g. 2027-04-19T12:52:04Z>",
              "balances": true, "transactions": true},
   "aspsp": {"name": "<aspsp_name>", "country": "<aspsp_country>"},
   "state": "<signed state token, BR-068>",
   "redirect_url": "<primary credential.redirect_url>",
   "psu_type": "<psu_type>"}
  ```

  `auth_method` and `language` are never sent from the UI. If the call succeeds and returns a non-blank `url`, the browser is
  redirected to that URL with **HTTP 303** (off-host allowed). Otherwise the request fails with message
  **"Failed to start auth: <error_message>"**, shown as an alert after redirecting to `/admin/bank_connections/new`. Banks may grant a
  shorter consent than requested (mBank caps at 90 days).
- **Evidence:** `app/services/enable_banking/api/start_auth.rb:8-43`; `app/services/enable_banking/operations/start_auth.rb:15-29`; `app/controllers/admin/bank_connections_controller.rb:52-61`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/start_auth_spec.rb:8`, `:23`, `:34`; `spec/requests/banking_spec.rb:227`, `:243`.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_connections.json) case `default` → 303 to `https://fake.enablebanking.test/auth?state=…`.

<a id="br-068"></a>
### BR-068 OAuth state token: encoding, signing, expiry
- **Rule:** The state token is a signed (**not encrypted**) message:
  - Payload JSON:
    `{"user_id":<int>,"tpp_credential_id":<int>,"aspsp_name":<str>,"aspsp_country":<str>,"psu_type":<str>,"replaces_connection_id":<int|null>,"expires_at":<unix seconds = now + 1800>,"nonce":<16 lowercase hex chars>}`.
  - Wire format: `Base64(payload JSON) + "--" + hex HMAC`. The HMAC key is derived from the application secret with purpose
    `"enable_banking:oauth_state"`. The observed signature is 40 hex characters, i.e. HMAC-SHA1.
  - The nonce makes every token unique.
  - Decoding returns "invalid" (nil) in these cases: the token is blank; the signature fails; the token was signed under another
    purpose; the payload is malformed; or `expires_at < now` (TTL **30 minutes**).
  - The payload (user id, credential id, bank) can be read by anyone who sees the URL (U-219).
  - Tokens are bound to the session user and the credential at callback time (BR-069).
- **Evidence:** `app/services/enable_banking/state.rb:4-36`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/state_spec.rb:6`, `:30`, `:38`, `:46`, `:52`, `:60`.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_connections.json) case `default`: the location's `state` decodes to
  `{"user_id":1,"tpp_credential_id":1,"aspsp_name":"PKO BP","aspsp_country":"PL","psu_type":"personal","replaces_connection_id":null,"expires_at":1792588924,"nonce":"7467fee940ef01f1"}`.
  `expires_at` is 2026-10-21T13:22:04Z, exactly 30 minutes after capture.

<a id="br-069"></a>
### BR-069 Bank callback (`GET /callback`) outcomes
- **Rule:** The bank redirects the user's browser to `credential.redirect_url`, which must be the `/callback` route, with `code` and
  `state` (or `error`). Checks run in this order and the first failing one wins. Each failure redirects to `/admin/bank_connections`
  with the exact alert shown:

  | # | Condition | Alert |
  |---|---|---|
  | 0 | not signed in | redirect to `/admin/sign_in` (BR-012) |
  | 1 | `error` param present (any value) | `Authorization was cancelled or failed at the bank.` |
  | 2 | `state` missing, invalid or expired (BR-068) | `Invalid or expired state. Start the flow again.` |
  | 3 | `state.user_id` ≠ signed-in user id | `State user mismatch.` |
  | 4 | `code` blank | `Authorization code missing.` |
  | 5 | credential `state.tpp_credential_id` not found **among the current user's credentials** | `TPP credential no longer exists.` |
  | 6 | connection creation fails (BR-075) | the failure message verbatim (e.g. `Could not create session: <error_message>`) |

  No connection is created in cases 0 to 6. On success: redirect to the new connection page (BR-070).
- **Evidence:** `app/controllers/oauth_callbacks_controller.rb:3-36`; `config/routes.rb:23-25`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:96`, `:102`, `:110`, `:119`, `:129`, `:138`, `:150`, `:170`; `spec/system/oauth_callback_error_spec.rb:16`, `:28`, `:40`, `:64`, `:83`, `:105`; `spec/system/oauth_callback_success_spec.rb:51`, `:72`, `:84`; `spec/system/connection_expiry_reauth_spec.rb:68`, `:94`.
- **Oracle:** [oracle](../oracle/http/GET_callback.json) cases `bank_error_param`, `invalid_state`, `missing_state` → 302 `/admin/bank_connections`; case `anonymous_no_params` → 302 `/admin/sign_in`.

<a id="br-070"></a>
### BR-070 Callback success message
- **Rule:** After a successful connection creation, the user is redirected to `/admin/bank_connections/<new id>` with notice
  **"Bank connected - <bank_name>, <N> account(s)."**. `N` is the number of accounts whose current connection is the new one.
- **Evidence:** `app/controllers/oauth_callbacks_controller.rb:26-27`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:150` (notice matches /PKO BP/); `spec/system/oauth_callback_success_spec.rb:16`; `spec/system/first_time_setup_spec.rb:55`.

<a id="br-075"></a>
### BR-075 Connection creation from the authorization code
- **Rule:** `POST /sessions {"code": <code>}` is sent with the credential's JWT. If it fails, creation fails with
  **"Could not create session: <error_message>"**. On success, everything below happens in **one DB transaction**: create the
  connection (fields below), upsert the accounts (BR-076, BR-077), and mark the replaced connection (BR-079).

  | Connection field | Value |
  |---|---|
  | `tpp_credential_id` | the credential from the state |
  | `bank_slug` | `state.aspsp_name` lower-cased, every run of non-alphanumerics replaced by `_`, trimmed (e.g. `"PKO BP"` → `pko_bp`, `"mBank"` → `mbank`) |
  | `bank_country` | `state.aspsp_country`, else payload `aspsp.country` |
  | `bank_name` | payload `aspsp.name`, else `state.aspsp_name` |
  | `status` | `"authorized"` |
  | `psu_type` | payload `psu_type`, else `state.psu_type` |
  | `session_id`, `psu_id_hash` | payload values (encrypted at rest) |
  | `access_balances`, `access_transactions`, `valid_until` | payload `access.balances`, `access.transactions`, `access.valid_until` |
  | `authorized_at` | payload `authorized`, else now |
  | `raw_session_payload` | full payload as JSON text (encrypted at rest) |
  | `replaces_id` | the connection being replaced, or NULL |

  A validation failure on any record aborts the transaction with **"Could not save records: <validation message>"**. A payload
  without `access` flags causes a database error instead, which surfaces as HTTP 500 (see U-216).
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:16-49`; `app/services/enable_banking/api/create_session.rb:5-15`; `app/models/bank_connection.rb:55`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/create_connection_spec.rb:6`, `:29`; `spec/system/oauth_callback_success_spec.rb:16`.
- **Oracle:** [oracle](../oracle/http/GET_api__version_bank_connections.json) case `default` (`bank_slug` `pko_bp` for `PKO BP`).

<a id="br-076"></a>
### BR-076 Account matching on connection creation (uid, then IBAN+currency)
- **Rule:** The provider re-issues account `uid`s on every new session. For each entry in payload `accounts` that is an object with a
  non-blank `uid`:
  - (1) Look up an existing account by `uid` across **all** accounts in the database, ignoring user and credential.
  - (2) Otherwise, if the entry has a non-blank `account_id.iban`, look up a synced (non-cash) account **under the same credential**
    with the same `iban` and the same `currency`.
  - (3) Otherwise create a new account.
  
  Currency is part of the key because multi-currency products (e.g. EUR and USD pockets) share one IBAN but are separate accounts.
  **Cross-tenant defect:** step (1) is not scoped. If another tenant's account already has the same `uid`, it is reassigned to this
  credential: the update sets `tpp_credential_id` and `current_bank_connection_id`, and its whole transaction history moves to the new
  tenant (U-200). A Kotlin implementation should scope step (1) to the credential (pending a decision on U-200). `uid` is globally
  unique in the DB.
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:51-58,79-93`; `app/models/bank_account.rb:41,66`; BRIEF known finding.
- **Status:** [V] (IBAN fallback is implemented, matching per `create_connection_spec`); [I] (cross-tenant takeover, from code; reported by the investigator while seeding).
- **Covered by:** `spec/services/enable_banking/operations/create_connection_spec.rb:6`, `:40`; cross-tenant case untested.

<a id="br-077"></a>
### BR-077 Account fields written on connection creation
- **Rule:** For each matched or new account:
  - Always set: `uid`, `tpp_credential` = this credential, `current_bank_connection` = the new connection,
    `iban` = `account_id.iban`, `bban` = `account_id.other.identification` when `account_id.other.scheme_name == "BBAN"` (else nil),
    `all_account_ids` (default `[]`), `currency`, `status = "active"`, `raw_account_resource` = the entry as JSON.
  - Keep the old value when the payload value is blank or null: `name` (kept when blank), `product`, `details`, `cash_account_type`,
    `usage`, `account_servicer`.
  - `iban`, `bban` and `currency` are overwritten even when null.
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:55-73`; `app/models/bank_account.rb:125-129`.
- **Status:** [V] (creation path); [I] (preservation details).
- **Covered by:** `spec/services/enable_banking/operations/create_connection_spec.rb:6`; `spec/models/bank_account_spec.rb:131`.

<a id="br-078"></a>
### BR-078 Own-account merchant rules refreshed after account changes
- **Rule:** After saving each account (on connection creation and on details refresh, BR-091), the own-account merchant syncer runs for
  that account. It maintains rules that classify transfers to the user's own IBANs; details are in the enrichment part.
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:75`; `app/services/enable_banking/operations/refresh_account_details.rb:37-39`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/refresh_account_details_spec.rb:41`.

<a id="br-079"></a>
### BR-079 Re-authorization and replacement
- **Rule:** "Re-authorize" (`POST /admin/bank_connections/:id/reauth`) redirects to `/admin/bank_connections/new` with the old
  connection's `aspsp_name` (= `bank_name`), `aspsp_country` (= `bank_country`), `psu_type`, and `replaces=<id>`. The notice is
  **"Re-authorize via the bank - the old connection will be marked as replaced when the new one is approved."**.
  The replaced id travels in the state token. When the callback creates the new connection:
  - the old connection (looked up within the same credential) gets `status = "replaced"` and `closed_at = now`;
  - the new connection gets `replaces_id = old.id`;
  - accounts returned again are re-attached through BR-076;
  - the old record is kept for audit.
  
  If the user cancels at the bank, the old connection is untouched (BR-069 #1).
- **Evidence:** `app/controllers/admin/bank_connections_controller.rb:77-84`; `app/services/enable_banking/operations/create_connection.rb:95-106`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:288`; `spec/services/enable_banking/operations/create_connection_spec.rb:40`; `spec/system/connection_expiry_reauth_spec.rb:16`, `:68`.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_connections__id_reauth.json) case `default` → 302 `/admin/bank_connections/new?aspsp_country=PL&aspsp_name=PKO+BP&psu_type=personal&replaces=1`.

<a id="br-080"></a>
### BR-080 Side effects that replacement does NOT perform
- **Rule:**
  - Accounts missing from the new session keep their old `current_bank_connection_id`. They look stale in the UI and stop syncing,
    because user-level sync covers only authorized connections (BR-109), but their history is kept.
  - The old connection's remote session is **not** closed at the provider (U-220).
  - The old connection's sync schedule is **not** moved to the new connection (U-204).
  - The replaced id is dropped when it belongs to another credential of the same user.
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:95-106`; `app/models/bank_connection.rb:53`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-085"></a>
### BR-085 Connection statuses and expiry helpers
- **Rule:**
  - Statuses: `pending` (DB default), `authorized`, `expired`, `revoked`, `replaced`, `error`, `closed`. Only `authorized` counts as
    "active".
  - `expired?` = `valid_until < now`.
  - `expiring_soon?` = `valid_until < now + 7 days`.
  - `days_until_expiry` = whole days to `valid_until`, truncated toward zero (nil when blank).
  - `expiring_within(d)` = authorized connections with `valid_until <= now + d`.
  - Tone used by the UI: authorized → success, or warning when expiring soon; pending → info; expired, revoked, error → danger;
    replaced and anything else → muted.
  - Allowed `psu_type` values: `personal`, `business`.
  - Manual edit (`PATCH /admin/bank_connections/:id`) permits only `valid_until` and `status`. Success notice: **"Updated."**. Invalid
    input re-renders with 422.
- **Evidence:** `app/models/bank_connection.rb:43-107`; `app/controllers/admin/bank_connections_controller.rb:18-24,99-101`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_connection_spec.rb:45`, `:51`, `:57`, `:73`, `:95`; `spec/requests/api/v1/banking_spec.rb:109`.
- **Oracle:** [oracle](../oracle/http/PATCH_admin_bank_connections__id.json) case `default` → 422 (the oracle's payload was invalid).

<a id="br-086"></a>
### BR-086 Refresh connection status from the provider
- **Rule:** `GET /sessions/<session_id>` is called. Only the connection's lifecycle fields are updated; accounts are never touched
  here, because this response carries only account uids.
  - **Success:** `status` is mapped from the provider: `AUTHORIZED` → authorized, `CLOSED` → closed, `EXPIRED` → expired,
    `REJECTED` → revoked, `REVOKED` → revoked, **anything else → error**. Also set: `last_refreshed_at = now`,
    `access_balances` / `access_transactions` / `valid_until` from `access`, `closed_at` = provider `closed`, `last_error = NULL`.
  - **Failure:** `last_error = "HTTP <status>: <error>"`. If the status is 401, 403 or 410, `status = "expired"` too; other failures
    (e.g. 5xx, transport errors with status 0) leave the status unchanged. The operation then fails with `<error_message>`.
  - UI: success notice **"Refreshed - status: <status>, valid until <YYYY-MM-DD of valid_until in UTC>."** (empty date when NULL).
    Failure alert **"Refresh failed: <message>"**. Both redirect to the connection page.
- **Evidence:** `app/services/enable_banking/operations/refresh_connection.rb:5-49`; `app/services/enable_banking/api/get_session.rb:5-17`; `app/controllers/admin/bank_connections_controller.rb:68-75`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/refresh_connection_spec.rb:6`, `:18`, `:28`, `:38`, `:52`; `spec/requests/banking_spec.rb:275`; `spec/requests/api/v1/banking_spec.rb:121`.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_connections__id_refresh.json) case `default` → 302; MCP `bank_connections.refresh` → "Refreshed: status=authorized, valid_until=2026-11-20." ([oracle](../oracle/http/POST_mcp.json)).

<a id="br-087"></a>
### BR-087 Close connection
- **Rule:** `DELETE /admin/bank_connections/:id` closes the connection; the row is not deleted.
  - If `status == "authorized"` and `session_id` is present: best-effort `DELETE /sessions/<session_id>` at the provider. The HTTP
    result is ignored and configuration errors are swallowed.
  - Then always: `status = "closed"`, `closed_at = now`, `last_error = NULL`.
  - Redirect to the list with notice **"Connection closed."**.
  - Accounts keep pointing at the closed connection.
- **Evidence:** `app/services/enable_banking/operations/close_connection.rb:5-30`; `app/services/enable_banking/api/close_session.rb:5-14`; `app/controllers/admin/bank_connections_controller.rb:63-66`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/close_connection_spec.rb:6`, `:20`, `:35`, `:46`; `spec/requests/banking_spec.rb:262`; `spec/requests/api/v1/banking_spec.rb:132`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_bank_connections__id.json) case `own_connection` → 302 `/admin/bank_connections`.

<a id="br-090"></a>
### BR-090 Bank account ownership and validation
- **Rule:** An account belongs either to a credential (synced; `manual = false`, `tpp_credential_id` set, `manual_owner_id` NULL) or to
  a user as a cash wallet (`manual = true`, `manual_owner_id` set, `tpp_credential_id` NULL). This is enforced by the DB check
  `bank_accounts_ownership_xor` and by validation messages on the fields:
  - "must be blank for a cash wallet"
  - "is required for a cash wallet"
  - "must be blank for a synced account"
  - "is required for a synced account"
  
  Other rules: `uid` is required and globally unique. `status` is one of `active` (default), `inactive`, `revoked`.
  `cash_account_type` is blank or one of `CACC CARD CASH LOAN OTHR SVGS`. `raw_balances` is encrypted at rest. The admin account list
  shows synced accounts only.
- **Evidence:** `app/models/bank_account.rb:49-69,133-141`; `app/controllers/admin/bank_accounts_controller.rb:7-10`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_account_spec.rb:52`, `:61`, `:68`, `:77`, `:84`, `:165`; `spec/requests/banking_spec.rb:303`.

<a id="br-091"></a>
### BR-091 Refresh account details
- **Rule:** `GET /accounts/<uid>/details` is called.
  - **Failure:** the operation fails with `<error_message>` and the account is not modified.
  - **Success:** set `raw_details` = the body and `details_fetched_at = now`. These fields are overwritten **only when the provider
    returned a non-null value**: `iban`, `bban`, `all_account_ids`, `currency`, `name` (also kept when blank), `product`, `details`,
    `cash_account_type`, `usage`, `account_servicer`. Then the own-account rules are re-synced (BR-078).
  - UI: notice **"Account details refreshed."** or alert **"Refresh failed: <message>"**.
  - `needs_details_refresh?` is true when `details_fetched_at` is blank or older than 7 days.
- **Evidence:** `app/services/enable_banking/operations/refresh_account_details.rb:5-42`; `app/controllers/admin/bank_accounts_controller.rb:15-20`; `app/models/bank_account.rb:113-115`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/refresh_account_details_spec.rb:6`, `:26`, `:41`, `:57`; `spec/requests/banking_spec.rb:328`; `spec/models/bank_account_spec.rb:152`.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_accounts__id_refresh_details.json) case `default` → 302.

<a id="br-092"></a>
### BR-092 Refresh account balances
- **Rule:** `GET /accounts/<uid>/balances` is called.
  - **Failure:** fail with `<error_message>`.
  - **Success:** `raw_balances` = the full response serialised as JSON (encrypted at rest), `balances_synced_at = now`.
  - Balances are not interpreted at refresh time. `parsed_balances` returns the `balances` array, or `[]` when the value is blank,
    invalid JSON, or lacks the key. Per-bank balance types: PKO and mBank return ITBD and ITAV; Revolut returns ITAV only, with a lag.
  - UI: notice **"Balances refreshed."** or alert **"Refresh failed: <message>"**.
- **Evidence:** `app/services/enable_banking/operations/refresh_account_balances.rb:5-24`; `app/services/enable_banking/api/get_account_balances.rb:5-17`; `app/models/bank_account.rb:117-123`; `app/controllers/admin/bank_accounts_controller.rb:22-27`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/refresh_account_balances_spec.rb:6`, `:23`; `spec/requests/banking_spec.rb:341`; `spec/models/bank_account_spec.rb:138`.
- **Oracle:** [oracle](../oracle/http/POST_admin_bank_accounts__id_refresh_balances.json) case `default` → 302.

<a id="br-093"></a>
### BR-093 Account display helpers
- **Rule:**
  - `display_name` = first non-blank of `name`, `product`, `details`, `iban`, `uid`.
  - `bic` = `account_servicer.bic_fi`.
  - `owner` = the manual owner for wallets, else the credential's user.
- **Evidence:** `app/models/bank_account.rb:87-111`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_account_spec.rb:92`, `:106`.

---

<a id="br-100"></a>
### BR-100 Transaction sync date window
- **Rule:** For each account synced:
  - `date_from` = the explicit `date_from` if given. Otherwise, if the account has `transactions_synced_at`, use
    `(transactions_synced_at − 7 days)` as a date (incremental overlap, UTC). Otherwise use `Date.current(UTC) − horizon(bank_slug)`.
  - `date_to` = the explicit `date_to`, or `Date.current` (UTC).
  - Horizons in days: `revolut` 90, `pko_bank_polski` 780 (26×30), `mbank` 90, any other slug 90. The slug comes from the account's
    current connection.
  - Both dates are sent as `YYYY-MM-DD`, inclusive as interpreted by the provider. No ordering check is made: `date_from > date_to` is
    accepted (U-210).
  - Note: connections created from the UI with the bank named "PKO BP" get slug `pko_bp`, so the 26-month PKO horizon never applies
    to them (U-205).
  - The manual sync form defaults to `date_from = today − 90`, `date_to = today`.
- **Evidence:** `app/services/enable_banking/operations/sync_account_transactions.rb:16,26-35,90-96`; `app/services/enable_banking/backfill_window.rb:4-21`; `app/controllers/admin/transaction_syncs_controller.rb:21-25`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:124`, `:172`; `spec/services/enable_banking/backfill_window_spec.rb:6`, `:12`, `:17`, `:24`.
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` run 5: `date_from` `2026-10-14`, `date_to` `2026-10-21` (7-day overlap on an account synced on 2026-10-21). Run 8: `date_from` `2026-10-21` > `date_to` `2026-07-13` was accepted and `succeeded`.

<a id="br-101"></a>
### BR-101 Transaction pagination
- **Rule:** `GET /accounts/<uid>/transactions` is called with `date_from` and `date_to`, and with `continuation_key` on follow-up
  pages. Pages are concatenated in order until `continuation_key` is null or empty, or **100 pages** have been fetched. If the cap is
  reached while a key remains, `truncated = true` (rows beyond the cap are not fetched in this run). If any page fails, the whole call
  returns that failure and nothing from earlier pages is used. The result carries `transactions`, `pages_fetched` and `truncated`.
- **Evidence:** `app/services/enable_banking/api/get_account_transactions.rb:5-66`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/api/get_account_transactions_spec.rb:6`, `:25`, `:43`, `:60`.

<a id="br-102"></a>
### BR-102 No transaction-status filter is sent
- **Rule:** The sync never sends `transaction_status`. Most banks then return booked transactions only; PKO rejects `PDNG` with 400.
  Pending rows are stored only when the bank returns them anyway.
- **Evidence:** `app/services/enable_banking/api/get_account_transactions.rb:9-10`; `app/services/enable_banking/operations/sync_account_transactions.rb:30-35`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-103"></a>
### BR-103 De-duplication key and booked vs pending handling
- **Rule:** The idempotency key is **(bank_account_id, external_id)**, backed by a unique DB index. All rows of one account in one sync
  are written in a single DB transaction. For each normalised transaction:
  - no row with that key → insert (`inserted += 1`);
  - existing row with `status = "pending"` → overwrite **all** normalised attributes, including status, amount, dates and raw payload
    (`updated += 1`);
  - existing row with status `booked` → leave it unchanged, since booked rows are immutable under PSD2 (`skipped += 1`).
  
  After a successful account sync, `transactions_synced_at = now` on the account. On failure the timestamp is not updated. A pending
  row that the bank later books under a **different** id is not matched, and pending rows that disappear are never removed (U-208).
- **Evidence:** `app/services/enable_banking/operations/sync_account_transactions.rb:5-10,41-88`; `app/models/bank_transaction.rb:33,69`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:6`, `:27`, `:46`, `:79`; `spec/models/bank_transaction_spec.rb:68`.
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` run 7 and run 12: re-sync of account 1 reported `skipped: 39`, `inserted: 0`.

<a id="br-104"></a>
### BR-104 Transaction normalisation (provider payload → stored row)
- **Rule:**

  | Stored field | Derivation |
  |---|---|
  | `direction` | `credit_debit_indicator`: `CRDT` → `credit`, `DBIT` → `debit`; any other value → error `Unknown credit_debit_indicator: <value>` |
  | `external_id` | `transaction_id` if present, else `entry_reference` (Revolut always has a null `transaction_id`); neither → error `Transaction has neither transaction_id nor entry_reference` |
  | `amount_cents` | `abs(transaction_amount.amount)` converted to integer minor units of `transaction_amount.currency`: decimal string → BigDecimal → absolute value → Money `from_amount(…).cents`, rounded half-to-even to the currency's exponent [I]. Missing amount → `Missing transaction_amount.amount`; missing currency → `Missing transaction_amount.currency` |
  | `currency` | `transaction_amount.currency` verbatim (not upper-cased); must be a known ISO code, else the row fails validation |
  | `status` | `status`: `BOOK` → `booked`, `PDNG` → `pending`, anything else or missing → `booked` |
  | `booking_date`, `value_date`, `transaction_date` | parsed date of the same-named field; blank or unparsable → NULL (`booking_date` is required, so NULL fails validation) |
  | `title` | `remittance_information[0]` |
  | `type_hint` | `remittance_information[1]` |
  | `counterparty_name` | `credit`: `debtor.name`; `debit`: `creditor.name` |
  | `counterparty_iban` | from `debtor_account` (credit) or `creditor_account` (debit): `iban` if present; else `other.identification` when `other.scheme_name = "IBAN"`; when `"BBAN"` → `"PL" + identification` (Poland-only rule); else NULL |
  | `bank_transaction_code` | `bank_transaction_code.code` |
  | `payment_method` | BR-105 |
  | `counterparty_kind` | BR-106 (computed at sync time) |
  | `raw_payload` | full provider transaction object as JSON text (encrypted at rest) |
  | `fetched_at` | one timestamp per account sync |

  Normalisation errors are not caught per transaction or per account (BR-110).
- **Evidence:** `app/services/enable_banking/transaction_normalizer.rb:4-107`; `app/models/bank_transaction.rb:65-75`; `config/initializers/money.rb`.
- **Status:** [V] (rounding mode [I])
- **Covered by:** `spec/services/enable_banking/transaction_normalizer_spec.rb:22`, `:45`, `:56`, `:67`, `:79`, `:91`, `:103`, `:120`, `:131`, `:143`, `:153`, `:164`, `:176`, `:189`.

<a id="br-105"></a>
### BR-105 Payment-method inference
- **Rule:** Signals are tried in order and the first non-null result wins:
  1. **type_hint** (= `remittance_information[1]`, stripped) looked up exactly in the table below. An unmapped non-blank hint logs a
     warning and falls through.
  2. **bank_transaction_code** (stripped, upper-cased): exact `CARD_PAYMENT` → `card`, `TOPUP` → `topup`. Otherwise regex search in
     order: `/CARD/` → `card`, `/WTHD|ATM/` → `blik_atm`, `/TRSF|TRANSFER/` → `transfer`, `/FEE|CHRG/` → `fee`. An unmatched code logs a
     warning and falls through.
  3. **Heuristic:** if title or counterparty name is non-blank → `card` (always logs a warning). Otherwise → NULL.

  | type_hint | payment_method |
  |---|---|
  | `CARD-PAYMENT`, `CARD-PAYMENT-RETURN` | `card` |
  | `CARD-ATM`, `MOBILE-PAYMENT-ATM-TX-CODE` | `blik_atm` |
  | `PAYCARD-TRANSFER`, `PRZELEW WŁASNY` | `internal_transfer` |
  | `MOBILE-PAYMENT-POS-NO-CARD-TX-CODE`, `MOBILE-PAYMENT-POS-TX-CODE`, `MOBILE-PAYMENT-POS-RETURN`, `BLIK ZAKUP E-COMMERCE` | `blik_pos` |
  | `MOBILE-PAYMENT-C2C`, `MOBILE-PAYMENT-C2C-EXTERNAL`, `BLIK P2P-PRZYCHODZĄCY`, `BLIK P2P-WYCHODZĄCY` | `blik_p2p` |
  | `TRANSFER-IN`, `TRANSFER-EXPRESS-ELIXIR-IN`, `PRZELEW ZEWNĘTRZNY PRZYCHODZĄCY`, `PRZELEW ZEWNĘTRZNY WYCHODZĄCY`, `PRZELEW WEWNĘTRZNY PRZYCHODZĄCY`, `PRZELEW WEWNĘTRZNY WYCHODZĄCY`, `TRANSFER` | `transfer` |

  Allowed stored values: `card card_authorization blik_pos blik_p2p blik_atm transfer internal_transfer topup fee other`, or NULL.
  Refunds keep the original channel; the credit direction expresses the refund.
- **Evidence:** `app/services/enable_banking/payment_method_inferer.rb:4-113`; `app/models/bank_transaction.rb:47-55`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/payment_method_inferer_spec.rb:6`, `:17`, `:27`, `:32`, `:40`, `:45`, `:53`, `:58`, `:66`, `:73`, `:81`, `:86`, `:96`, `:103`, `:110`, `:117`.

<a id="br-106"></a>
### BR-106 Counterparty kind resolution (self / external / unknown)
- **Rule:** Computed at sync time and stored on the transaction. The first rule that applies wins:
  1. `payment_method` ∈ {`internal_transfer`, `topup`, `cash_atm_topup`, `cash_deposit`, `cash_fx_conversion`, `cash_adjustment`} →
     `self`.
  2. Normalise the IBAN (whitespace removed, upper-cased) and the name (stripped, upper-cased). If both are blank → `unknown`.
  3. Normalised IBAN ∈ the owner's `own_ibans` (BR-027) → `self`.
  4. Normalised name ∈ the owner's `own_holder_names` → `self`. Name matching can give false positives; a per-transaction category
     override wins downstream.
  5. Otherwise → `external`.
  
  The DB default is `unknown`.
- **Evidence:** `app/services/banking/counterparty_resolver.rb:4-62`; `app/services/enable_banking/operations/sync_account_transactions.rb:53,58-63`; `app/models/bank_transaction.rb:57-59`.
- **Status:** [V]
- **Covered by:** `spec/services/banking_spec.rb:6`, `:15`, `:23`, `:32`, `:41`, `:50`, `:59`, `:68`, `:77`, `:86`; `spec/models/bank_transaction_spec.rb:120`.

<a id="br-107"></a>
### BR-107 Consent probe when a transaction fetch is rejected
- **Rule:** If the transactions call fails with HTTP 401, 403 or 410 and the account has a current connection, BR-086 runs once for
  that connection. It may set the connection to `expired` (or another mapped status) and record `last_error`. Any failure of that probe
  is swallowed. The account sync then fails with the **original** `<error_message>`. Other failure statuses do not trigger the probe.
- **Evidence:** `app/services/enable_banking/operations/sync_account_transactions.rb:24,36-39,98-112`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:110`, `:140`, `:156`.

<a id="br-108"></a>
### BR-108 Connection-level sync and per-account isolation
- **Rule:** A connection sync processes the connection's current accounts with `status = "active"`, in ascending id order. Each
  account's sync failure is captured as a failed outcome so the next account still runs, and a progress callback fires after every
  account. Afterwards the connection gets `last_synced_at = now`, even when every account failed. The connection's own status is not
  checked: a connection chosen as the subject syncs whatever its status is.
- **Evidence:** `app/services/enable_banking/operations/sync_connection_transactions.rb:5-41`; `docs/adr/0013-enable-banking-adapter-shape.md:36-38`.
- **Status:** [V]
- **Covered by:** `spec/system/manual_sync_flow_spec.rb:16`, `:71`.

<a id="br-109"></a>
### BR-109 User-level sync covers authorized connections only
- **Rule:** A sync whose subject is the user runs BR-108 for every connection of the user with `status = "authorized"`, in ascending id
  order. Accounts attached to closed, expired, replaced or other non-authorized connections are skipped.
- **Evidence:** `app/services/enable_banking/operations/sync_user_transactions.rb:15-26`; `app/models/bank_connection.rb:74`.
- **Status:** [V] via the oracle (run 9 covered both of user 1's authorized connections).
- **Covered by:** `spec/system/first_time_setup_spec.rb:55`.
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` run 9 (`subject_type` `User`, accounts from `PKO BP` and `Revolut LT`).

<a id="br-110"></a>
### BR-110 Errors that escape per-account isolation
- **Rule:** Only the per-account "sync failed" outcome (an HTTP failure of the transactions call, or a configuration error) is isolated
  per account. These all escape the account loop and fail the **whole run** (BR-116):
  - normalisation errors (unknown direction, missing id, amount or currency);
  - validation failures (unknown currency, missing booking date);
  - invalid date strings in the run parameters.
  
  The run's error is `"<ErrorClass>: <message>"`. The failed account's transaction rows are rolled back, accounts already synced in
  that run keep their data, and later accounts are not processed (U-207).
- **Evidence:** `app/services/enable_banking/operations/sync_connection_transactions.rb:32-40`; `app/services/enable_banking/operations/sync_account_transactions.rb:55-77`; `app/jobs/transaction_sync_job.rb:31-33`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-111"></a>
### BR-111 Sign convention for bank transactions
- **Rule:** `amount_cents` is always ≥ 0. Signed amount = `+amount` for `credit` and `−amount` for `debit`. All downstream totals must
  use the signed amount.
- **Evidence:** `app/models/bank_transaction.rb:102-104`; `app/services/enable_banking/transaction_normalizer.rb:100-107`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_transaction_spec.rb:45`; `spec/services/enable_banking/transaction_normalizer_spec.rb:143`.

<a id="br-115"></a>
### BR-115 Queueing a manual transaction sync
- **Rule:** Input: optional `bank_connection_id`, `date_from` and `date_to`, taken as strings.
  - Subject: the user's **authorized** connection with that id. If the id is blank, unknown, not authorized, or belongs to another
    user, the subject silently becomes the **user**, meaning all authorized connections.
  - Params: `{date_from, date_to}`, each included only when non-blank.
  - An operation run is created with `kind = "transaction_sync"`, `status = "queued"`, `trigger = "manual"`,
    `triggered_by_user = user` and `summary = {}`, and the sync job is enqueued.
  - UI: redirect to `/admin/transaction_syncs/<id>` with notice **"Sync #<id> queued."**. On validation failure: redirect to the new
    form with alert **"Could not start sync: <messages>"**.
  - The same queuer backs `POST /api/v1/transaction_syncs` (201) and the MCP tool `transaction_syncs.create`.
- **Evidence:** `app/services/transaction_syncs/queuer.rb:4-48`; `app/controllers/admin/transaction_syncs_controller.rb:27-41`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:429`, `:446`; `spec/requests/api/v1/banking_spec.rb:227`; `spec/system/manual_sync_flow_spec.rb:16`.
- **Oracle:** [oracle](../oracle/http/POST_admin_transaction_syncs.json) case `default` → 302 `/admin/transaction_syncs/12`, case `missing_connection` → 302 `/admin/transaction_syncs/13` (run 13 has subject `User`); [oracle](../oracle/http/POST_api__version_transaction_syncs.json) cases `default`, `date_to_before_from`, `other_tenant_connection` → 201.

<a id="br-116"></a>
### BR-116 Transaction sync job lifecycle
- **Rule:** Queue `default`.
  1. Load the run. If it is already terminal, do nothing (but see the circuit-breaker step).
  2. Mark it running (`started_at = now`) and initialise `summary = {"accounts": []}`.
  3. Dispatch on the subject type: user → BR-109; connection → BR-108; account → a single account sync whose failure is captured; any
     other type → fail with `Unsupported subject: <Type>#<id>`, which the finaliser then overwrites with "No accounts in scope" (U-218).
     `date_from` and `date_to` come from the run params.
  4. After each account, append its entry (BR-117) to `summary.accounts` and persist the summary. This broadcasts progress (BR-142).
  5. Finalise the status (BR-141).
  6. Run post-sync enrichment (BR-118).
  7. If any unexpected error is raised: set the run to `failed` with error `"<ErrorClass>: <message>"` and the summary so far, then
     re-raise.
  8. Always, at the end: if the run is terminal and `trigger = "scheduled"`, notify the circuit breaker (BR-133). Errors from the
     breaker are logged, not raised.
- **Evidence:** `app/jobs/transaction_sync_job.rb:3-46,100-122`.
- **Status:** [V]
- **Covered by:** `spec/system/manual_sync_flow_spec.rb:16`, `:71`, `:114`; `spec/system/auto_sync_tick_spec.rb:17`.
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` runs 5, 7, 8, 9, 12, 13 (`status` `succeeded`).

<a id="br-117"></a>
### BR-117 Per-account summary entry
- **Rule:** Each entry has `bank_account_id`, `iban` and `bank` (the current connection's `bank_name`), plus:
  - on success: `status: "succeeded"`, `inserted`, `updated`, `skipped`, `pages_fetched`, `truncated`, `date_from`, `date_to` (ISO
    dates);
  - on failure: `status: "failed"`, `error: <message>`.
- **Evidence:** `app/jobs/transaction_sync_job.rb:124-148`.
- **Status:** [V]
- **Covered by:** `spec/system/manual_sync_flow_spec.rb:16`, `:71` (`error` includes "Bank under maintenance").
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` run 5 summary, e.g. `{"bank":"PKO BP","iban":"PL61109010140000071219812874","status":"succeeded","date_to":"2026-10-21","skipped":0,"updated":0,"inserted":0,"date_from":"2026-10-14","truncated":false,"pages_fetched":1,"bank_account_id":1}`.

<a id="br-118"></a>
### BR-118 Post-sync enrichment and ATM linking
- **Rule:** After finalisation, the transactions in the run's scope that have no enrichment yet (the account, the connection's current
  accounts, or all of the user's transactions) are passed to the transaction enricher. Then, if the owner has `track_cash = true`,
  every debit with `payment_method = "blik_atm"` in the same scope is linked to the cash wallet; each link failure is logged and
  skipped. Any enrichment failure is logged and never changes the run's status.
- **Evidence:** `app/jobs/transaction_sync_job.rb:48-98`.
- **Status:** [I]
- **Covered by:** untested at job level. The enrichment itself is covered in the enrichment part; `spec/system/manual_sync_flow_spec.rb:16` runs the job end to end.

<a id="br-119"></a>
### BR-119 Job retry policy
- **Rule:** Sidekiq retries the sync job at most 3 times and never moves it to the dead set. Because the run is marked failed before
  the error is re-raised, a retry finds a terminal run and exits immediately. Retries therefore never re-sync, but they do notify the
  circuit breaker again (U-206).
- **Evidence:** `app/jobs/transaction_sync_job.rb:6-10,16,31-35`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-125"></a>
### BR-125 Sync schedule model
- **Rule:** There is at most one schedule per bank connection (unique index). Fields:
  - `enabled`: default **false**.
  - `cadence`: `daily` (default), `every_2_days` or `weekly`.
  - `preferred_hour`: integer 0 to 23, default **8**. Validation message: "must be in 0..23".
  - `consecutive_failures`: integer ≥ 0, default 0.
  - `next_run_at`: NULL means "never computed".
  - `paused_until`, `last_dispatched_at`.
  
  `paused?` = `paused_until > now`. The failure threshold is **3**. Schedules are per connection because rate limits are per bank.
  Deleting the connection deletes its schedule.
- **Evidence:** `app/models/sync_schedule.rb:5-55`; `app/models/bank_connection.rb:53`.
- **Status:** [V]
- **Covered by:** `spec/models/sync_schedule_spec.rb:73`, `:89`, `:110`, `:124`.

<a id="br-126"></a>
### BR-126 Due schedules
- **Rule:** A schedule is due when `enabled = true` AND (`next_run_at` IS NULL OR `next_run_at <= now`) AND (`paused_until` IS NULL OR
  `paused_until <= now`).
- **Evidence:** `app/models/sync_schedule.rb:45-51`.
- **Status:** [V]
- **Covered by:** `spec/models/sync_schedule_spec.rb:31`, `:47`, `:63`; `spec/services/auto_sync/dispatcher_spec.rb:71`.

<a id="br-127"></a>
### BR-127 Dispatcher (cron every minute)
- **Rule:** The dispatcher job runs every minute (cron `* * * * *`, registered only in the Sidekiq server process). For each due
  schedule:
  - (a) If the connection is not `authorized` or has no owner: set `paused_until = now + 6 h` (BR-129) and count the schedule as
    skipped. No run is created and `consecutive_failures` does not change.
  - (b) Otherwise, in **one DB transaction**: create an operation run with `kind = "transaction_sync"`, `trigger = "scheduled"`,
    subject = the connection, `triggered_by_user` = the connection owner, `scheduled_for = next_run_at` (or now when NULL), params `{}`
    and status `queued`. In the same transaction set `next_run_at = NextRun(cadence, preferred_hour, zone, from: now,
    last_dispatched_at: now)` and `last_dispatched_at = now`.
  - After the commit, enqueue the sync job and count the schedule as dispatched. If the run insert violates the idempotency index
    (BR-128), roll back and count it as skipped.
  
  The job logs `[AutoSync::DispatcherJob] {examined: N, dispatched: N, skipped: N}`. Scheduled runs use date defaults (BR-100), i.e.
  incremental with a 7-day overlap.
- **Evidence:** `config/schedule.yml:6-9`; `config/initializers/sidekiq.rb:6-12`; `app/jobs/auto_sync/dispatcher_job.rb:3-11`; `app/services/auto_sync/dispatcher.rb:4-83`.
- **Status:** [V]
- **Covered by:** `spec/services/auto_sync/dispatcher_spec.rb:6`, `:27`, `:41`, `:55`, `:71`; `spec/system/auto_sync_tick_spec.rb:17`, `:53`, `:77`.

<a id="br-128"></a>
### BR-128 Idempotency of scheduled runs
- **Rule:** A partial unique index on operation runs covers `(subject_type, subject_id, kind, scheduled_for)` where
  `scheduled_for IS NOT NULL`. Two dispatcher ticks racing for the same slot can therefore create only one run. Manual runs have a
  NULL `scheduled_for` and are unconstrained.
- **Evidence:** `app/models/operation_run.rb:31`; `app/services/auto_sync/dispatcher.rb:4-6,81-82`.
- **Status:** [V]
- **Covered by:** `spec/models/operation_run_spec.rb:111`, `:124`; `spec/services/auto_sync/dispatcher_spec.rb:55`.

<a id="br-129"></a>
### BR-129 Back-off for unauthorized connections
- **Rule:** When a due schedule's connection is not authorized, the schedule is paused for **6 hours**. This is not a circuit-breaker
  trip. After the pause the schedule is examined again. Re-authorizing creates a new connection; the old schedule is not transferred
  (U-204).
- **Evidence:** `app/services/auto_sync/dispatcher.rb:8-10,49-54`.
- **Status:** [V]
- **Covered by:** `spec/services/auto_sync/dispatcher_spec.rb:27`.

<a id="br-130"></a>
### BR-130 Next-run computation
- **Rule:** Inputs: cadence, preferred hour, IANA zone (invalid or missing → UTC), `from` (default now), optional
  `last_dispatched_at`, and a jitter range (default 0 to 300 s inclusive). Intervals: daily = 1 day, every_2_days = 2 days, weekly =
  7 days. An unknown cadence raises `Unknown cadence: "<value>"`, but only when an interval is needed.
  - Baseline = `from` in the zone if there was no previous dispatch, else `max(from, last_dispatched_at + interval)`.
  - Slot = the baseline's date at `preferred_hour:00:00` in the zone. If the slot is earlier than the baseline, add one day.
  - Result = slot + a random whole number of seconds in the jitter range.
  - After a long outage the schedule fires once on recovery and does not replay a backlog.
  - **Effect in production:** the dispatcher passes `last_dispatched_at = now`, and the tick runs after the slot (by cron latency
    plus jitter). The baseline therefore lands a few minutes after the next day's slot and rolls one more day. A "daily" schedule fires
    every 2 days, "every_2_days" every 3 days, and "weekly" every 8 days (U-201). The specs only use dispatch times that exactly equal
    the slot.
- **Evidence:** `app/services/auto_sync/next_run_calculator.rb:3-58`; `app/services/auto_sync/dispatcher.rb:70-75`.
- **Status:** [V] (formula); [I] (production effect).
- **Covered by:** `spec/services/auto_sync/next_run_calculator_spec.rb:10`, `:18`, `:26`, `:35`, `:44`, `:53`, `:59`, `:67`.

<a id="br-131"></a>
### BR-131 Time zone used for schedules
- **Rule:** The code asks the user for a time zone if the user exposes one. The user model has **no time-zone attribute**, so every
  schedule is computed in **UTC** and `preferred_hour = 8` means 08:00 UTC (U-202).
- **Evidence:** `app/services/auto_sync/dispatcher.rb:94-96`; `app/services/auto_sync/schedule_upserter.rb:86-88`; `app/models/user.rb:5-15`.
- **Status:** [I]
- **Covered by:** `spec/services/auto_sync/next_run_calculator_spec.rb:67` (zone honoured when supplied).

<a id="br-132"></a>
### BR-132 Saving auto-sync settings
- **Rule:** `PATCH /admin/bank_connections/:id/sync_schedule` (connection scoped to the user) takes `enabled`, `cadence` and
  `preferred_hour`. It finds or creates the connection's schedule:
  - `enabled` is cast to a boolean ("1", "true", "on" → true; "0", "false" → false).
  - `cadence`: blank keeps the existing value.
  - `preferred_hour`: a non-integer keeps the existing value (silently).
  - The schedule is validated first. On failure: re-render the form with 422 and alert = the joined messages, or **"Could not save."**
    if there are none.
  - `next_run_at` is recomputed (BR-130, with the stored `last_dispatched_at`, from now) only when the schedule is enabled AND
    (`next_run_at` is NULL OR it was previously disabled OR the cadence changed OR the hour changed). Turning it off and on again
    without other changes therefore recomputes, while turning it off alone keeps the planned slot.
  - On success: redirect to `/admin/transaction_syncs` with notice **"Auto-sync settings saved."**.
- **Evidence:** `app/services/auto_sync/schedule_upserter.rb:3-89`; `app/controllers/admin/sync_schedules_controller.rb:11-36`.
- **Status:** [V]
- **Covered by:** `spec/services/auto_sync/schedule_upserter_spec.rb:11`, `:26`, `:39`, `:53`, `:67`, `:79`; `spec/requests/banking_spec.rb:458`, `:469`, `:480`, `:502`.
- **Oracle:** [oracle](../oracle/http/PATCH_admin_bank_connections__bank_connection_id_sync_schedule.json) case `default` → 302 `/admin/transaction_syncs`.

<a id="br-133"></a>
### BR-133 Circuit breaker for scheduled syncs
- **Rule:** The breaker considers only runs with `trigger = "scheduled"` that are terminal and whose subject is a connection that has a
  schedule.
  - `succeeded` resets the schedule to `consecutive_failures = 0`, `paused_until = NULL` (no write if already clean).
  - `partial` or `failed` increments `consecutive_failures`. When the new count is **≥ 3**, it also sets
    `paused_until = now + 24 h`.
  - The counter is not reset when the pause ends, so the next non-success after the cooldown pauses again immediately (U-221).
  - While paused, the schedule is not due (BR-126) and no run is created.
- **Evidence:** `app/services/auto_sync/circuit_breaker.rb:3-47`; `app/models/sync_schedule.rb:34-35`.
- **Status:** [V]
- **Covered by:** `spec/services/auto_sync/circuit_breaker_spec.rb:6`, `:19`, `:31`, `:44`, `:57`, `:71`; `spec/system/auto_sync_circuit_breaker_spec.rb:17`, `:50`.

<a id="br-134"></a>
### BR-134 Manual syncs bypass the breaker
- **Rule:** A paused schedule never blocks a manual sync, and manual runs never change the breaker state.
- **Evidence:** `app/services/auto_sync/circuit_breaker.rb:16`; `app/services/transaction_syncs/queuer.rb:26-37`.
- **Status:** [V]
- **Covered by:** `spec/system/auto_sync_circuit_breaker_spec.rb:83`; `spec/services/auto_sync/circuit_breaker_spec.rb:6`.

<a id="br-140"></a>
### BR-140 Operation run lifecycle
- **Rule:**
  - Kinds: `transaction_sync balance_refresh connection_refresh account_details_refresh llm_enrichment llm_connection_test data_export data_import`.
  - Statuses: `queued` (default), `running`, `succeeded`, `partial`, `failed`. Terminal statuses: succeeded, partial, failed.
  - Triggers: `manual` (default), `scheduled`.
  - Transitions:
    - start: `status = running`, `started_at = now`;
    - succeed, partial or fail: set the status and `finished_at = now`; `summary` and `error` are written only when provided; the
      error is converted to a string.
  - `triggered_by_user` is required, and deleting the user deletes their runs.
  - `params` and `summary` are JSON objects (default `{}`) whose shape depends on the kind.
  - The subject is polymorphic and optional.
  - Only `transaction_sync`, `data_export` and `data_import` are created by this part's code. The UI and API refresh actions call the
    operations synchronously and create no run.
- **Evidence:** `app/models/operation_run.rb:5-112,149-154`; `docs/adr/0009-operation-run-tracker.md:18-34`.
- **Status:** [V]
- **Covered by:** `spec/models/operation_run_spec.rb:40`, `:51`, `:64`, `:75`, `:85`.

<a id="br-141"></a>
### BR-141 Finalising a sync run
- **Rule:** The final status comes from the `status` values in `summary.accounts`:

  | Condition | Result | `error` |
  |---|---|---|
  | no entries | `failed` | `No accounts in scope` |
  | all `succeeded` | `succeeded` | (unchanged) |
  | some `succeeded`, some not | `partial` | `<count of "failed"> account(s) failed` |
  | none `succeeded` | `failed` | `All <N> account(s) failed` |

  The summary is always persisted. The run always ends in a terminal status. A user with no authorized connections, or a connection
  with no active accounts, therefore produces a failed run.
- **Evidence:** `app/services/operation_run_finalizer.rb:3-44`.
- **Status:** [V]
- **Covered by:** `spec/services/operation_run_finalizer_spec.rb:6`, `:16`, `:26`, `:37`, `:48`; `spec/system/manual_sync_flow_spec.rb:71` (error includes "All 1 account(s) failed").

<a id="br-142"></a>
### BR-142 Live progress broadcast
- **Rule:** After every committed update of a run of kind `transaction_sync` or `llm_enrichment`, an asynchronous Turbo Stream
  "replace" is broadcast on stream `operation_run_<id>`. It targets the DOM id `progress_operation_run_<id>` and renders partial
  `admin/<kind plural>/_run_progress`. Other kinds do not broadcast.
- **Evidence:** `app/models/operation_run.rb:63-67,140-147`.
- **Status:** [V]
- **Covered by:** `spec/models/operation_run_spec.rb:166`.

<a id="br-143"></a>
### BR-143 Visibility of sync runs
- **Rule:** The sync list and detail pages show only runs with `kind = transaction_sync` and `triggered_by_user_id = current user`,
  newest first. A scheduled run is visible to the connection owner because the dispatcher records the owner as `triggered_by_user`.
  The list also shows the user's authorized connections with their schedules, ordered by bank name.
- **Evidence:** `app/controllers/admin/transaction_syncs_controller.rb:4-19,45-51`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:390`, `:404`, `:415`; `spec/requests/api/v1/banking_spec.rb:212`.

<a id="br-144"></a>
### BR-144 Run presentation helpers
- **Rule:**
  - `duration_seconds` = nil before start; otherwise whole seconds from start to finish (or to now while running).
  - Tone: succeeded → success, running → info, queued → muted, partial → warning, failed → destructive.
  - Subject label: the first non-blank of the subject's breadcrumb, display name, e-mail or name; else `<Type>#<id>`; `-` when there
    is no subject.
- **Evidence:** `app/models/operation_run.rb:113-136`.
- **Status:** [V]
- **Covered by:** `spec/models/operation_run_spec.rb:100`, `:136`, `:151`.

---

<a id="br-150"></a>
### BR-150 Data export
- **Rule:** `POST /admin/settings/preferences/data_exchange/export` with `passphrase` always exports **all registered resources**
  (BR-153).
  - Validation, before any run is created: an empty resource list fails with **"no resources selected"**; an empty passphrase fails
    with **"passphrase required"**.
  - Then a run is created with `kind = data_export`, `status = running`, `trigger = manual`, `started_at = now`, subject = the user and
    params `{"resource_keys": [ordered keys]}`.
  - The payload and manifest are built (BR-151), then encrypted (BR-152).
  - The run succeeds with summary `{"bundle_id", "bytes" (blob size), "counts", "resource_versions"}`.
  - Response: HTTP 200, `Content-Type: application/octet-stream`, attachment named `obr-export-<UTC YYYYMMDD-HHMMSS>.obrbundle`.
  - A failure during the build marks the run failed (error = message, summary `{"resource_keys": [...]}`) and re-raises. Export
    validation failures redirect back to the page with alert **"Export failed: <message>"**. Other errors are not rescued.
  - Encrypted model fields are exported as **plaintext** inside the encrypted bundle.
- **Evidence:** `app/services/data_exchange/operations/export.rb:5-56`; `app/controllers/admin/settings/data_exchange_controller.rb:13-27,53-55`.
- **Status:** [V]
- **Covered by:** `spec/services/data_exchange/round_trip_spec.rb:6`, `:74`; `spec/requests/settings_spec.rb:222`, `:238`; `spec/system/data_exchange_round_trip_spec.rb:29`.
- **Oracle:** [oracle](../oracle/http/POST_admin_settings_preferences_data_exchange_export.json) case `default` → 200 binary (4878 bytes), case `blank_passphrase` → 302; `../oracle/operation_runs_after_capture.jsonl` run 15 summary `{"bytes":4878,"counts":{"bank_accounts":6,"tpp_credentials":3,"bank_connections":2},"bundle_id":"4d961a27-…","resource_versions":{…:1}}`.

<a id="br-151"></a>
### BR-151 Bundle plaintext format
- **Rule:** The plaintext is the JSON document `{"manifest": {...}, "payload": {...}}`, gzip-compressed and then encrypted.
  - **Manifest:**
    - `format_version`: 1
    - `bundle_id`: random UUID v4
    - `exported_at`: ISO-8601, UTC
    - `source_env`: Rails env name
    - `source_fingerprint`: BR-157
    - `app_version`: null unless configured [I]
    - `exported_by`: `{"user_id", "email"}`
    - `resource_versions`: `{key: int}`
    - `counts`: `{key: number of records}`
  - **Payload:** `{"<resource_key>": [record, …]}` in dependency order. Each record is `{"export_id": <source DB id>, "_v": <resource
    version>, "attributes": {<permitted attributes>}, "references": {"<fk_column>": ["<resource_key>", <source id or null>]}}`.
  - **Value encoding:** timestamps as ISO-8601 with 6 fractional digits; dates as `YYYY-MM-DD`; decimals as plain strings; JSON
    columns as-is.
- **Evidence:** `app/services/data_exchange/bundle.rb:8-75`; `app/services/data_exchange/operations/export.rb:58-122`.
- **Status:** [V]
- **Covered by:** `spec/services/data_exchange/round_trip_spec.rb:6`.

<a id="br-152"></a>
### BR-152 Bundle encryption (passphrase-based)
- **Rule:**
  - Cipher: **AES-256-GCM**.
  - Key: **PBKDF2-HMAC-SHA256** of the UTF-8 passphrase, **200,000 iterations**, 16-byte random salt, 32-byte key.
  - IV: 12 random bytes. Tag: 16 bytes.
  - Additional authenticated data: the ASCII string `OBRX1`.
  - Binary layout: `"OBRX1"` (5 bytes) ‖ salt (16) ‖ IV (12) ‖ tag (16) ‖ ciphertext.
  - Decryption errors:
    - fewer than 49 bytes → malformed, `bundle too short`;
    - wrong first 5 bytes → malformed, `bad magic`;
    - tag mismatch → `wrong passphrase or corrupted bundle` (wrong passphrase and tampering are not distinguished).
  - An empty passphrase raises `passphrase required`.
  - The passphrase is never stored.
  - The bundle format version must equal 1, else `unsupported bundle format_version=<v> (this build understands 1)`.
  - Missing keys give `missing manifest` or `missing payload`; invalid JSON gives `bundle JSON invalid: <parser message>`.
- **Evidence:** `app/services/data_exchange/bundle_cipher.rb:6-96`; `app/services/data_exchange/bundle.rb:27-62`.
- **Status:** [V]
- **Covered by:** `spec/services/data_exchange/round_trip_spec.rb:55`; `spec/system/data_exchange_round_trip_spec.rb:93`, `:127`.

<a id="br-153"></a>
### BR-153 Exchangeable resources and their rules
- **Rule:** Three resources are registered. Parents always come before children, through a topological sort over declared
  dependencies (a cycle raises `cycle detected at <key>`; an unknown key raises `unknown resources: [...]`).

  | Key | Depends on | Export scope (user) | Natural key (conflict detection) | Attributes carried | Updated on overwrite | References |
  |---|---|---|---|---|---|---|
  | `tpp_credentials` | none | `user_id = user` | `name` + `provider` | name provider environment status redirect_url application_id private_key_pem public_cert_pem primary metadata created_at updated_at | environment redirect_url application_id private_key_pem public_cert_pem metadata | none |
  | `bank_connections` | tpp_credentials | connections whose credential belongs to the user | `session_id` (plaintext comparison over the user's connections) | bank_slug bank_country bank_name status psu_type session_id psu_id_hash raw_session_payload access_balances access_transactions valid_until authorized_at last_refreshed_at last_synced_at closed_at last_error created_at updated_at | bank_country bank_name psu_type session_id psu_id_hash raw_session_payload access_balances access_transactions valid_until authorized_at | tpp_credential_id → tpp_credentials; replaces_id → bank_connections |
  | `bank_accounts` | tpp_credentials, bank_connections | synced accounts of the user's credentials plus the user's cash wallets | `uid` | uid iban bban all_account_ids currency name product details cash_account_type usage status account_servicer raw_account_resource raw_details details_fetched_at balances_synced_at transactions_synced_at raw_balances manual created_at updated_at | iban bban all_account_ids currency name product details cash_account_type usage account_servicer raw_account_resource raw_details raw_balances | synced only: tpp_credential_id → tpp_credentials; current_bank_connection_id → bank_connections |

  Not exchanged: bank transactions, manual transactions, categories, merchants, rules, enrichments, schedules, tokens, LLM settings
  (U-215).
- **Evidence:** `app/services/data_exchange/registry.rb:3-56`; `app/services/data_exchange/resources/tpp_credential_resource.rb:5-35`; `app/services/data_exchange/resources/bank_connection_resource.rb:5-62`; `app/services/data_exchange/resources/bank_account_resource.rb:5-59`.
- **Status:** [V]
- **Covered by:** `spec/services/data_exchange/round_trip_spec.rb:6`, `:41`; `spec/system/data_exchange_round_trip_spec.rb:16`, `:51`; `spec/requests/settings_spec.rb:213`.
- **Oracle:** [oracle](../oracle/http/GET_admin_settings_preferences_data_exchange.json) case `default` → 200 (per-resource counts).

<a id="br-154"></a>
### BR-154 Import validation (before any write)
- **Rule:** Checks run in this order. Each failure becomes **"Import failed: <message>"** in the UI, and no operation run is created
  for any of them:
  1. A missing upload is handled by the controller: alert **"Bundle file is required."**.
  2. Empty passphrase → `passphrase required`.
  3. Strategy not in {`skip_existing` (default), `overwrite_existing`, `fail_on_conflict`} → `unknown strategy: <value>`.
  4. `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY` unset → `AR encryption keys not configured on this instance - cannot store sensitive
     fields`.
  5. Empty blob → `bundle is empty`.
  6. Blob larger than 20 MiB (2 × 10 MiB) → `bundle exceeds size limit`.
  7. Decrypt and parse (BR-152). Wrong passphrase → `wrong passphrase or corrupted bundle`. Malformed bundle or format → `bundle
     malformed: <detail>`.
  8. More than 50,000 records in total → `bundle has <n> records (limit 50000)`.
  9. Unknown resource keys → `bundle references unknown resources: [:x]`.
  10. A resource version newer than this build → `bundle resource <key> version <v> is newer than this build (<known>) - upgrade target
      instance`.
- **Evidence:** `app/services/data_exchange/operations/import.rb:5-81`; `app/controllers/admin/settings/data_exchange_controller.rb:29-49`.
- **Status:** [V]
- **Covered by:** `spec/services/data_exchange/round_trip_spec.rb:55`, `:81`; `spec/requests/settings_spec.rb:250`, `:284`; `spec/system/data_exchange_round_trip_spec.rb:93`, `:127`.
- **Oracle:** [oracle](../oracle/http/POST_admin_settings_preferences_data_exchange_import.json) cases `missing_bundle`, `garbage_bundle` → 302 back to the page.

<a id="br-155"></a>
### BR-155 Import application and conflict strategies
- **Rule:** After validation, a run is created with `kind = data_import`, `status = running`, subject = the user and params
  `{strategy, bundle_id, source_env, source_fingerprint, exported_at}`. Then, in **one DB transaction**, resources are processed in
  dependency order and records in bundle order. For each record:
  1. Keep only the permitted attributes. Run the version upgrade hook if `_v` differs (all versions are currently 1).
  2. Remap every reference through the map of source id → destination id built during this import. If the parent is unresolved and
     the FK column is NOT NULL, fail with `<key>: required reference <rk>#<id> for column <col> not resolved (parent not in bundle and
     not on destination)`. If the column is nullable, set it to NULL.
  3. Stamp ownership: `user_id = importing user` where the column exists; cash wallets get `manual_owner_id = user`. The owner is never
     taken from the bundle.
  4. Look up an existing record by natural key **within the importing user's scope**:
     - `skip_existing` → leave it unchanged (counted as skipped);
     - `overwrite_existing` → update only the "Updated on overwrite" attributes (counted as updated);
     - `fail_on_conflict` → fail with `<key> conflict on [<natural key attrs>] - record already exists`.
     
     Either way the existing id is recorded for child remapping.
  5. Otherwise insert (counted as imported).
  
  Any validation error is wrapped as `<key>: <message>` and rolls back **everything** ("nothing imported"). Example: an imported
  primary credential next to an existing primary (see U-214).
- **Evidence:** `app/services/data_exchange/operations/import.rb:83-122`; `app/services/data_exchange/resources/base.rb:84-158`; `app/services/data_exchange/ref_map.rb:3-26`.
- **Status:** [V]
- **Covered by:** `spec/services/data_exchange/round_trip_spec.rb:6`, `:41`; `spec/system/data_exchange_round_trip_spec.rb:51`.

<a id="br-156"></a>
### BR-156 Import outcome reporting
- **Rule:** On success the run succeeds with summary `{"strategy", "bundle": {id, source_env, exported_at, counts}, "result":
  {imported, updated, skipped, failed, warnings, per_resource: {key: {imported, updated, skipped, failed}}}}`. The UI notice is
  **"Import done - <imported> imported, <updated> updated, <skipped> skipped."**. On failure after the run exists, the run fails with
  the message and the partial counts, and the UI shows the alert. `failed` is always 0 and `warnings` is always empty in the current
  code (U-213).
- **Evidence:** `app/services/data_exchange/operations/import.rb:28-41,124-141`; `app/services/data_exchange/result.rb:4-24`; `app/controllers/admin/settings/data_exchange_controller.rb:43-45`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:260`; `spec/services/data_exchange/round_trip_spec.rb:41`.

<a id="br-157"></a>
### BR-157 Source fingerprint
- **Rule:** `source_fingerprint` is the first 16 hex characters of `HMAC-SHA256(key = ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY, message =
  "data-exchange-fingerprint-v1")`, or null when the key is unset. It is informational only, a hint that the bundle comes from this
  instance, and is never used for verification.
- **Evidence:** `app/services/data_exchange/operations/export.rb:94-101`.
- **Status:** [I]
- **Covered by:** untested.

---

<a id="br-170"></a>
### BR-170 Rake `banking:backfill_counterparty_kind`
- **Rule:** For every user, the task recomputes BR-106 for each of the user's bank and manual transactions. When the value changes it
  writes only the `counterparty_kind` column (no callbacks or audit). It prints `  user=<email>` per user and then totals:
  `users processed`, `bank rows updated`, `manual rows updated`.
- **Evidence:** `lib/tasks/banking.rake:4-34`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-171"></a>
### BR-171 Rake `banking:backfill_payment_methods` (`DRY_RUN=1` supported)
- **Rule:** For every user, in batches of 500 bank transactions, the task re-runs BR-105 on the stored `type_hint`,
  `bank_transaction_code`, `title`, `counterparty_name` and `direction`. For each change it counts the transition
  `(type_hint, old, new)`. Unless it is a dry run, it then writes `payment_method`, recomputes and writes `counterparty_kind` if
  changed, and, for users with at least one change, rebuilds that user's enrichments. Output: per-user change counts, a transitions
  table sorted by frequency, and totals. A dry run prints "DRY RUN — no changes will be persisted." and, at the end, "Re-run without
  DRY_RUN=1 to apply." when changes exist.
- **Evidence:** `lib/tasks/banking.rake:36-100`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-172"></a>
### BR-172 Rake `banking:diagnose_duplicate_accounts`
- **Rule:** The task groups synced accounts with a non-blank IBAN by `(tpp_credential_id, iban, currency)` and lists the groups with
  more than one row. For each group it prints the owner e-mail, the credential, and per account: id, the first 8 characters of the uid,
  the connection (bank, status, id), bank and manual transaction counts, and the creation date. It ends with merge instructions, or
  prints "No duplicates found.". Read-only.
- **Evidence:** `lib/tasks/duplicate_bank_accounts.rake:13-41`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-173"></a>
### BR-173 Rake `banking:merge_duplicate_accounts CANONICAL_ID= DUP_ID= [CONFIRM=1]`
- **Rule:** Both ids are required (abort messages given). The task refuses if:
  - both ids are the same record;
  - the canonical account has no IBAN;
  - the IBANs differ;
  - the currencies differ;
  - the credentials differ;
  - the duplicate is a cash wallet.
  
  It prints a plan. Without `CONFIRM=1` it stops with "DRY RUN. Re-run with CONFIRM=1 to apply.". With confirmation, in one transaction:
  - delete the duplicate's bank transactions whose `external_id` already exists on the canonical account;
  - move the remaining bank transactions and all manual transactions to the canonical account;
  - destroy the duplicate;
  - set on the canonical account the duplicate's `uid` and `current_bank_connection_id`, plus `all_account_ids`, `account_servicer` and
    `raw_account_resource` when present.
- **Evidence:** `lib/tasks/duplicate_bank_accounts.rake:43-110`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-174"></a>
### BR-174 Rake `banking:start_auth`
- **Rule:**
  - Required: `USER_EMAIL` and `ASPSP`.
  - Optional:
    - `COUNTRY` (default `PL`);
    - `PSU_TYPE` (default `personal`);
    - `DAYS` (default 180, must be 1 to 180);
    - `CREDENTIAL_ID` (default: the user's primary credential; abort "User has no primary TppCredential. Pass CREDENTIAL_ID=... or set
      a primary.");
    - `REDIRECT_URL`, a one-shot, in-memory override of the credential's redirect URL.
  - Form errors abort with "Invalid form: …".
  - The task runs BR-067 and prints the bank URL and instructions. It is a fallback for when the UI redirect URL does not match the
    provider registration.
  - A failure aborts with "start_auth failed: <message>".
- **Evidence:** `lib/tasks/eb_auth.rake:3-75`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-175"></a>
### BR-175 Rake `banking:finish_auth CODE= STATE=`
- **Rule:**
  - The state is decoded (BR-068). An invalid state aborts with "Invalid or expired state token (TTL is 30 minutes - re-run
    start_auth).".
  - The credential is loaded by the id in the state **without any user check**. A missing credential aborts with "TPP credential from
    state no longer exists.".
  - The task runs BR-075 to BR-079 and prints the connection and its accounts.
  - A failure aborts with "finish_auth failed: <message>".
- **Evidence:** `lib/tasks/eb_auth.rake:77-107`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-176"></a>
### BR-176 Rake `cash:backfill_atm_links`
- **Rule:** For each user with `track_cash = true`, the task tries to link every debit with `payment_method = blik_atm` to the cash
  wallet. It counts new links versus no-ops, prints per-user and total counts, and prints a reconciliation reminder when anything was
  linked.
- **Evidence:** `lib/tasks/cash.rake:3-40`.
- **Status:** [I]
- **Covered by:** untested.

<a id="br-180"></a>
### BR-180 Encryption at rest of banking secrets
- **Rule:** These fields are encrypted per field with non-deterministic encryption keyed by the `ACTIVE_RECORD_ENCRYPTION_*`
  environment keys:
  - `tpp_credentials.private_key_pem`, `tpp_credentials.application_id`;
  - `bank_connections.session_id`, `bank_connections.psu_id_hash`, `bank_connections.raw_session_payload`;
  - `bank_accounts.raw_balances`;
  - `bank_transactions.raw_payload`;
  - `llm_settings.api_key`.
  
  No search or equality lookup is possible on them, so connection matching on import compares plaintext in application code
  (BR-153). They are excluded from audit versions and search allowlists. `raw_account_resource` and `raw_details` (JSON) are **not**
  encrypted.
- **Evidence:** `docs/adr/0004-encryption-at-rest.md:15-28`; `app/models/tpp_credential.rb:45,57`; `app/models/bank_connection.rb:55,61`; `app/models/bank_account.rb:64`; `app/models/bank_transaction.rb:65`.
- **Status:** [V]
- **Covered by:** `spec/models/tpp_credential_spec.rb:126`, `:137`; `spec/models/bank_connection_spec.rb:105`; `spec/models/bank_account_spec.rb:165`; `spec/models/bank_transaction_spec.rb:109`.

---

### Service catalogue (Part A)

One entry per service file. Format: responsibility; inputs → outputs/result; rules implemented. [V] where a spec of that file is cited
in the referenced rules, otherwise [I].

<a id="svc-app-forms-bank-connection-request-form"></a>
- **`app/forms/bank_connection_request_form.rb`** (BankConnectionRequestForm): validates a request to connect a bank; inputs `aspsp_name`, `aspsp_country` (default PL), `psu_type` (default personal), `valid_days` (default 180, 1..180) → valid/invalid with messages; implements BR-065, BR-174. [I]

<a id="svc-auth-personal-access-token-authenticator"></a>
- **`app/services/auth/personal_access_token_authenticator.rb`** (Auth::PersonalAccessTokenAuthenticator): authenticates a raw bearer token; input `raw_token` → `{success?, user, token_record}` (uniform failure), side effect touches `last_used_at`; implements BR-019. [V]

<a id="svc-auth-personal-access-token-issuer"></a>
- **`app/services/auth/personal_access_token_issuer.rb`** (Auth::PersonalAccessTokenIssuer): issues a new PAT; inputs `user`, `name` → `{success?, token_record, raw_token, error_messages}`; stores the digest and last four only; implements BR-016, BR-017, BR-018. [V]

<a id="svc-auto-sync-circuit-breaker"></a>
- **`app/services/auto_sync/circuit_breaker.rb`** (AutoSync::CircuitBreaker): updates a schedule's failure counter and pause after a scheduled run ends; input `run` → schedule updated or no-op; implements BR-133, BR-134. [V]

<a id="svc-auto-sync-dispatcher"></a>
- **`app/services/auto_sync/dispatcher.rb`** (AutoSync::Dispatcher): per-minute scan of due schedules that creates scheduled sync runs and enqueues jobs; input `now` → `{examined, dispatched, skipped}`; implements BR-126, BR-127, BR-128, BR-129, BR-131. [V]

<a id="svc-auto-sync-next-run-calculator"></a>
- **`app/services/auto_sync/next_run_calculator.rb`** (AutoSync::NextRunCalculator): computes the next scheduled slot; inputs cadence, preferred hour, zone, from, jitter, last_dispatched_at → timestamp (or `ArgumentError` for an unknown cadence); implements BR-130. [V]

<a id="svc-auto-sync-schedule-upserter"></a>
- **`app/services/auto_sync/schedule_upserter.rb`** (AutoSync::ScheduleUpserter): creates or updates a connection's schedule from the form; inputs connection, user, `enabled`, `cadence`, `preferred_hour` → `{success?, schedule, error_messages}`; implements BR-132, BR-131. [V]

<a id="svc-banking-counterparty-resolver"></a>
- **`app/services/banking/counterparty_resolver.rb`** (Banking::CounterpartyResolver): classifies a counterparty as self, external or unknown; inputs payment_method, counterparty IBAN and name, user (or a transaction/Hash via `.for`) → one of `self` / `external` / `unknown`; implements BR-106, BR-027, BR-170, BR-171. [V]

<a id="svc-data-exchange-bundle"></a>
- **`app/services/data_exchange/bundle.rb`** (DataExchange::Bundle): JSON + gzip framing of manifest and payload, plus format-version check; `dump(manifest, payload, passphrase)` → encrypted blob; `load(blob, passphrase)` → bundle (`resource_keys`, `records_for`) or InvalidFormat; implements BR-151, BR-152. [V]

<a id="svc-data-exchange-bundle-cipher"></a>
- **`app/services/data_exchange/bundle_cipher.rb`** (DataExchange::BundleCipher): AES-256-GCM with PBKDF2 passphrase key and the `OBRX1` envelope; encrypt(plaintext) → blob; decrypt(blob) → plaintext, or InvalidPassphrase / MalformedBundle; implements BR-152. [V]

<a id="svc-data-exchange-operations-base"></a>
- **`app/services/data_exchange/operations/base.rb`** (DataExchange::Operations::Base): common `call` entry point and base `Failed` error for export and import; used for conflict errors in BR-155. [I]

<a id="svc-data-exchange-operations-export"></a>
- **`app/services/data_exchange/operations/export.rb`** (DataExchange::Operations::Export): builds and encrypts a user's export and records a `data_export` run; inputs user, resource_keys, passphrase → `{blob, run}` or Failed; implements BR-150, BR-151, BR-157. [V]

<a id="svc-data-exchange-operations-import"></a>
- **`app/services/data_exchange/operations/import.rb`** (DataExchange::Operations::Import): validates, decrypts and applies a bundle in one transaction and records a `data_import` run; inputs user, bundle_blob, passphrase, strategy → Result (imported, updated, skipped, failed, warnings, per_resource, run) or Failed; implements BR-154, BR-155, BR-156. [V]

<a id="svc-data-exchange-ref-map"></a>
- **`app/services/data_exchange/ref_map.rb`** (DataExchange::RefMap): in-memory map of (resource, source id) → destination id used for FK remapping during import; a miss returns nil; implements BR-155. [I]

<a id="svc-data-exchange-registry"></a>
- **`app/services/data_exchange/registry.rb`** (DataExchange::Registry): list of exchangeable resources and their dependency-ordered sort; `fetch(key)` → resource class, `all_keys`, `ordered(keys)` (DependencyError on a cycle, ArgumentError for unknown keys); implements BR-153. [V]

<a id="svc-data-exchange-resources-bank-account-resource"></a>
- **`app/services/data_exchange/resources/bank_account_resource.rb`** (DataExchange::Resources::BankAccountResource): export scope, attribute allowlists, natural key `uid`, references, and wallet ownership stamping for bank accounts; implements BR-153, BR-155. [V]

<a id="svc-data-exchange-resources-bank-connection-resource"></a>
- **`app/services/data_exchange/resources/bank_connection_resource.rb`** (DataExchange::Resources::BankConnectionResource): export scope, allowlists, plaintext `session_id` natural-key matching, and references (credential, replaces) for bank connections; implements BR-153, BR-155, BR-180. [V]

<a id="svc-data-exchange-resources-base"></a>
- **`app/services/data_exchange/resources/base.rb`** (DataExchange::Resources::Base): generic serialise and apply logic: attribute slicing, version upgrade hook, FK remap (required vs optional), ownership stamping, natural-key lookup scoped to the user, conflict strategies; `apply!(serialized, ref_map, strategy)` → `:imported` / `:updated` / `:skipped` or Failed; implements BR-151, BR-155. [V]

<a id="svc-data-exchange-resources-tpp-credential-resource"></a>
- **`app/services/data_exchange/resources/tpp_credential_resource.rb`** (DataExchange::Resources::TppCredentialResource): export scope, allowlists (`primary` is never updated on overwrite) and natural key `name` + `provider` for credentials; implements BR-153, BR-155. [V]

<a id="svc-data-exchange-result"></a>
- **`app/services/data_exchange/result.rb`** (DataExchange::Result): counters for import outcomes, total and per resource; `record(key, outcome)`, `warn(msg)`, `total`; implements BR-156. [I]

<a id="svc-enable-banking-api-base"></a>
- **`app/services/enable_banking/api/base.rb`** (EnableBanking::Api::Base): base for per-endpoint request classes; provides the credential-bound HTTP client; supports BR-061. [I]

<a id="svc-enable-banking-api-close-session"></a>
- **`app/services/enable_banking/api/close_session.rb`** (EnableBanking::Api::CloseSession): `DELETE /sessions/{session_id}`; inputs credential, session_id → Result; used best-effort by BR-087. [V]

<a id="svc-enable-banking-api-create-session"></a>
- **`app/services/enable_banking/api/create_session.rb`** (EnableBanking::Api::CreateSession): `POST /sessions {code}`; inputs credential, code → Result containing the full account objects; used by BR-075. [V]

<a id="svc-enable-banking-api-get-account-balances"></a>
- **`app/services/enable_banking/api/get_account_balances.rb`** (EnableBanking::Api::GetAccountBalances): `GET /accounts/{uid}/balances`; inputs credential, uid → Result; used by BR-092. [V]

<a id="svc-enable-banking-api-get-account-details"></a>
- **`app/services/enable_banking/api/get_account_details.rb`** (EnableBanking::Api::GetAccountDetails): `GET /accounts/{uid}/details`; inputs credential, uid → Result; used by BR-091. [V]

<a id="svc-enable-banking-api-get-account-transactions"></a>
- **`app/services/enable_banking/api/get_account_transactions.rb`** (EnableBanking::Api::GetAccountTransactions): paginated `GET /accounts/{uid}/transactions`; inputs credential, uid, date_from, date_to, transaction_status, max_pages (100) → Result with `transactions`, `pages_fetched`, `truncated`; implements BR-101, BR-102. [V]

<a id="svc-enable-banking-api-get-application"></a>
- **`app/services/enable_banking/api/get_application.rb`** (EnableBanking::Api::GetApplication): `GET /application`, the health check for a credential; input credential → Result (including `redirect_urls`); used by BR-055. [V]

<a id="svc-enable-banking-api-get-session"></a>
- **`app/services/enable_banking/api/get_session.rb`** (EnableBanking::Api::GetSession): `GET /sessions/{id}` (skinny response, account uids only); inputs credential, session_id → Result; used by BR-086, BR-107. [V]

<a id="svc-enable-banking-api-list-aspsps"></a>
- **`app/services/enable_banking/api/list_aspsps.rb`** (EnableBanking::Api::ListAspsps): `GET /aspsps[?country=]`; inputs credential, country → Result (`aspsps`); used by BR-066. [V]

<a id="svc-enable-banking-api-start-auth"></a>
- **`app/services/enable_banking/api/start_auth.rb`** (EnableBanking::Api::StartAuth): `POST /auth` with access, aspsp, state, redirect_url, psu_type; inputs credential, aspsp name and country, state, psu_type, valid_days (180) → Result (`url`); implements BR-067. [V]

<a id="svc-enable-banking-backfill-window"></a>
- **`app/services/enable_banking/backfill_window.rb`** (EnableBanking::BackfillWindow): per-bank history horizon; `days_for(slug)` → 90 / 780 / 90 / default 90; `default_date_from(slug, today)`; implements BR-100. [V]

<a id="svc-enable-banking-client"></a>
- **`app/services/enable_banking/client.rb`** (EnableBanking::Client): HTTP transport with per-request JWT, PSU headers, timeouts and error mapping; get / post / delete → Result (never raises on HTTP errors; status 0 on transport failure); implements BR-061, BR-062. [V]

<a id="svc-enable-banking-error"></a>
- **`app/services/enable_banking/error.rb`** (EnableBanking::Error, EnableBanking::ConfigError): exception types for configuration and key failures; not used for HTTP errors; implements BR-063. [I]

<a id="svc-enable-banking-jwt-signer"></a>
- **`app/services/enable_banking/jwt_signer.rb`** (EnableBanking::JwtSigner): signs an RS256 JWT for the provider API; input credential → token string, or ConfigError for a bad key; implements BR-060. [V]

<a id="svc-enable-banking-operations-base"></a>
- **`app/services/enable_banking/operations/base.rb`** (EnableBanking::Operations::Base): common `call` that turns configuration errors into the subclass's `Failed` with "Configuration error: …"; implements BR-063. [I]

<a id="svc-enable-banking-operations-close-connection"></a>
- **`app/services/enable_banking/operations/close_connection.rb`** (EnableBanking::Operations::CloseConnection): best-effort remote close plus local `closed` status; input connection → connection (never fails); implements BR-087. [V]

<a id="svc-enable-banking-operations-create-connection"></a>
- **`app/services/enable_banking/operations/create_connection.rb`** (EnableBanking::Operations::CreateConnection): turns an auth code into a connection and upserted accounts in one transaction, and marks any replaced connection; inputs credential, code, decoded state → connection, or Failed ("Could not create session: …" / "Could not save records: …"); implements BR-075, BR-076, BR-077, BR-078, BR-079, BR-080 (cross-tenant issue U-200). [V]

<a id="svc-enable-banking-operations-refresh-account-balances"></a>
- **`app/services/enable_banking/operations/refresh_account_balances.rb`** (EnableBanking::Operations::RefreshAccountBalances): fetches and stores raw balances; input account → account, or Failed; implements BR-092. [V]

<a id="svc-enable-banking-operations-refresh-account-details"></a>
- **`app/services/enable_banking/operations/refresh_account_details.rb`** (EnableBanking::Operations::RefreshAccountDetails): fetches details and overwrites only non-null fields, then re-syncs own-account rules; input account → account, or Failed; implements BR-091, BR-078. [V]

<a id="svc-enable-banking-operations-refresh-connection"></a>
- **`app/services/enable_banking/operations/refresh_connection.rb`** (EnableBanking::Operations::RefreshConnection): refreshes connection status, consent fields and validity from the session endpoint, expiring on 401/403/410; input connection → connection, or Failed; implements BR-086, BR-107. [V]

<a id="svc-enable-banking-operations-start-auth"></a>
- **`app/services/enable_banking/operations/start_auth.rb`** (EnableBanking::Operations::StartAuth): builds the signed state and requests the bank authorization URL; inputs credential, form, current_user, replaces_connection_id → URL string, or Failed "Failed to start auth: …"; implements BR-067, BR-068, BR-174. [V]

<a id="svc-enable-banking-operations-sync-account-transactions"></a>
- **`app/services/enable_banking/operations/sync_account_transactions.rb`** (EnableBanking::Operations::SyncAccountTransactions): fetches, normalises and upserts one account's transactions; inputs account, date_from, date_to → Outcome (inserted, updated, skipped, pages_fetched, truncated, date_from, date_to), or Failed; implements BR-100, BR-103, BR-104, BR-106, BR-107, BR-110. [V]

<a id="svc-enable-banking-operations-sync-connection-transactions"></a>
- **`app/services/enable_banking/operations/sync_connection_transactions.rb`** (EnableBanking::Operations::SyncConnectionTransactions): syncs every active account of a connection, isolating account failures and reporting progress; inputs connection, dates, on_account_synced → {account_id ⇒ Outcome or error}; implements BR-108. [V]

<a id="svc-enable-banking-operations-sync-user-transactions"></a>
- **`app/services/enable_banking/operations/sync_user_transactions.rb`** (EnableBanking::Operations::SyncUserTransactions): syncs all of a user's authorized connections; inputs user, dates, callback → {connection_id ⇒ per-account results}; implements BR-109. [V]

<a id="svc-enable-banking-operations-verify-credential"></a>
- **`app/services/enable_banking/operations/verify_credential.rb`** (EnableBanking::Operations::VerifyCredential): tests a credential against `/application`, persists the status, and reconciles the redirect URL; input credential → VerifyResult (`ok` / `warning` / `failed`, message, redirect_url_synced_to, registered_urls); implements BR-055. [V]

<a id="svc-enable-banking-payment-method-inferer"></a>
- **`app/services/enable_banking/payment_method_inferer.rb`** (EnableBanking::PaymentMethodInferer): derives the canonical payment method; inputs type_hint, bank_transaction_code, title, counterparty_name, direction → payment method or nil (logs warnings); implements BR-105, BR-171. [V]

<a id="svc-enable-banking-result"></a>
- **`app/services/enable_banking/result.rb`** (EnableBanking::Result): uniform provider response value (`success`, `status`, `data`, `headers`, `error`; `error_message` falls back to "HTTP <status>"); implements BR-062. [V]

<a id="svc-enable-banking-state"></a>
- **`app/services/enable_banking/state.rb`** (EnableBanking::State): signed OAuth state with a 30-minute TTL and nonce; `encode(...)` → token, `decode(token)` → payload Hash or nil; implements BR-068, BR-069, BR-175. [V]

<a id="svc-enable-banking-transaction-normalizer"></a>
- **`app/services/enable_banking/transaction_normalizer.rb`** (EnableBanking::TransactionNormalizer): maps a provider transaction to persistence attributes; inputs payload, bank_account, fetched_at → attribute Hash, or ArgumentError; implements BR-104, BR-111. [V]

<a id="svc-operation-run-finalizer"></a>
- **`app/services/operation_run_finalizer.rb`** (OperationRunFinalizer): sets a sync run's terminal status from the per-account outcomes; inputs run, summary → run succeeded, partial or failed; implements BR-141. [V]

<a id="svc-transaction-syncs-queuer"></a>
- **`app/services/transaction_syncs/queuer.rb`** (TransactionSyncs::Queuer): creates a queued manual `transaction_sync` run and enqueues the job; inputs user, bank_connection_id, date_from, date_to → `{success?, run, error_messages}`; implements BR-115. [V]


## Part B — Categories, merchants, rules, enrichment, LLM

Scope: the category taxonomy, merchants, merchant rules (the "matching engine"), transaction enrichment (classification of
every ledger row), the counterparty resolver, the LLM merchant-suggestion pipeline, LLM provider settings, and the seeders
that build the baseline taxonomy and the showcase data set.

Conventions used below:

- Paths are relative to the source checkout `src/` (commit `cd3bf605…`).
- "Spec" references are `spec/…_spec.rb:LINE` ids from `inventory/specs.json`. All 825 examples passed in `inventory/specs_run.json`,
  so a rule asserted by a cited spec is **[V]**.
- Oracle links are relative to `docs/`. The oracle ran as RAILS_ENV=development with two tenants seeded by `Seeders::Showcase`
  and with in-memory fakes for the external systems.
- Time: no `config.time_zone` is set, so the app zone is **UTC**. `Time.current` timestamps (`approved_at`, `enriched_at`, `archived_at`, `sent_at`)
  are UTC. The one exception is `Seeders::Showcase`, which wraps itself in `Time.use_zone("Europe/Warsaw")` (`app/services/seeders/showcase.rb:52`). Evidence that it is UTC: the oracle's
  connection-test prompt was `ping sent_at=2026-10-21T12:52:12Z` ([oracle](../oracle/operation_runs_after_capture.jsonl) run id 14) **[V]**.
- Money does not appear in classification rules. Classification never reads amounts (see BR-255).

---

<a id="br-200"></a>
### BR-200 Three-layer category model

- **Rule:** Classification uses three independent layers:
  1. **Layer 1 – `Category`** (one row per user): a hierarchical position (PostgreSQL `ltree` `path`, e.g. `food.cooking.supermarket`), an analytic role (`kind`), and the `essential` (need-vs-want) boolean. Categories can be soft-deleted with `archived_at`.
  2. **Layer 2 – per-transaction facets on `TransactionEnrichment`.** ADR 0010 says these are `recurring` + `recurrence_interval`, but **those columns do not exist** in the schema at this commit (see U-314).
  3. **Layer 3 – free-form tags** (gutentag) on `TransactionEnrichment`.

  `path` is the source of truth for the hierarchy. A rename changes `name` only.
- **Evidence:** `docs/adr/0010-three-layer-category-model.md:18-40`; `app/models/category.rb:34-37`; `app/models/transaction_enrichment.rb:42` (gutentag); `inventory/schema.rb` (no `recurring` column); `inventory/views_sql/ledger_entries_v04.sql:9-11`.
- **Status:** [I] for the layer split. Columns verified against `inventory/schema.rb`.
- **Covered by:** `spec/models/ledger_entry_spec.rb:209` mirrors category_path to the resolved category's ltree path; `spec/models/ledger_entry_spec.rb:285` re-categorizes rows on the fly when a Category's kind changes (no re-enrichment).

<a id="br-201"></a>
### BR-201 Category kinds

- **Rule:** `kind` ∈ {`expense`, `income`, `transfer`, `savings`, `ignored`}. The default for a new category is `expense` (DB default; the admin "new" form also preselects `expense`). Analytics must partition by `kind` before summing. Changing a category's `kind` re-classifies every row that resolves to it on the next query, with no re-enrichment. Any other value fails validation with `Kind is not included in the list`. The API/HTML returns 422 for it.
- **Evidence:** `app/models/category.rb:39,55`; `app/controllers/admin/categories_controller.rb:13`; AGENTS.md "Always partition by `Category#kind`"; ADR 0010:32-34.
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:135` rejects a kind value outside the canonical list and accepts every member of KINDS; `spec/models/ledger_entry_spec.rb:285`. [oracle](../oracle/http/PUT_admin_categories__id.json) case `invalid_kind` (`kind=luxury`) → 422.

<a id="br-202"></a>
### BR-202 Category field validations (exact messages)

- **Rule:** On save:
  - `name` is required → `Name can't be blank`.
  - `slug` is required and must match `^[a-z0-9_\-]+$` → `Slug must be lowercase letters, digits, underscores, dashes`.
  - `path` is required and must match `^[a-z0-9_]+(\.[a-z0-9_]+)*$` (lowercase ltree labels joined by `.`) → `Path must be lowercase letters, digits, underscores, dot-separated`. Dashes are allowed in a slug but **not** in a path label, so a slug containing `-` can never be composed into a valid path.
  - `kind` must be in KINDS (BR-201).
  - Optional attributes: `color` (free string token, e.g. `emerald`), `icon` (icon file name), `position` (integer, default 0, "Lower = higher on the list within its level"), `essential` (default false).
  - The admin form permits exactly `name slug parent_path kind color icon position essential`.
- **Evidence:** `app/models/category.rb:46,52-57`; `app/controllers/admin/categories_controller.rb:80-82`; `app/views/admin/categories/_form.html.erb:15-60`.
- **Status:** [V] for the name and slug-format messages. [I] for the others.
- **Covered by:** `spec/models/category_spec.rb:36` rejects slug values that violate the format; `spec/system/settings_change_spec.rb:86` blank name → 422 with "can't be blank"; `spec/system/settings_change_spec.rb:99` renders a friendly 422 instead of a 500 when the slug fails its format; `spec/requests/categorization_spec.rb:47`. [oracle](../oracle/http/POST_admin_categories.json) case `invalid_blank_name` → 422 re-rendering "New category".

<a id="br-203"></a>
### BR-203 Slug and path uniqueness per user

- **Rule:** `slug` is unique per user (`Slug has already been taken`). `path` is unique per user (`Path has already been taken`). Both have DB unique indexes on `(user_id, slug)` and `(user_id, path)`. The path uniqueness check runs **only when the path matches the ltree format**. Otherwise only the format error is reported: a malformed value would make the uniqueness SELECT fail with a PG syntax error, which would surface as a 500 instead of a 422. Different users may hold identical slugs and paths. Slug uniqueness is tree-wide, not per parent: `food.other` and `income.other` cannot both have slug `other`.
- **Evidence:** `app/models/category.rb:41-58,131-133`; `app/models/category.rb:26-27` (indexes).
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:52` scopes slug uniqueness per user; `spec/models/category_spec.rb:63` scopes path uniqueness per user; `spec/services/categories/creator_spec.rb:47`; `spec/system/settings_change_spec.rb:99`.

<a id="br-204"></a>
### BR-204 Slug back-fill from path; slug and path leaf are independent

- **Rule:** Before validation, if `path` is present and `slug` is blank, `slug` is set to the last `.`-segment of `path`. If `slug` is present and differs from the last segment, **nothing is changed**. Slug and path leaf can therefore diverge. They always diverge for seeded categories: slug `food_cooking_supermarket` vs leaf `supermarket` (BR-213). `slug` is the stable identifier used in URLs such as `/admin/analytics/categories/:slug`. `path` is the hierarchy.
- **Evidence:** `app/models/category.rb:60,135-140`; `app/services/seeders/categories.rb:178`; `app/views/admin/shared/components/_category_breadcrumb.html.erb:17`.
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:76` fills slug from the last segment of path when slug is blank, and leaves an explicit slug alone.

<a id="br-205"></a>
<a id="br-205"></a>
### BR-205 Creating a category (slug generation, path composition)

- **Rule:** Inputs: `attributes` (name, slug, kind, color, icon, position, essential) and an optional `parent_path`.
  1. If `slug` is **nil**, it is generated from `name`:
     - lowercase;
     - remove combining marks (`\p{M}`). There is **no** Unicode decomposition first, so precomposed letters such as `ż`, `ó`, `ł`, `é` are *not* reduced to ASCII;
     - replace every run of characters outside `[a-z0-9]` with `_`;
     - collapse `__+` to `_`;
     - trim a leading or trailing `_`.

     Examples (pure-Ruby evaluation of the same expression): `Mobilność` → `mobilno`, `Café Nero` → `caf_nero`, `Łódź Kebab` → `d_kebab`, `Москва` → `""` (see U-305).
  2. Collision numbering: if the user already has that slug, try `<base>_2`, `<base>_3`, … until one is free. The check covers archived categories too.
  3. `path` = `slug` when `parent_path` is blank, else `"<parent_path>.<slug>"`.
  4. Save. Success → `Result(success?: true, category)`. Failure → `Result(success?: false, category, error_messages = full messages)`.

  The parent path is **not** checked for existence or archived state. A non-existent parent produces an orphan path that is valid as far as the server is concerned [I].

  Because the admin form always submits `category[slug]`, a blank form field arrives as `""` (not nil) and skips generation. The resulting create fails validation (see U-301) [I].
- **Evidence:** `app/services/categories/creator.rb:19-52`; `app/views/admin/categories/_form.html.erb:21-25`.
- **Status:** [V] for generation, numbering and composition. [I] for the blank-string form path and the orphan parent.
- **Covered by:** `spec/services/categories/creator_spec.rb:6` creates a root category, deriving the slug from the name; `spec/services/categories/creator_spec.rb:17` creates a child under parent_path; `spec/services/categories/creator_spec.rb:28` auto-numbers a slug collision (groceries → groceries_2); `spec/services/categories/creator_spec.rb:39` blank name → failure; `spec/requests/api/v1/categorization_spec.rb:34`; `spec/requests/mcp/tools_spec.rb:43`. [oracle](../oracle/http/POST_admin_categories.json) case `default` (`name="Oracle UI Category"`, `parent_path=food`, no slug key) → 302 to `/admin/categories`. The server log shows the created path `food.oracle_ui_category` (`../oracle/server.log.txt` around line 16560).
- **Admin UI:** success → redirect `/admin/categories` with notice `Category created.`. Failure → re-render "New category" with 422 (`app/controllers/admin/categories_controller.rb:17-31`).

<a id="br-206"></a>
<a id="br-206"></a>
### BR-206 Updating / moving a category (descendant path rewrite)

- **Rule:** Inputs: the category, `attributes`, and an optional `parent_path`.
  - If `parent_path` is **present**, a candidate path `"<parent_path>.<slug>"` is built. `slug` is the new slug if submitted, else the current one. The candidate is assigned to `path` only if it matches the ltree format. Otherwise `path` is left unchanged and the slug-format error is reported.
  - The update runs inside one DB transaction. If the save succeeds **and** `path` actually changed, every descendant of the old path in the *same user's* tree (`path <@ old AND path != old`) is rewritten with a single UPDATE to `new_path || subpath(path, nlevel(old_path))`.
  - No path change (same parent) → no descendant rewrite. A validation failure → no rewrite and `Result(success?: false, error_messages)`.
  - If `parent_path` is **blank**, the path is never recomputed. Consequences:
    - choosing "- top-level (new root) -" in the form does **not** move the category to the root;
    - changing only the slug leaves the path leaf unchanged.
  - The server does not prevent moving a category under its own descendant (the form hides those options, the API does not) (U-302).
- **Evidence:** `app/services/categories/mover.rb:23-62`; `app/views/admin/categories/_form.html.erb:3-9,28-35`.
- **Status:** [V] for the move and rewrite behaviour. [I] for the root-move and cycle gaps.
- **Covered by:** `spec/services/categories/mover_spec.rb:14` moves a leaf; `:26` moves an entire subtree with one UPDATE; `:39` same-parent move is a no-op; `:50` no rewrite on validation failure; `:61` scopes the descendant rewrite to the moving category's user; `spec/requests/api/v1/categorization_spec.rb:68`. [oracle](../oracle/http/PATCH_admin_categories__id.json) case `default` → 302. [oracle](../oracle/http/PUT_admin_categories__id.json) `invalid_kind` → 422.
- **Admin UI:** success → `/admin/categories` with notice `Category updated.`. Failure → re-render edit with 422.

<a id="br-207"></a>
<a id="br-207"></a>
### BR-207 Tree navigation helpers (and their missing tenant scope)

- **Rule:** Definitions:
  - depth = number of `.` in path; a root has depth 0;
  - `self_and_descendants` = `path <@ P`;
  - `descendants` = `path <@ P AND path != P`;
  - `children` = `path ~ 'P.*{1}'`;
  - `ancestors` = `path @> P AND path != P`;
  - `parent` = the category whose path is P without its last label;
  - breadcrumb = ancestors ordered by `nlevel(path)` + self, names joined with ` / `;
  - `under_path(x)` accepts a Category, a path string, or an array of both, and returns the OR of `path <@ x`. An empty input returns nothing.

  **These helpers are not scoped to the user.** They query the whole `categories` table. With two tenants holding the same seeded tree, every breadcrumb shows each ancestor twice ("Jedzenie / Jedzenie / W domu / W domu / Supermarkety"), and `in_use?` (BR-209) sees other tenants' descendants. A Kotlin rebuild must scope these queries by `user_id` (U-300).
- **Evidence:** `app/models/category.rb:70-119`. SQL in `../oracle/server.log.txt`: `SELECT 1 … FROM "categories" WHERE (path <@ 'food.oracle_ui_category' AND path != …)` with no `user_id` predicate.
- **Status:** [V] (oracle).
- **Covered by:** `spec/models/category_spec.rb:103` exposes ltree helpers over a 3-level tree (single user); `spec/models/category_spec.rb:119` under_path. Cross-tenant behaviour is untested. Oracle: [merchant show](../oracle/ui/admin_merchants_show.html) shows `Jedzenie / Jedzenie / W domu / W domu / Supermarkety`, and [merchants index](../oracle/ui/admin_merchants_index.html) shows the same pattern.

<a id="br-208"></a>
### BR-208 Archive and unarchive a category

- **Rule:**
  - `archive` sets `archived_at = now` only if not already archived. It is idempotent: a second call keeps the original timestamp.
  - `unarchive` sets `archived_at = NULL`.
  - Neither cascades to descendants.
  - Archiving keeps every existing link (merchant defaults, enrichment overrides). Analytics continue to attribute spend to an archived category.
- **Evidence:** `app/models/category.rb:76-81`; `app/controllers/admin/categories_controller.rb:64-72`.
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:88` archive! is idempotent; `spec/requests/categorization_spec.rb:150` and `:161`; `spec/requests/api/v1/categorization_spec.rb:102`; `spec/system/settings_change_spec.rb:55` keeps an archived category attributing spend to the same enrichment rows in analytics. Oracle: [archive](../oracle/http/POST_admin_categories__id_archive.json) → 302, [unarchive](../oracle/http/POST_admin_categories__id_unarchive.json) → 302.
- **Admin UI:** notices `Category archived.` and `Category restored.`. Both redirect to `/admin/categories`.

<a id="br-209"></a>
### BR-209 Deleting a category

- **Rule:** A category may be hard-deleted only if it is **not in use**. In use means any of:
  - it has descendants (unscoped across tenants, BR-207);
  - a merchant has it as `default_category`;
  - an enrichment has it as explicit `category`.

  If in use → no change and redirect to `/admin/categories` with alert `Can't delete - this category is in use or has sub-categories. Archive it instead.`. Otherwise it is destroyed: merchant defaults and enrichment categories referencing it are nullified (no-ops given the guard), with notice `Category deleted.`.

  `user_hidden_categories` rows are not considered and have no dependent rule. Deleting an otherwise unused category that the user has marked hidden would hit the FK `user_hidden_categories.category_id → categories.id` (U-303) [I].
- **Evidence:** `app/models/category.rb:49-50,112-114`; `app/controllers/admin/categories_controller.rb:54-62`; `app/models/user_hidden_category.rb:19-22`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:125` refuses an in-use category and keeps the row; `:138` deletes an unused category; `spec/requests/api/v1/categorization_spec.rb:79,91`. [oracle](../oracle/http/DELETE_admin_categories__id.json) `default` → 302 (the log shows the three in_use checks, then `DELETE FROM "categories" WHERE id = 239`), and `other_tenant_id` → 404.

<a id="br-210"></a>
### BR-210 Where archived categories appear

- **Rule:** Archived categories are excluded from:
  - the main table on `/admin/categories` (they appear in a separate "Archived" card with a Restore button);
  - every category picker (`_category_picker`, the classify modal, the parent-path select);
  - the LLM prompt's list of category paths (BR-255).

  They remain resolvable by path for LLM suggestions (BR-261) and as fallback targets (BR-234). The API lists only active categories unless `include_archived=true`.
- **Evidence:** `app/controllers/admin/categories_controller.rb:8-9`; `app/views/admin/categories/index.html.erb:75-95`; `app/views/admin/shared/components/_category_picker.html.erb:4`; `app/views/admin/bank_transactions/_classify_modal.html.erb:16`; `app/views/admin/categories/_form.html.erb:5`; `app/services/llm/merchant_suggester.rb:210`; `lib/api/resources/categories.rb:12-16`.
- **Status:** [V] for the API flag. [I] for the views.
- **Covered by:** `spec/requests/api/v1/categorization_spec.rb:6`, `:22`; `spec/requests/categorization_spec.rb:6`.

<a id="br-211"></a>
<a id="br-211"></a>
### BR-211 Hidden categories: definition and settings

- **Rule:**
  - A user marks specific categories as hidden. These are `user_hidden_categories` rows, unique per (user, category). A duplicate fails with `Category has already been taken`.
  - Hiding is **subtree-aware**: hiding `food` hides every category whose path is under any hidden path. The hidden set is computed per request as category ids with `path <@ any hidden path`, scoped to the user's own categories.
  - If the user flag `reveal_hidden_categories` is true, nothing is hidden. `hides_category?` returns false for every input, including blank.
  - The preferences "App" form (`PATCH /admin/settings/preferences/app`) permits `track_cash`, `reveal_hidden_categories` and `hidden_category_ids[]`. An omitted multi-select is coerced to `[]`, which clears all hidden categories. Ids are not restricted to the user's own categories. A foreign id creates an ineffective row, and an unknown id gives a 404 (U-320) [I].
  - This is independent of the cookie-based privacy mode.
- **Evidence:** `app/models/user.rb:46-66`; `app/models/user_hidden_category.rb:24-32`; `app/controllers/admin/settings/preferences_controller.rb:107-114`.
- **Status:** [V]
- **Covered by:** `spec/models/user_spec.rb:27` true for hides_category? on every descendant of an explicitly hidden parent; `spec/models/user_spec.rb:43`; `spec/models/user_hidden_category_spec.rb:27`, `:37`; `spec/requests/settings_spec.rb:116` forces hidden_category_ids to [] when the multi-select is omitted. [oracle](../oracle/http/PATCH_admin_settings_preferences_app.json) → 302.

<a id="br-212"></a>
### BR-212 Hidden categories: effect on screens

- **Rule:** When `hides_category?(category)` is true:
  - **Masking.** Names and paths are masked server-side; the real value never reaches the HTML.
    - Text masking replaces a value with `•` × min(length, 24). Blank values stay blank. A caller-supplied fixed mask (used for amounts) replaces the value entirely.
    - Breadcrumbs render `•••` and are not linked.
    - In the classify modal, merchants whose default category is hidden show as `•••`, as do hidden categories.
  - **Pickers.** Hidden categories are omitted from the category picker and from the parent-path select.
  - **Redirects.**
    - `GET /admin/categories/:id/edit` redirects to `/admin/categories` with alert `This category is private. Remove it from the hidden list in preferences to edit it.`
    - `GET /admin/merchants/:id` where the merchant's default category is hidden redirects to `/admin/merchants` with alert `This merchant is in a hidden category. Remove it from the hidden list in preferences to open it.`
    - `GET /admin/bank_transactions/:id` whose effective category is hidden redirects with alert `This transaction is in a hidden category. Remove it from the hidden list in preferences to open it.`
  - **Merchant edit is not guarded.** The intended redirect for `GET /admin/merchants/:id/edit` (alert `…to edit it.`) is dead code. `MerchantsController` defines `edit` twice and the later empty definition wins, so the edit page renders (U-304) [I].
- **Evidence:** `app/helpers/admin/hide_private_helper.rb:6-21`; `app/views/admin/shared/components/_category_breadcrumb.html.erb:4-6`; `app/views/admin/bank_transactions/_classify_modal.html.erb:7-18`; `app/views/admin/shared/components/_category_picker.html.erb:6`; `app/controllers/admin/categories_controller.rb:33-38`; `app/controllers/admin/merchants_controller.rb:20-25,37-42,58-59`; `app/controllers/admin/bank_transactions_controller.rb:31-35`.
- **Status:** [V] for the category edit and merchant show redirects. [I] for the rest.
- **Covered by:** `spec/requests/categorization_spec.rb:82` edit redirects when the category is hidden; `spec/requests/categorization_spec.rb:231` merchant show redirects when the default category is hidden.

<a id="br-213"></a>
<a id="br-213"></a>
### BR-213 Baseline taxonomy (`Seeders::Categories`)

- **Rule:**
  - Creates or updates **118** categories for a user: 10 roots, 30 depth-1 nodes, 78 depth-2 leaves. The full list is in `DEFINITIONS`, with Polish names, `kind` and `essential` per row.
  - Each row is keyed on `slug = path with '.' replaced by '_'` (e.g. `food.cooking.supermarket` → `food_cooking_supermarket`).
  - Every run assigns `name`, `kind`, `essential` (default false), `path`, `position` = index in `DEFINITIONS` (0-based), `icon` (only roots carry one) and `color` = palette by root domain:

    | Domain | Color |
    |---|---|
    | food | emerald |
    | mobility | blue |
    | home | amber |
    | health | rose |
    | lifestyle | violet |
    | education | indigo |
    | services | slate |
    | income | green |
    | money | gray |
    | noise | zinc |

  - Root kinds:
    - `food`, `mobility`, `home`, `health`, `lifestyle`, `education`, `services` are `expense`;
    - `income` is `income`;
    - `money` is `transfer`, except `money.savings.*` and `money.investments.*`, which are `savings`;
    - `noise` is `ignored`. `noise.unmatched.*` is however `expense` ("real spend without a known merchant"). `noise.authorizations.*` and `noise.adjustments.*` remain `ignored`.
  - Idempotent: it never deletes and never duplicates. A re-run **overwrites** user edits to those attributes on seeded rows (U-315).
  - Callers: first-run setup, `POST /admin/onboarding/seed_taxonomy`, `Seeders::Showcase`.
- **Evidence:** `app/services/seeders/categories.rb:6-192`; `app/controllers/setup_controller.rb:18`; `app/controllers/admin/onboarding_controller.rb:9`.
- **Status:** [V]
- **Covered by:** `spec/services/seeders/categories_spec.rb:6` seeds the full category tree on first run; `:18` is idempotent; `:31` scopes per user.

<a id="br-214"></a>
### BR-214 Onboarding "load baseline taxonomy"

- **Rule:** `POST /admin/onboarding/seed_taxonomy` (signed-in user only):
  1. runs `Seeders::Categories` then `Seeders::MerchantRules` for the current user only;
  2. runs a full re-enrichment rebuild (BR-235);
  3. redirects back to the Referer (fallback `/admin`) with notice `Baseline taxonomy loaded - <N> categories, <M> system merchants. Existing transactions reclassified.`, where N = the user's total category count and M = the user's merchants with `source = system`.

  Anonymous users are redirected to sign-in. The AI Enrichment page offers this action ("Load baseline taxonomy") when the user has no active categories.
- **Evidence:** `app/controllers/admin/onboarding_controller.rb:8-15`; `app/views/admin/llm_enrichments/index.html.erb:6-13`.
- **Status:** [V]
- **Covered by:** `spec/requests/onboarding_spec.rb:6`, `:22` honors the Referer header, `:34` passes only the current user, `:49` anonymous → sign-in. [oracle](../oracle/http/POST_admin_onboarding_seed_taxonomy.json) → 302 `/admin`.

---

<a id="br-215"></a>
### BR-215 Merchant attributes and validations

- **Rule:**

  | Attribute | Constraint |
  |---|---|
  | `name` | required → `Name can't be blank` |
  | `slug` | required, unique per user, format `^[a-z0-9_\-]+$` → `Slug is invalid` (default message) / `Slug has already been taken` |
  | `source` | ∈ {`system`, `user`, `llm`} |
  | `kind` | optional, ∈ {`company`, `person`, `charity`, `government`, `platform`, `other`} |
  | `confidence` | optional decimal(4,3), 0.0..1.0 inclusive |
  | other | `default_category` (optional FK), `approved_at`/`approved_by`, `archived_at`, `logo_url`, `notes`, `model` |

  - "Approved" means `approved_at` is not null. "Pending" means `source = llm AND approved_at IS NULL`.
  - The admin form permits `name slug kind default_category_id logo_url notes`.
  - Destroying a merchant destroys its rules and nullifies `transaction_enrichments.merchant_id`.
- **Evidence:** `app/models/merchant.rb:45-71`; `app/controllers/admin/merchants_controller.rb:105-107`.
- **Status:** [V]
- **Covered by:** `spec/models/merchant_spec.rb:71` slug uniqueness per user; `:82` confidence boundary; `:95` pending scope; `:106` nullifies enrichment merchant_id on destroy. [oracle](../oracle/http/POST_admin_merchants.json) `invalid_blank_name` → 422; [oracle](../oracle/http/PUT_admin_merchants__id.json) `invalid_blank_name` → 422.

<a id="br-216"></a>
### BR-216 Merchant slug generation (two algorithms)

- **Rule:**
  - **(a) Model fallback.** Used when the slug is still blank at validation. Steps: NFD-normalize, lowercase, strip combining marks, replace non-`[a-z0-9]` runs with `_`, collapse `_`, trim. If the result is empty → `merchant_<8 hex chars>` (random). Examples: `Żabka` → `zabka`, `Café Nero` → `cafe_nero`.
  - **(b) Creator, LLM runner and categories.** Same steps **without** NFD: `Żabka` → `abka`, `Łódź Kebab` → `d_kebab`.
    - `Merchants::Creator` adds collision numbering (`_2`, `_3`, …).
    - The LLM runner has no numbering. It *reuses* an existing merchant with that slug (BR-259) and falls back to `merchant_<hex>` when empty.

  A pre-set non-blank slug is never overwritten (see U-305).
- **Evidence:** `app/models/merchant.rb:83-88`; `app/services/merchants/creator.rb:35-44`; `app/services/llm/enrichment_runner.rb:179-182`.
- **Status:** [V] for (a). [I] for the (b) examples, reproduced by evaluating the same Ruby expressions in isolation.
- **Covered by:** `spec/models/merchant_spec.rb:43` auto-generates a slug, stripping diacritics; `:56` falls back to merchant_<hex>; `:64` preserves a pre-set slug; `spec/system/llm_enrichment_spec.rb:16` (LLM names `Devstyle` → `devstyle`, `P.U.N.K.T` → `p_u_n_k_t`).

<a id="br-217"></a>
<a id="br-217"></a>
### BR-217 Creating a merchant (user)

- **Rule:** `Merchants::Creator`:
  1. builds the merchant from the submitted attributes;
  2. forces `source = user`, `approved_at = now`, `approved_by = the user`;
  3. if the slug is blank, generates it with algorithm (b) and collision numbering. A base that comes out empty falls through to the model fallback `merchant_<hex>`;
  4. saves. Success → `Result(success?, merchant)`. Failure → `Result(success?: false, merchant, error_messages)`.

  A user merchant does **not** trigger re-enrichment. It only takes effect through rules (BR-224) or manual classification (BR-237).
- **Evidence:** `app/services/merchants/creator.rb:18-31`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:244`, `:259`; `spec/requests/api/v1/categorization_spec.rb:142`. [oracle](../oracle/http/POST_admin_merchants.json) `default` → 302 `/admin/merchants/60`.
- **Admin UI:** notice `Merchant created.` and redirect to the merchant page. Failure → re-render "New merchant" with 422.

<a id="br-218"></a>
### BR-218 Updating a merchant; retroactive default-category effect

- **Rule:** `PATCH /admin/merchants/:id` updates the permitted attributes.
  - A change to `default_category_id` immediately changes the effective category of **every** enrichment pointing at this merchant that has no explicit category (BR-232). This is a read-time effect, so no rebuild is needed; the change is only logged.
  - Redirect to `return_to` if it is a safe local path, else to the merchant page, with notice `Merchant updated.`.
  - Failure → re-render edit with 422.
  - Another tenant's id → 404.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:61-71`; `app/models/merchant.rb:41-43`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:273` safe return_to; `:286` hostile return_to falls back; `spec/models/concerns/ledger_entry_concern_spec.rb:46` falls back to the merchant default category. [oracle](../oracle/http/PATCH_admin_merchants__id.json) `default` → 302 and `other_tenant_id` → 404.

<a id="br-219"></a>
### BR-219 Archive and unarchive a merchant

- **Rule:**
  - Archive sets `archived_at = now` (not idempotent: it re-stamps). Notice `Merchant archived.`, redirect to `return_to` or `/admin/merchants`.
  - Unarchive clears it. Notice `Merchant restored.`, redirect to `return_to` or the merchant page.
  - Archived merchants are hidden from the merchant list unless `show_archived=1`, and from the classify modal's merchant choices.
  - **The merchant's rules keep matching**: the enricher does not filter on `merchant.archived_at` (U-310) [I].
- **Evidence:** `app/controllers/admin/merchants_controller.rb:9,83-91`; `app/controllers/admin/bank_transactions_controller.rb:38`; `app/services/enrichment/transaction_enricher.rb:135-138`.
- **Status:** [V] for archive. [I] for rule behaviour.
- **Covered by:** `spec/requests/categorization_spec.rb:324`. Oracle: [archive](../oracle/http/POST_admin_merchants__id_archive.json) → 302 `/admin/merchants`; [unarchive](../oracle/http/POST_admin_merchants__id_unarchive.json) → 302 `/admin/merchants/60`.

<a id="br-220"></a>
### BR-220 Deleting a merchant

- **Rule:** If any `transaction_enrichments.merchant_id` references the merchant → no change and redirect to the merchant page with alert `Can't delete - this merchant has linked transactions. Archive it instead.`. Otherwise destroy the merchant and its rules, then redirect to `return_to` or `/admin/merchants` with notice `Merchant deleted.`.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:73-81`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:299`, `:314`; `spec/requests/api/v1/categorization_spec.rb:174`. [oracle](../oracle/http/DELETE_admin_merchants__id.json) → 302 `/admin/merchants`.

<a id="br-221"></a>
<a id="br-221"></a>
### BR-221 Approving a merchant (LLM review queue)

- **Rule:** `Merchants::Approver` runs in one DB transaction:
  1. set `approved_at = now`, `approved_by = actor` on the merchant;
  2. for every rule of this merchant with `source = llm AND enabled = false`, set `enabled = true`, `approved_at = now`, `approved_by = actor`. Already-enabled rules are untouched.

  After commit it runs a full rebuild for the merchant's owner (BR-235), and the controller redirects to `return_to` or the merchant page with notice `Approved - historical transactions re-classified.`. Any merchant can be approved, whatever its source.
- **Evidence:** `app/services/merchants/approver.rb:14-23`; `app/controllers/admin/merchants_controller.rb:93-97`.
- **Status:** [V]
- **Covered by:** `spec/services/merchants/approver_spec.rb:6`, `:19`, `:32` idempotency on re-approval, `:44` rebuild after approval; `spec/requests/categorization_spec.rb:334`; `spec/requests/api/v1/categorization_spec.rb:187`; `spec/requests/mcp/tools_spec.rb:62`, `:77`. [oracle](../oracle/http/POST_admin_merchants__id_approve.json) → 302.

<a id="br-222"></a>
### BR-222 Merchant list filters (admin)

- **Rule:** `GET /admin/merchants` lists the current user's merchants:
  - active only, unless `show_archived=1`;
  - optional exact `source=`;
  - optional `category_id=` (exact default category, no subtree);
  - optional `q=` → `name ILIKE '%q%'` (no escaping of `%`/`_`).

  Ordered by `name`, offset-paginated. Each row shows the number of enrichments linked to the merchant.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:7-18`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:172`, `:186` filters by source, `:198` free-text q. [oracle](../oracle/http/GET_admin_merchants.json) `filtered` (`show_archived=1&source=seed&q=a`) → 200. `seed` is not a valid source, so the list is empty.

<a id="br-223"></a>
### BR-223 Merchant detail page data

- **Rule:** `GET /admin/merchants/:id`:
  - is subject to the hidden-category guard (BR-212);
  - lists the merchant's rules ordered by `source` **alphabetically** then `priority DESC`. This display order is not the matching order, although the page states "First match wins. Order: user > llm > system, then higher priority within source.";
  - shows the total linked transactions and the 10 most recent linked bank transactions by `booking_date DESC`;
  - offers a new-rule form defaulting to `field=title`, `kind=contains`.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:20-35`; [oracle UI](../oracle/ui/admin_merchants_show.html).
- **Status:** [V] (oracle page).
- **Covered by:** `spec/requests/categorization_spec.rb:210`, `:220` 404 for another user's merchant. [oracle](../oracle/http/GET_admin_merchants__id.json) `other_tenant_id` → 404.

---

<a id="br-224"></a>
### BR-224 Merchant rule attributes and validations

- **Rule:**

  | Attribute | Constraint |
  |---|---|
  | `kind` | ∈ {`contains`, `regex`, `exact`, `prefix`, `iban`}. The kinds `equals`, `starts_with` and `ends_with` do **not** exist; `exact` = equals, `prefix` = starts-with, there is no ends-with |
  | `field` | ∈ {`title`, `counterparty_name`, `counterparty_iban`, `payment_method`} |
  | `source` | ∈ {`system`, `user`, `llm`} |
  | `pattern` | required → `Pattern can't be blank` |
  | `confidence` | optional, 0.0..1.0 |
  | `case_sensitive` | default false |
  | `priority` | integer, default 0 |
  | `enabled` | default true |
  | other | `approved_at`/`approved_by`, `model` |

  - For `kind = regex`, the pattern must compile → `Pattern is not a valid regex: <engine message>`. The same string is accepted for non-regex kinds.
  - Rule CRUD params permitted from the admin form: `kind field pattern case_sensitive priority enabled`.
- **Evidence:** `app/models/merchant_rule.rb:44-62,91-96`; `app/controllers/admin/merchant_rules_controller.rb:41-43`.
- **Status:** [V]
- **Covered by:** `spec/models/merchant_rule_spec.rb:83` rejects an invalid regex pattern with a :pattern error; `:109` confidence boundary. [oracle](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json) `invalid_regex` (`([`) → 302 with alert; [oracle](../oracle/http/PUT_admin_merchants__merchant_id_merchant_rules__id.json) `invalid_blank_pattern` → 302 with alert.

<a id="br-225"></a>
<a id="br-225"></a>
### BR-225 Rule matching semantics per kind

- **Rule:** `matches?(value)`:
  - A blank value (nil, empty, whitespace-only) never matches.
  - Unless `case_sensitive`, both the value and the pattern are lowercased first. This is Ruby `String#downcase`, a full Unicode lowercase mapping; a Kotlin port should use `lowercase()` with a root locale.
  - Per kind:
    - `contains` → the value contains the pattern as a substring;
    - `exact` → whole-string equality;
    - `prefix` → the value starts with the pattern;
    - `iban` → remove all whitespace from both sides, uppercase both, compare equal. `case_sensitive` is ignored;
    - `regex` → unanchored search of the pattern in the **original** value, compiled with ignore-case unless `case_sensitive`.
  - There is no trimming, accent folding or `TitleNormalizer` step: rules see the raw stored field value.
  - There is no regex timeout, so ReDoS is possible (U-313).
- **Evidence:** `app/models/merchant_rule.rb:69-89`.
- **Status:** [V] for contains, exact, iban and regex. [I] for prefix (no spec).
- **Covered by:** `spec/models/merchant_rule_spec.rb:42` contains case-insensitive by default and respects case_sensitive; `:52` iban whitespace/upcase; `:61` regex, blank value, ignorecase; `:73` exact; `spec/services/enrichment/transaction_enricher_spec.rb:43`.

<a id="br-226"></a>
<a id="br-226"></a>
### BR-226 Rule resolution order: first match wins

- **Rule:** For one user, the enricher loads **all enabled** rules of that user, across all fields, into one list sorted by:
  1. `SOURCE_RANK` DESC, with user = 2, llm = 1, system = 0 and any unknown source = −1;
  2. `priority` DESC;
  3. `id` ASC.

  For each transaction it walks the list and takes the **first** rule for which:
  - the transaction type exposes the rule's field. Polymorphic ledger types: a manual (cash) transaction lacking e.g. `counterparty_iban` counts as a non-match, not an error;
  - the field value is non-blank;
  - `matches?` is true.

  This is first-match, not best-match: a user rule on `counterparty_name` beats a system rule on `title`, whatever the priorities. Disabled rules are ignored. The rule list is loaded once per enricher instance, i.e. once per `enrich_pending`/`rebuild!` call.

  The Matching Engine page reproduces the same order in SQL: `CASE source WHEN 'user' THEN 2 WHEN 'llm' THEN 1 WHEN 'system' THEN 0 ELSE -1 END DESC, priority DESC, id ASC`.
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:4-6,133-148`; `app/models/merchant_rule.rb:50,83`; `app/controllers/admin/matching_engine_controller.rb:8-9`; ADR 0005:16-17; ADR 0002:21-23.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:14` ranks user above llm above system; `:30` tie-breaks by priority DESC then id ASC; `:54` skips a rule whose field is missing on the polymorphic enrichable; `spec/models/merchant_rule_spec.rb:95`; `spec/system/categorization_workflow_spec.rb:16`, `:103` user rule beats an LLM-source rule.

<a id="br-227"></a>
### BR-227 Priority conventions used by the system

- **Rule:** Priority values assigned by code (higher wins within a source tier):

  | Rule | Source | Priority |
  |---|---|---|
  | Seeded retail (title/counterparty contains) | system | 0 (kept on re-seed) |
  | Own-account IBAN rules | system | 200 |
  | Seeded top-up rules | system | 250 |
  | Seeded ATM rule (`payment_method exact blik_atm`) | system | 300 |
  | LLM-generated rules | llm | 50 |
  | Rule from the classify modal "create_rule" | user | 100 |
  | Rule from the merchant page form / API | user | as submitted, default 0 |

  Because source ranks first, every user rule beats every llm rule, and every llm rule beats every system rule.
- **Evidence:** `app/services/seeders/merchant_rules.rb:69,94,125`; `app/services/enrichment/own_account_merchant_syncer.rb:14`; `app/services/llm/enrichment_runner.rb:173`; `app/services/enrichment/classification_applier.rb:87`.
- **Status:** [V] for the seeded 0 and 300 values. [I] for the others.
- **Covered by:** `spec/services/seeders/merchant_rules_spec.rb:6`, `:24`.

<a id="br-228"></a>
<a id="br-228"></a>
### BR-228 Rule create, update and delete from the merchant page

- **Rule:** All under `/admin/merchants/:merchant_id/merchant_rules`. The merchant is looked up within the current user and the rule within that merchant; misses return 404.
  - **Create** (`MerchantRules::Creator`):
    - build with the permitted attributes, forcing `user = actor`, `source = user`, `approved_at = now`, `approved_by = actor`;
    - on success, run a full rebuild (BR-235). Notice `Rule added - historical transactions re-classified.`;
    - on failure, no rebuild. Alert `Could not add rule: <errors joined ", ">`.
  - **Update** (`MerchantRules::Updater`):
    - update the attributes; the source is **not** changed, so editing a system rule keeps it system;
    - success → rebuild, notice `Rule updated.`;
    - failure → no rebuild, alert `Could not update rule: <errors>`.
  - **Delete** (`MerchantRules::Destroyer`):
    - destroy the rule, which nullifies `merchant_rule_id` on enrichments;
    - always rebuild. Notice `Rule deleted - transactions re-classified.`.
  - All redirect to the merchant page.
- **Evidence:** `app/controllers/admin/merchant_rules_controller.rb:8-39`; `app/services/merchant_rules/creator.rb:19-33`; `app/services/merchant_rules/updater.rb:19-26`; `app/services/merchant_rules/destroyer.rb:14-18`.
- **Status:** [V]
- **Covered by:** `spec/services/merchant_rules/updater_spec.rb:6`, `:17` rebuild ONLY after a successful update, `:28`, `:40`; `spec/services/merchant_rules/destroyer_spec.rb:6`, `:17`; `spec/requests/categorization_spec.rb:348`, `:365` alert matches /pattern/, `:380`, `:396`; `spec/system/categorization_workflow_spec.rb:16` (flash `Rule added…re-classified`). Oracle: [create](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json), [update](../oracle/http/PATCH_admin_merchants__merchant_id_merchant_rules__id.json), [delete](../oracle/http/DELETE_admin_merchants__merchant_id_merchant_rules__id.json) → 302 `/admin/merchants/60`.

<a id="br-229"></a>
<a id="br-229"></a>
### BR-229 Seeded merchants and rules (`Seeders::MerchantRules`)

- **Rule:** Requires the taxonomy. A missing path raises `Missing seeded category at path: <path>`. The run is idempotent.
  - **Retail:** 25 merchants, each `kind = company`, `source = system`, `approved_at` kept or set to now, `default_category` per row. Each gets one rule keyed on (field, pattern): `kind contains`, `source system`, `enabled true`, `priority` kept or 0, `case_sensitive false`. Patterns:

    | Field | Pattern | Category path |
    |---|---|---|
    | title | BIEDRONKA | food.cooking.supermarket |
    | title | LIDL | food.cooking.supermarket |
    | title | KAUFLAND | food.cooking.supermarket |
    | title | AUCHAN | food.cooking.supermarket |
    | title | ELECLERC | food.cooking.supermarket |
    | title | ZABKA | food.cooking.convenience |
    | title | SPOLEM | food.cooking.convenience |
    | title | ROSSMANN | home.variable.drugstore |
    | title | PEPCO | lifestyle.shopping.general |
    | title | TEDI | lifestyle.shopping.general |
    | title | DECATHLON | health.body.fitness |
    | title | OTCF | lifestyle.shopping.clothing |
    | title | MEDIAEXPERT | lifestyle.shopping.electronics |
    | title | DOZ APTEKA | health.medical.pharmacy |
    | title | DARA KEBAB | food.eating_out.fastfood |
    | title | DONER KING | food.eating_out.fastfood |
    | title | MCDONALD | food.eating_out.fastfood |
    | title | CAPONE | food.cooking.alcohol |
    | title | T-MOBILE POLSKA | home.fixed.telecom |
    | title | ALLEGROPAY | lifestyle.shopping.general |
    | counterparty_name | Claude.ai | lifestyle.tools.saas |
    | counterparty_name | Openai | lifestyle.tools.saas |
    | counterparty_name | Anthropic | lifestyle.tools.saas |
    | counterparty_name | Google | lifestyle.tools.cloud |
    | counterparty_name | Linkedin | lifestyle.tools.saas |

    Merchant slugs and names are in `RETAIL`.
  - **ATM:** merchant `atm_withdrawal` "ATM" (`kind other`, default `money.transfers.atm`) with rule `payment_method exact "blik_atm"`, priority 300.
  - **Top-up:** merchant `mobile_wallet_topup` "Top-up (own)" (`kind platform`, default `money.transfers.own`) with three title-contains rules at priority 250: `Google Pay Top-Up by`, `Apple Pay Top-Up by`, `Top-Up by *`. The `*` is literal, since the kind is contains.
  - A re-seed resets `enabled = true` and `case_sensitive = false` on these rules, so user edits to them are overwritten (U-315).
- **Evidence:** `app/services/seeders/merchant_rules.rb:7-130`.
- **Status:** [V]
- **Covered by:** `spec/services/seeders/merchant_rules_spec.rb:6`, `:24`, `:39`. Oracle: [merchants index](../oracle/ui/admin_merchants_index.html) shows e.g. Biedronka with 5 transactions and ATM with 6.

<a id="br-230"></a>
<a id="br-230"></a>
### BR-230 Own-account merchants (`OwnAccountMerchantSyncer`)

- **Rule:** Runs after a bank account is created or updated by connection creation and after an account-details refresh. For one bank account:
  1. Collect IBANs: the primary IBAN plus `alternate_ibans`, blanks removed, whitespace stripped, uppercased, de-duplicated. If there are none → do nothing.
  2. Resolve the owner: the credential's user, else `manual_owner_id`. If there is none, raise `BankAccount <id> has no resolvable owner`.
  3. Upsert the merchant by slug `own_account_<first 8 chars of account uid>`:
     - name `Own account (<bank name | credential name | "Bank"> ⋯<last 4 of IBAN | "????">)`;
     - `kind person`, `source system`;
     - default category = the user's category with slug `money_transfers` (path `money.transfers`, **not** `money.transfers.own`; see U-311). `find_by!` raises if the category is missing;
     - notes `Auto-generated. Matches transfers where counterparty_iban is one of <display_name>'s own IBANs.`;
     - `approved_at` kept or set to now.
  4. For each IBAN, upsert a rule `field counterparty_iban, kind iban, pattern <IBAN>` with `source system`, `enabled true`, `priority 200`, `case_sensitive false`, `approved_at` kept or set to now.
  5. Existing iban rules of that merchant whose pattern is no longer in the list are **disabled**, never deleted, because historical enrichments reference them.

  All of this runs in one DB transaction. Two accounts sharing an IBAN (multi-currency pockets) yield two merchants with identical rules; the tie goes to the lower rule id (U-323).
- **Evidence:** `app/services/enrichment/own_account_merchant_syncer.rb:12-104`; `app/services/enable_banking/operations/create_connection.rb:75`; `app/services/enable_banking/operations/refresh_account_details.rb:39`.
- **Status:** [I]
- **Covered by:** untested directly. Indirectly exercised by `spec/services/seeders/showcase_spec.rb:13` (connections created).

---

<a id="br-231"></a>
### BR-231 The enrichment record

- **Rule:**
  - **One record per ledger row.** Each ledger row (bank transaction or manual/cash transaction) has at most one `TransactionEnrichment`, linked polymorphically by `(enrichable_type, enrichable_id)` with a DB unique index. Deleting the source row deletes its enrichment.
  - **Fields:** `merchant`, `category` (the explicit override), `merchant_rule` (the rule that matched), `source`, `confidence`, `model`, `category_overridden`, `enriched_at`, `notes`, tags.
  - **`source` values:**

    | Source | Meaning |
    |---|---|
    | `unmatched` | no rule, no fallback |
    | `system_rule` | matched a system rule |
    | `user_rule` | matched a user rule, or set by "all for merchant" |
    | `llm_rule` | matched an llm rule |
    | `llm_pending` | defined, never written by current code |
    | `manual` | explicit user decision |
    | `system_fallback` | payment-method fallback category |

  - **Constraints and scopes:**
    - `confidence` must be in 0.0..1.0 or null;
    - "rebuildable" = `source != manual AND category_overridden = false`;
    - "merchantless" = `merchant_id IS NULL`, which covers both `unmatched` and `system_fallback`;
    - the per-user scope unions bank and manual transactions owned by the user.
- **Evidence:** `app/models/transaction_enrichment.rb:24,37-76`; ADR 0002.
- **Status:** [V]
- **Covered by:** `spec/models/transaction_enrichment_spec.rb:61` rebuildable scope; `:76` merchantless; `:93` for_user across both types; `:114` DB uniqueness; `:125` predicates; `spec/models/concerns/ledger_entry_concern_spec.rb:68`, `:78` enrichment destroyed with its source row.

<a id="br-232"></a>
<a id="br-232"></a>
### BR-232 Effective category resolution

- **Rule:** effective category = the enrichment's explicit `category` if set, else the merchant's `default_category`, else NULL ("uncategorized"). This is resolved at read time: in Ruby, and in SQL in the `ledger_entries` view as `COALESCE(te.category_id, m.default_category_id)`. A transaction with no enrichment has a NULL effective category. Rows with a NULL effective category do not fall into any kind-partitioned total (spend, income, …).
- **Evidence:** `app/models/transaction_enrichment.rb:70-72`; `app/models/concerns/ledger_entry_concern.rb:18-21`; `inventory/views_sql/ledger_entries_v04.sql:33,76-77`.
- **Status:** [V]
- **Covered by:** `spec/models/transaction_enrichment_spec.rb:40`; `spec/models/concerns/ledger_entry_concern_spec.rb:6`, `:19`, `:33`, `:46`, `:58`, `:89` agrees with the view across the override / merchant-default / unmatched matrix; `spec/models/ledger_entry_spec.rb:92`, `:107`, `:121`.

<a id="br-233"></a>
<a id="br-233"></a>
### BR-233 Enriching one transaction (algorithm)

- **Rule:** Given a transaction and an optional existing enrichment (otherwise the current one, otherwise a new one):
  1. If the enrichment is persisted and `source = manual` → return it unchanged.
  2. If the enrichment is persisted and `category_overridden = true` → return it unchanged.
  3. Find the first matching rule (BR-226). If one matches, set:
     - `merchant` = rule.merchant;
     - `merchant_rule` = the rule;
     - `source` = `system_rule` / `user_rule` / `llm_rule` according to rule.source;
     - `confidence` and `model` copied from the rule;
     - `category` = NULL, so the merchant default applies.
  4. Otherwise, if a fallback category exists (BR-234), set merchant, rule, confidence and model to NULL, `source = system_fallback`, and `category` = the fallback category.
  5. Otherwise set everything to NULL with `source = unmatched`.
  6. Set `enriched_at = now` and save. A validation error raises.
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:96-129`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:67` payment_method fallback; `:89` unmatched; `:100` manual wins; `:113` category_overridden wins; `spec/system/categorization_workflow_spec.rb:57` preserves a manual override when an unrelated user rule fires a rebuild.

<a id="br-234"></a>
<a id="br-234"></a>
### BR-234 Payment-method / direction fallback table

- **Rule:** Used only when no rule matches. Lookup:
  1. first `(direction, payment_method, counterparty_kind)` in the identity-aware table;
  2. else `(direction, payment_method)` in the plain table;
  3. the resulting path must exist in the user's categories; archived categories count. Otherwise → `unmatched`.

  A transaction type without `counterparty_kind` uses `""`, which matches no identity key.

  Identity-aware table (`unknown` behaves like `external`):

  | direction | payment_method | self | external / unknown |
  |---|---|---|---|
  | debit | blik_p2p | money.transfers.own | noise.unmatched.other |
  | debit | transfer | money.transfers.own | noise.unmatched.other |
  | credit | blik_p2p | money.transfers.own | income.refunds.refunds |
  | credit | transfer | money.transfers.own | income.work.salary |

  Plain table:

  | direction | payment_method | path |
  |---|---|---|
  | debit | blik_pos | noise.unmatched.blik |
  | debit | blik_atm | money.transfers.atm |
  | debit | card | noise.unmatched.card |
  | debit | card_authorization | noise.authorizations.card |
  | debit | internal_transfer | money.transfers.own |
  | debit | topup | money.transfers.own |
  | debit | fee | services.financial.fees |
  | debit | cash | noise.unmatched.cash |
  | debit | cash_atm_topup | money.transfers.atm |
  | debit | cash_deposit | money.transfers.own |
  | debit | cash_fx_conversion | noise.adjustments.fx |
  | debit | cash_adjustment | noise.adjustments.cash |
  | credit | internal_transfer | money.transfers.own |
  | credit | topup | money.transfers.own |
  | credit | card | income.refunds.refunds |
  | credit | blik_atm | money.transfers.atm |
  | credit | cash | income.other.sale |
  | credit | cash_atm_topup | money.transfers.atm |
  | credit | cash_deposit | money.transfers.own |
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:20-64,150-163`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:67`, `:77` identity-aware fallback over the plain table.

<a id="br-235"></a>
<a id="br-235"></a>
### BR-235 When enrichment runs: `enrich_pending` vs `rebuild!`

- **Rule:**
  - **`enrich_pending(user, scope?)`** enriches transactions that have **no** enrichment yet. The default scope is the user's bank transactions without an enrichment. It returns the count processed. It is called by the transaction-sync job after each successful sync, scoped to the run's transactions. Failures there are logged and swallowed.
  - **`rebuild!(user, scope?)`** re-evaluates the user's **rebuildable** enrichments (not manual, not overridden) for both ledger types. Orphans whose source row is missing are skipped. Transactions with no enrichment row are **not** touched. The user parameter is mandatory; there is no cross-tenant rebuild.
  - Rebuild triggers:
    - rule create, update or delete;
    - merchant approval;
    - classification `create_rule`;
    - an LLM run with ≥ 1 auto-applied suggestion;
    - onboarding seed;
    - showcase seeding;
    - a rake task in `lib/tasks/banking.rake`.
  - Both run synchronously in the caller (request thread or job).
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:66-88`; `app/jobs/transaction_sync_job.rb:49-59`; `lib/tasks/banking.rake:79`; call sites listed in the BR ids above.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:128` rebuild! re-evaluates non-manual non-overridden rows only; `:149` enrich_pending writes one enrichment per scoped transaction and returns the count.

<a id="br-236"></a>
<a id="br-236"></a>
### BR-236 Counterparty resolver (self / external / unknown)

- **Rule:** Computed and stored on each transaction at **sync/save time**, not at enrichment time, as `counterparty_kind`. Inputs: `payment_method`, `counterparty_iban`, `counterparty_name`, user. First hit wins:
  1. `payment_method` ∈ {`internal_transfer`, `topup`, `cash_atm_topup`, `cash_deposit`, `cash_fx_conversion`, `cash_adjustment`} → `self`.
  2. Normalize IBAN = remove whitespace and uppercase; normalize name = trim and uppercase. Blank → absent.
  3. Both absent → `unknown`.
  4. IBAN ∈ the user's own IBANs → `self`. Own IBANs are every primary and alternate IBAN of every account the user owns (synced or cash), normalized the same way.
  5. Name ∈ the user's own holder names → `self`. Holder names are the normalized `name` of every owned account.
  6. Otherwise `external`.

  Name matching can produce false positives on common names; a per-transaction override always wins. Used by the fallback table (BR-234) and by LLM eligibility (BR-250).
- **Evidence:** `app/services/banking/counterparty_resolver.rb:4-62`; `app/models/user.rb:80-94`; `app/services/enable_banking/operations/sync_account_transactions.rb:58-63`; `app/services/cash/transaction_creator.rb:80`.
- **Status:** [V]
- **Covered by:** `spec/services/banking_spec.rb:6`, `:15`, `:23`, `:32`, `:41`, `:50` IBAN preferred over name, `:59`, `:68`, `:77`, `:86`; `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:6` resolves counterparty_kind during sync.

<a id="br-237"></a>
<a id="br-237"></a>
### BR-237 Manual classification: modes, guards, messages

- **Rule:** Input: a transaction, an actor, a mode, a merchant (or nil), a category (or nil), `rule_field`, `rule_kind`, `rule_pattern`. Guards, in order:
  1. Mode not in {`only_this`, `all_for_merchant`, `create_rule`} → failure `Unknown propagation mode: <mode>`.
  2. Merchant nil and mode ≠ `only_this` → failure `Pick a merchant`.
  3. Mode `create_rule` with a blank pattern → failure `Pick a pattern`.

  The mode's writes then run inside one DB transaction. Success → `Applied: <label>`, where the labels are `this transaction only`, `all transactions for this merchant`, `new rule + rebuild`. A validation error from any write → rollback and failure with the record's messages joined by `", "`.
- **Evidence:** `app/services/enrichment/classification_applier.rb:24-51,101-107`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:85` 'Pick a merchant'; `:95` 'Pick a pattern'; `:106` 'Unknown propagation mode'. [oracle](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json) `create_rule_missing_fields` → 302 with no DB writes (the log shows no BEGIN).

<a id="br-238"></a>
<a id="br-238"></a>
### BR-238 Mode `only_this`

- **Rule:** On this transaction's enrichment (created if missing), set:
  - `merchant` = the chosen merchant (may be nil);
  - `category` = the chosen category (may be nil);
  - `category_overridden` = true if and only if a category was given;
  - `source = manual`;
  - `merchant_rule`, `confidence`, `model` = NULL;
  - `enriched_at = now`.

  No other transaction changes. Because `source = manual`, later rebuilds never touch this row (BR-233).
- **Evidence:** `app/services/enrichment/classification_applier.rb:55-66`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:16` with merchant + category writes source manual and category_overridden true; `:33` merchant without category leaves category_overridden false. [oracle](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json) `default` (`only_this`, merchant 1, category 1) → 302. The log shows `UPDATE transaction_enrichments SET category_id = 1, …, merchant_id = 1`.

<a id="br-239"></a>
<a id="br-239"></a>
### BR-239 Mode `all_for_merchant`

- **Rule:**
  1. If a category was given, set the merchant's `default_category` to it. This retroactively re-categorizes every transaction of that merchant without an explicit override, past and future (BR-232).
  2. On this transaction's enrichment (created if missing), set `merchant` = the merchant, `category` = NULL, `category_overridden` = false, `source = user_rule`, `enriched_at = now`. `merchant_rule`, `confidence` and `model` are left unchanged.

  The row is rebuildable afterwards. A later rebuild re-runs rule matching and can replace the merchant if no rule matches this transaction (U-308) [I].
- **Evidence:** `app/services/enrichment/classification_applier.rb:68-79`.
- **Status:** [V] for steps 1-2. [I] for the rebuild consequence.
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:46`.

<a id="br-240"></a>
<a id="br-240"></a>
### BR-240 Mode `create_rule`

- **Rule:**
  1. Create a rule for the actor with:
     - merchant = the chosen merchant;
     - `kind` = rule_kind, default `contains`;
     - `field` = rule_field, default `title`;
     - `pattern` = rule_pattern, used verbatim (not trimmed or uppercased by the server);
     - `priority 100`, `source user`, `enabled true`, `approved_at now`, `approved_by actor`.
  2. If a category was given and differs from the merchant's default, set it as the merchant default.
  3. Run a full rebuild for the actor (BR-235). This affects every rebuildable enrichment of the user, including this transaction only if its row is rebuildable.

  An invalid kind, field or regex fails with the model messages (e.g. `Kind is not included in the list`).
- **Evidence:** `app/services/enrichment/classification_applier.rb:81-99`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:63` builds a user-source MerchantRule and rebuilds matching transactions retroactively.

<a id="br-241"></a>
<a id="br-241"></a>
### BR-241 Classification endpoint (admin)

- **Rule:** `PATCH|PUT /admin/bank_transactions/:bank_transaction_id/enrichment`:
  - The transaction must belong to the user, else 404.
  - Params `enrichment[mode, merchant_id, category_id, rule_field, rule_kind, rule_pattern]`.
  - `merchant_id` and `category_id` are looked up **within the current user**. A foreign or unknown id silently becomes nil, so a foreign merchant leads to `Pick a merchant` for non-`only_this` modes.
  - Result message → flash `notice` on success, `alert` on failure. Always redirects to `/admin/bank_transactions/:id`.
  - A missing `enrichment[mode]` (nil) raises inside the service and yields a 500 (U-309) [I].
  - Only bank transactions use this endpoint. Cash rows are classified through the cash-transaction editor (Part C).
- **Evidence:** `app/controllers/admin/transaction_enrichments_controller.rb:5-27`; `app/services/enrichment/classification_applier.rb:15`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:410`, `:432` nil merchant for a foreign merchant_id, `:451` failure → flash[:alert], `:467` 404 for another user's transaction. Oracle: [PATCH](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json), [PUT](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json).

<a id="br-242"></a>
### BR-242 Classify modal defaults

- **Rule:** The "Edit classification" modal on a bank transaction preselects:
  - the current enrichment merchant;
  - the category as the explicit enrichment category, else the merchant default;
  - mode `only_this`;
  - for `create_rule`: field `title`, kind `contains`, pattern = the transaction title **uppercased and trimmed**.

  Merchant choices are the user's active merchants, labelled `<name> (<default category name>)` and sorted case-insensitively. Category choices are active categories labelled by breadcrumb. Hidden items are masked (BR-212). The UI copy per mode:
  - "This transaction only – Override on this one transaction. Marked manual - won't be overwritten by future rules."
  - "All transactions for this merchant – Updates the merchant's default category. Applies retroactively and going forward."
  - "Create a new rule for this pattern – A user-source rule will match every existing and future transaction matching this pattern."
- **Evidence:** `app/views/admin/bank_transactions/_classify_modal.html.erb:4-25,85-124`.
- **Status:** [I]
- **Covered by:** untested (UI only).

<a id="br-243"></a>
<a id="br-243"></a>
### BR-243 Matching engine overview

- **Rule:** `GET /admin/matching_engine` shows:
  - all of the user's rules in resolution order (BR-226), offset-paginated, with the total rule count;
  - per rule on the current page, the number of the user's enrichments whose `merchant_rule_id` is that rule;
  - the total number of enrichments with any rule;
  - the **plain** fallback table only (the identity-aware table is not shown), with the user's category for each path and the count of `system_fallback` enrichments per `(direction, payment_method)` summed over bank and cash rows;
  - the `unmatched` count and the total enrichment count.
- **Evidence:** `app/controllers/admin/matching_engine_controller.rb:5-36`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:522` lists only the current user's rules. [oracle](../oracle/http/GET_admin_matching_engine.json) → 200; [UI](../oracle/ui/admin_matching_engine.html).

---

<a id="br-244"></a>
<a id="br-244"></a>
### BR-244 LLM provider registry and model defaults

- **Rule:** Exactly two providers are supported. There is **no** Anthropic or other client at this commit.

  | key | label | default model | allowed models (in this order) | client |
  |---|---|---|---|---|
  | `openai` | OpenAI | `gpt-5-mini` | gpt-5-mini, gpt-5-nano, gpt-5.4-mini, gpt-5.4-nano, gpt-4.1-mini, gpt-4o-mini | `Llm::Clients::OpenAI` |
  | `gemini` | Google Gemini | `gemini-2.5-flash` | gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash | `Llm::Clients::Gemini` |

  An unknown key raises `Unknown LLM provider: "<key>"`. Select options are `[label, key]` in registry order, and the first key (`openai`) is the default for a new setting form. Adding a vendor means one registry entry plus one client class.
- **Evidence:** `app/services/llm/providers.rb:6-47`; ADR 0012:18-24; `app/controllers/admin/settings/preferences_controller.rb:92-93`.
- **Status:** [V]
- **Covered by:** `spec/models/llm_setting_spec.rb:28`, `:34`, `:40`.

<a id="br-245"></a>
<a id="br-245"></a>
### BR-245 Per-user LLM setting (`LlmSetting`)

- **Rule:**
  - Each user has at most one setting (unique `user_id`).
  - `provider` is required and must be a registry key.
  - `api_key` is required and stored with Rails attribute encryption (ADR 0004). The raw column never contains the plaintext.
  - `model`: blank → filled with the provider default before validation; non-blank and not in the provider's list → `Model is not supported by <label>`.
  - "Configured" = `api_key` present. The effective model is `model`, else the provider default.
  - Connection-test bookkeeping:
    - success sets `last_tested_at = now`, `last_test_error = NULL`;
    - failure sets `last_tested_at = now` and `last_test_error` = the message truncated to 500 characters.
- **Evidence:** `app/models/llm_setting.rb:25-81`.
- **Status:** [V]
- **Covered by:** `spec/models/llm_setting_spec.rb:28`, `:34`, `:40`, `:48`, `:58`, `:67` api_key round-trips through encryption.

<a id="br-246"></a>
<a id="br-246"></a>
### BR-246 Saving LLM preferences

- **Rule:** `PATCH /admin/settings/preferences/llm`, params `llm_setting[provider, api_key, model]`:
  - If the setting already exists and `api_key` is blank, the key is **kept**, even when the provider changes. The form never shows the real key.
  - Success → redirect `/admin/settings/preferences/llm` with notice `LLM settings saved.`.
  - Validation failure → re-render with 422 and flash alert = errors joined `", "`.
  - An **unknown provider** fails validation, but the re-render then calls the registry for that provider and raises, giving a **500** with `ArgumentError: Unknown LLM provider: "martian"` (known finding).
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:53-68`; `app/views/admin/settings/preferences/llm.html.erb:37`; `../oracle/server.log.txt:15505-15519`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:127`, `:136` creates on first save, `:149` blank api_key keeps the previous key, `:164` rotates the key. Oracle: [PATCH](../oracle/http/PATCH_admin_settings_preferences_llm.json) `default` (switch to openai/gpt-5-mini with blank key) → 302; `invalid_provider` → 500. The switch kept the Gemini key, and the subsequent connection test sent `fake-gem***-key` to OpenAI ([runs](../oracle/operation_runs_after_capture.jsonl) id 14).

<a id="br-247"></a>
<a id="br-247"></a>
### BR-247 LLM client factory and per-call credentials

- **Rule:** `Llm::Client.for(user)` returns the client of the user's setting, built with that user's decrypted key and effective model. If the user has no setting or no key, it raises `NotConfiguredError` with `User has not configured an LLM provider - see /admin/settings/preferences`.
  - There is no global API key: every call opens a per-call configuration context with this key (RubyLLM context). One tenant can never spend another's quota.
  - Transport defaults: request timeout **60 s** and **2** library-level retries.
  - The client contract is `structured(system_prompt, user_prompt, schema) → parsed JSON object`. Transport or parse failures raise `Llm::Client::Error`.
- **Evidence:** `app/services/llm/client.rb:7-47`; `config/initializers/ruby_llm.rb:11-14`; ADR 0012:26-29.
- **Status:** [I] (the oracle replaced clients by a fake).
- **Covered by:** `spec/services/llm/connection_test_runner_spec.rb:162` does not leak the api_key into the OperationRun.

<a id="br-248"></a>
<a id="br-248"></a>
### BR-248 Provider clients: parsing, errors, rate-limit retry

- **Rule:** Both clients send the system prompt as instructions, attach the JSON schema as structured output, send the user prompt, and parse the reply. A reply that is already an object is returned as-is, a string is JSON-parsed, and anything else raises.
  - **Error messages** (exact formats, `<P>` = `OpenAI` or `Gemini`):
    - `<P> API error: <ErrorClass>: <message>`;
    - `<P> returned non-JSON content: <message>`;
    - `Unexpected response shape from <P>: <class>`.
  - **OpenAI rate limits:** on a rate-limit error the call is retried up to **4** times (5 attempts total). The wait before each retry is:
    - `N + 1` seconds if the message contains `retry after Ns`;
    - `X + 1` seconds if it contains `please try again in X s`;
    - otherwise **30 s**.

    After the 4th retry it raises `OpenAI API error: …`.
  - **Gemini** has no extra retry beyond the library's.
- **Evidence:** `app/services/llm/clients/openai.rb:6-48`; `app/services/llm/clients/gemini.rb:6-28`.
- **Status:** [V] for OpenAI retry. [I] for Gemini.
- **Covered by:** `spec/services/llm/clients/openai_spec.rb:7` retries up to MAX_RETRIES parsing the wait; `:36` raises Llm::Client::Error once MAX_RETRIES is exceeded.

<a id="br-249"></a>
<a id="br-249"></a>
### BR-249 LLM connection test

- **Rule:** `POST /admin/settings/preferences/llm/test`:
  - If the setting is not configured, redirect to the LLM preferences page with alert `Save a provider and API key first.`. No run is created.
  - Otherwise:
    1. create an operation run with kind `llm_connection_test`, status `running`, trigger `manual`, the user as subject and triggered-by, params `{provider, model}`;
    2. send one probe (no retry or fan-out by the runner):
       - system prompt `You are a connectivity probe. Reply with exactly the JSON {"ok": true, "echo": "<the sent_at value from the user message>"}.`;
       - user prompt `ping sent_at=<ISO-8601 now>`;
       - schema `{ok: boolean, echo: string}`, both required, no extra properties;
    3. on success, finish the run as succeeded with summary `{request (+provider, model), response}`, record the test success, and show notice `Connection OK - <label> (<model>).`;
    4. on `Llm::Client::Error`, fail the run with the error message and summary `{request, response: null}`, record the test failure, and show alert `Test failed: <message>`.
  - The API key is never written to the run.
  - The client is built directly from the setting rather than through the factory (known finding; functionally the same) (U-318).
- **Evidence:** `app/services/llm/connection_test_runner.rb:8-83`; `app/controllers/admin/settings/preferences_controller.rb:70-83`.
- **Status:** [V]
- **Covered by:** `spec/services/llm/connection_test_runner_spec.rb:6`, `:22`, `:33`, `:46`, `:62`, `:74`, `:88`, `:98`, `:110`, `:124`, `:137`, `:147`, `:154`, `:162`; `spec/requests/settings_spec.rb:176`, `:186`, `:200`. [oracle](../oracle/http/POST_admin_settings_preferences_llm_test.json) → 302; [runs](../oracle/operation_runs_after_capture.jsonl) id 14 = failed with `OpenAI API error: RubyLLM::UnauthorizedError: Incorrect API key provided: fake-gem***-key. …`.

<a id="br-250"></a>
<a id="br-250"></a>
### BR-250 Which transactions are eligible for LLM enrichment

- **Rule:** A transaction is eligible when it is a **bank** transaction of the user (cash/manual rows are never sent) that meets all of:
  - it **has** an enrichment row with `merchant_id IS NULL`, i.e. `unmatched` or `system_fallback`, including manual-source rows without a merchant;
  - (`title` not null, not empty and not all digits, i.e. not matching `^[0-9]+$`) **or** `counterparty_name` not null and not empty;
  - `payment_method` ∉ {`blik_p2p`, `blik_atm`, `internal_transfer`, `topup`, `fee`};
  - `counterparty_kind ≠ self`.

  The SQL `NOT IN` / `<>` also excludes rows whose `payment_method` or `counterparty_kind` is NULL [I].
- **Evidence:** `app/services/llm/enrichable_query.rb:8-27`; ADR 0005:24-25.
- **Status:** [V] (oracle: salary credit `WYNAGRODZENIE`, a `system_fallback` row, was eligible).
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`. [runs](../oracle/operation_runs_after_capture.jsonl) ids 10, 11 (requests list `WYNAGRODZENIE`/`Some Company sp. z o.o.`, `Spotify`/`Spotify AB`, `Netflix`/`Netflix Intl.`).

<a id="br-251"></a>
<a id="br-251"></a>
### BR-251 Grouping and de-duplication of LLM work

- **Rule:**
  1. Eligible transactions are iterated in primary-key batches, in ascending id order. Each is assigned the group key `[TitleNormalizer(title), counterparty_name or ""]`. A key of `["", ""]` is dropped.
  2. A transaction is skipped if **any** existing rule of the user, enabled **or disabled** and of any source, matches its `title`, `counterparty_name` or `counterparty_iban` (BR-225). `payment_method` rules are never considered here.
  3. The first transaction seen per key supplies the sample `{title, counterparty_name}`.
  4. Groups keep first-seen order.
- **Evidence:** `app/services/llm/enrichable_query.rb:29-54`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (4 distinct titles → 4 groups). The "already proposed" subtraction on the page relies on this (BR-263).

<a id="br-252"></a>
<a id="br-252"></a>
### BR-252 Queueing an LLM enrichment run

- **Rule:** Input: an optional `limit`. Blank → 50; otherwise converted to an integer. There is no server-side upper or lower bound; the form offers min 1, max 200 (U-317).
  - If the user's setting is not configured → failure `Configure an LLM provider in Preferences before running enrichment.`. No run is created.
  - Otherwise create an operation run with kind `llm_enrichment`, status `queued`, trigger `manual`, subject = triggered-by = user, params `{"limit": <n>}`, empty summary, and enqueue the background job with the run id.
  - **Admin** `POST /admin/llm_enrichments`:
    - success → redirect to `/admin/llm_enrichments/<id>` with notice `Run #<id> queued.`;
    - failure → redirect to `/admin/settings/preferences/llm` with alert = the message.
  - **API** `POST /api/v1/llm_enrichments`:
    - success → 201 with the run;
    - failure → 422 `{message, details}`;
    - a non-integer `limit` → 400 (Grape type coercion).
  - Runs are listed and shown only for runs the user triggered. Another user's id → 404.
- **Evidence:** `app/services/llm_enrichments/queuer.rb:4-46`; `app/controllers/admin/llm_enrichments_controller.rb:28-48`; `lib/api/resources/llm_enrichments.rb:27-55`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:479`, `:494`, `:506`; `spec/requests/api/v1/categorization_spec.rb:254`, `:269`, `:281`; `spec/system/llm_enrichment_spec.rb:120` refuses to enqueue with a clear flash; `spec/system/cross_user_isolation_spec.rb:83`. Oracle: [admin POST](../oracle/http/POST_admin_llm_enrichments.json) → 302 `/admin/llm_enrichments/11`; [API POST](../oracle/http/POST_api__version_llm_enrichments.json) `default` → 201, `invalid_limit` → 400; [API GET id](../oracle/http/GET_api__version_llm_enrichments__id.json) `not_found` → 404.

<a id="br-253"></a>
<a id="br-253"></a>
### BR-253 Run execution and final status

- **Rule:** The background job `LlmEnrichmentJob(run_id)`:
  1. If the run is already terminal → do nothing.
  2. Mark it `running`. Initialize the summary to `{total_groups: 0, auto_applied: 0, pending_review: 0, skipped: 0, batches: []}`.
  3. limit = `params.limit` (integer) or 50. User = the run's subject if it is a User, else triggered-by. If there is none, raise.
  4. Execute the runner (BR-254). After each batch, append `{index, size, status: succeeded|failed, auto, pending, skipped, errors: [{title, error}], request, response}` to `summary.batches` and save. Each save broadcasts live progress to the run page.
  5. Copy the final totals.
  6. Final status:
     - errors present and `auto_applied = 0` and `pending_review = 0` → **failed** with error `All batches failed. First: <first error>`. This also happens when the only errors are item-level and the rest were skipped (U-322);
     - errors present otherwise → **partial** with error `<n> item(s) failed.`;
     - no errors → **succeeded**. Zero groups gives an empty, succeeded run.
  7. Any other exception → **failed** with `<ErrorClass>: <message>` (summary kept), then re-raised.
- **Evidence:** `app/jobs/llm_enrichment_job.rb:8-51`; `app/models/operation_run.rb:65-67,85-103`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` succeeded with counts; `:67` failed with "All batches failed" including the provider message; `:91` partial with "1 item(s) failed". [runs](../oracle/operation_runs_after_capture.jsonl) id 6 (0 groups → succeeded, `batches: []`), ids 10 and 11 (fake returned `{"results": []}` → every item skipped → succeeded).

<a id="br-254"></a>
<a id="br-254"></a>
### BR-254 Runner: limits, batching, throttle

- **Rule:**
  - Groups (BR-251) are truncated to the **first `limit`** groups (default 50 = max groups per run), then split into batches of **15**.
  - Each batch is **one** provider call. Between batches the runner sleeps **2 s**, but not after the last batch.
  - A batch whose call raises `Llm::Client::Error` records every item of the batch as an error `{title, error: message}` and continues with the next batch.
  - Inside a successful batch, an item raising a validation error records `{title, "ActiveRecord::RecordInvalid: <msg>"}` and continues.
  - The client is resolved lazily, before the first batch. Its `NotConfiguredError` therefore escapes the batch handling and fails the whole run via BR-253 step 7 [I].
  - After all batches, a full rebuild runs (BR-235) if at least one suggestion was auto-applied.
  - Result: `processed` = number of groups sent (not transactions), plus `auto_applied`, `pending_review`, `skipped`, `errors`.
- **Evidence:** `app/services/llm/enrichment_runner.rb:9-86`; `app/services/llm/merchant_suggester.rb:7`.
- **Status:** [V] for batching, counts and errors. [I] for the throttle and NotConfigured path.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`, `:67`, `:91`.

<a id="br-255"></a>
<a id="br-255"></a>
### BR-255 Prompt content and what data leaves the system

- **Rule:** Per batch, the provider receives:
  - **System prompt** (Polish, kept verbatim from `merchant_suggester.rb:77-191`). It contains:
    - noise-stripping guidance (city prefixes, trailing "PL", terminal codes, domain prefixes/suffixes, separators);
    - 7 merchant classes and their rule strategies;
    - rule-pattern guidance ("short core, not the whole title"; `contains` by default; `exact` only for a clean company name; `iban` only for `counterparty_iban`);
    - confidence bands: ≥ 0.95 known chain/SaaS; 0.8–0.9 readable core; 0.6–0.8 local business; below 0.5 → `merchant_name=""` with `confidence=0`, "do not invent";
    - the rule that the pattern must occur in `title_raw`;
    - the list of the user's **active leaf category paths**. A leaf is an active path with no active descendant; the list is sorted as strings, one per line;
    - the instruction that every result must carry the input `index`.
  - **User prompt:** `Sklasyfikuj poniższe transakcje:` followed by one `{ index: i, title_raw: "<title>", [title_normalized: "<normalized>",] [counterparty_name: "<name>"] }` per item. Strings are inspected/quoted Ruby-style.
    - `title_normalized` (BR-264) is included only when non-empty and different from the raw title ignoring case.
    - `counterparty_name` is included only when present.

  **Data that leaves the system:**
  - the raw title, the normalized title, the counterparty name;
  - the user's category paths;
  - implicitly the chosen model and the user's API key, to the provider.

  **Never sent:** amounts, currencies, IBANs, dates, account identifiers. Note that the UI and the initializer claim "only the normalized title" is sent, but the raw title is sent too (U-312). The full request (`index`, `title`, `counterparty_name`) and response are stored in the run summary.
- **Evidence:** `app/services/llm/merchant_suggester.rb:58-64,76-214`; `app/views/admin/llm_enrichments/index.html.erb:89`; `config/initializers/ruby_llm.rb:9-10`.
- **Status:** [V] for the request contents. [I] for the full prompt text.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (the fake matches the prompt on `Jesteś asystentem klasyfikującym`). [runs](../oracle/operation_runs_after_capture.jsonl) ids 10, 11 show `request` arrays.

<a id="br-256"></a>
<a id="br-256"></a>
### BR-256 Structured-output schema and result mapping

- **Rule:** The response schema is `{results: [item]}` with no extra properties. Every item field is required:

  | Field | Type / allowed values |
  |---|---|
  | `index` | integer |
  | `merchant_name` | string; "" if unidentifiable |
  | `merchant_kind` | company, person, charity, government, platform, other, unknown |
  | `category_path` | string |
  | `rule_field` | title, counterparty_name, counterparty_iban |
  | `rule_kind` | contains, regex, exact, prefix, iban |
  | `rule_pattern` | string |
  | `confidence` | number in 0..1 |
  | `reasoning` | string |

  Results are matched to inputs **by `index`**, not by position. A missing index produces a null result. Mapping (blank → default):

  | Field | Mapping |
  |---|---|
  | `merchant_name` | trimmed string |
  | `merchant_kind` | `unknown` |
  | `category_path` | `noise.unmatched.other` |
  | `rule_field` | `title` |
  | `rule_kind` | `contains` |
  | `rule_pattern` | trimmed string |
  | `confidence` | float, defaults to 0.0 |
  | `reasoning` | string |

  The null result is: name "", kind unknown, `noise.unmatched.other`, title/contains, pattern "", confidence 0.0, reasoning `LLM did not return a result for this index.`
- **Evidence:** `app/services/llm/merchant_suggester.rb:15-39,66-72,216-235`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`. [runs](../oracle/operation_runs_after_capture.jsonl) id 11: response `{"results": []}` → 3 null results → 3 skipped.

<a id="br-257"></a>
<a id="br-257"></a>
### BR-257 Processing one suggestion (skip, pattern enforcement)

- **Rule:** For each (sample, suggestion):
  1. Blank `merchant_name` or confidence exactly 0 → **skipped**.
  2. Pattern enforcement. The sample value is the sample's `title` if `rule_field = title`, or its `counterparty_name` if `rule_field = counterparty_name`. For any other field (e.g. `counterparty_iban`) the value is missing → **skipped**.
     - If the LLM rule (its kind, case-insensitive) matches the sample value, keep it.
     - Else, only for `title`: derive a pattern with `TitleNormalizer.likely_pattern(title)` (BR-264). If that pattern, as a case-insensitive `contains`, matches the title, replace the suggestion's pattern and set kind to `contains`, **keep the LLM confidence**, and prefix reasoning with `[DERIVED] LLM pattern didn't match; replaced with stripped-title substring. `.
     - Else → **skipped**.
  3. In one DB transaction: upsert the merchant (BR-259), upsert the rule (BR-260), and return `auto_applied` if confidence ≥ threshold, else `pending_review`.

  An LLM-proposed **invalid regex** raises a regex error during the probe. It is not caught by the per-item handler and aborts the run (U-307) [I].
- **Evidence:** `app/services/llm/enrichment_runner.rb:90-146`.
- **Status:** [V] for skip and apply. [I] for the derived-pattern branch and regex abort.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`, `:91`.

<a id="br-258"></a>
<a id="br-258"></a>
### BR-258 Confidence gating

- **Rule:** The threshold is env `LLM_MERCHANT_AUTO_APPROVE_THRESHOLD` (float, default **0.85**), read once at boot. For a non-skipped suggestion:
  - **confidence ≥ threshold** (inclusive) → the rule is saved **enabled**: auto-applied on the rebuild at the end of the run. A *new* merchant is also stamped approved;
  - **0 < confidence < threshold** → the rule is saved **disabled**. The merchant stays unapproved when new and appears in "Awaiting approval" until approved (BR-221);
  - **confidence = 0** → skipped.

  LLM rules always rank below user rules (BR-226), and rebuilds never touch manual or overridden rows. "LLM never silently overrides a user decision" holds for enrichments but not for merchant attributes (BR-259).
- **Evidence:** `app/services/llm/enrichment_runner.rb:4-9,101,160,174`; `app/services/llm/merchant_suggester.rb:10-12`; ADR 0005:13-22; `inventory/env.txt:32`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (0.95/0.92 → enabled + transactions re-classified; 0.6/0.7 → disabled, merchants unassigned, "Awaiting approval (2)"). [UI](../oracle/ui/admin_llm_enrichments_index.html) shows `Confidence ≥ 0.85 → rule enabled immediately.`

<a id="br-259"></a>
<a id="br-259"></a>
### BR-259 Merchant upsert from an LLM suggestion

- **Rule:** Look up the user's merchant by slug, using algorithm (b) on `merchant_name` with no collision numbering (BR-216). If found, **reuse and overwrite** it; otherwise create it. Then:
  - `name` = the suggested name;
  - `kind` = the suggested kind if it is a valid merchant kind, else NULL (`unknown` → NULL);
  - `source` = unchanged if the merchant exists, else `llm`;
  - `confidence` = the suggestion's confidence, stored as decimal(4,3);
  - `model` = the client's model name;
  - `default_category` = BR-261;
  - `notes` = the previous notes and the reasoning, de-duplicated, joined by a newline;
  - `approved_at` = now **only if** the merchant is new and confident.

  An existing system or user merchant with the same slug therefore gets its name, kind and **default category overwritten** even for a below-threshold suggestion. That retroactively re-categorizes its transactions (U-306) [I].
- **Evidence:** `app/services/llm/enrichment_runner.rb:148-163`.
- **Status:** [V] for new merchants. [I] for the overwrite case.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`.

<a id="br-260"></a>
<a id="br-260"></a>
### BR-260 Rule upsert from an LLM suggestion

- **Rule:** Within the merchant, find or create the rule by exact `(field, kind, pattern)`. Then set:
  - `user` = the user;
  - `source = llm`;
  - `confidence` and `model` from the suggestion and client;
  - `priority = 50`;
  - `enabled` = confidence ≥ threshold.

  `approved_at` is not set. Re-proposing an existing pattern with a lower confidence would re-**disable** a rule that the user had approved (U-321) [I]. This is normally prevented, because covered groups are not re-sent (BR-251).
- **Evidence:** `app/services/llm/enrichment_runner.rb:165-177`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (patterns DEVSTYLE and P.U.N.K.T enabled; JANUSZEX and MOSO disabled).

<a id="br-261"></a>
<a id="br-261"></a>
### BR-261 Category resolution for an LLM suggestion

- **Rule:** Trim `category_path` and find the user's category with exactly that path; archived categories count. If there is none, use the user's `noise.unmatched.other`. If that does not exist either, use NULL. The prompt mentions targets that do not exist in the seeded tree (`uncategorized`, `gifts_donations`). They resolve to `noise.unmatched.other` (U-319).
- **Evidence:** `app/services/llm/enrichment_runner.rb:188-194`; `app/services/llm/merchant_suggester.rb:117,137`.
- **Status:** [I]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (valid paths only).

<a id="br-262"></a>
### BR-262 Effect of an LLM run on transactions

- **Rule:**
  - Auto-applied rules affect transactions only through the end-of-run rebuild (BR-235). Matching rows get `source = llm_rule`, the rule's confidence and model, and the merchant; their category comes from the merchant default.
  - Pending (disabled) rules have no effect until the merchant is approved, which enables them and rebuilds.
  - The `llm_pending` source is never produced.
- **Evidence:** `app/services/llm/enrichment_runner.rb:83`; `app/services/enrichment/transaction_enricher.rb:103-109`; `app/services/merchants/approver.rb:17-21`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (auto_high → merchant `devstyle`; pending_low → merchant nil); `spec/services/merchants/approver_spec.rb:44`.

<a id="br-263"></a>
### BR-263 AI Enrichment page figures

- **Rule:** `GET /admin/llm_enrichments` shows:
  - **"Without a merchant":** the user's merchantless enrichments, bank and cash;
  - **"Awaiting approval":** merchants with `source llm` and `approved_at` null, newest first;
  - **"Ready to send to LLM":** the number of groups after rule de-duplication (BR-251);
  - **"LLM can't help":** merchantless minus eligible *transactions*. This mixes transaction and group counts, so the rows do not "add up" as the hint claims;
  - **API calls:** ⌈ready / 15⌉;
  - **Default group limit:** min(ready, 50);
  - **"already proposed":** all groups minus ready groups;
  - the user's runs, paginated, newest first.

  If the user has no active categories, a "Taxonomy not set up" empty state replaces the page. If no key is configured, the warning `No LLM provider configured` is shown.
- **Evidence:** `app/controllers/admin/llm_enrichments_controller.rb:7-26,53-58`; `app/views/admin/llm_enrichments/index.html.erb:6-104`.
- **Status:** [V] (oracle page: 24 without merchant, 0 awaiting, 3 ready, 13 can't help).
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`, `:120`. [UI](../oracle/ui/admin_llm_enrichments_index.html); [oracle](../oracle/http/GET_admin_llm_enrichments.json) → 200.

<a id="br-264"></a>
<a id="br-264"></a>
### BR-264 Title normalizer

- **Rule:** The known city prefixes are RZESZOW, WARSZAWA, KRAKOW, POZNAN, WROCLAW, GDANSK, GDYNIA, SZCZECIN, LODZ, LUBLIN, BYDGOSZCZ, BIALYSTOK, KATOWICE, SOSNOWIEC, ZLOTOW, TORUN. They are matched case-insensitively at the start of the title, with **no word boundary**.

  **`normalize(title)`**, used for grouping and for `title_normalized`. A blank title gives `""`. Steps:
  1. uppercase;
  2. remove one leading city prefix;
  3. remove a trailing `PL`;
  4. replace each digit run with a space;
  5. replace every character that is not a letter, whitespace, `.`, `&` or `-` with a space;
  6. replace `.` with a space;
  7. squeeze spaces and trim.

  **`likely_pattern(title)`**, the fallback rule pattern. A blank title gives nil. Steps:
  1. on the *original casing*, remove the city prefix (case-insensitive);
  2. remove a trailing `PL` (case-sensitive);
  3. replace digit runs with spaces;
  4. split on whitespace;
  5. keep tokens of ≥ 3 characters;
  6. return the longest, the first on ties, or nil.

  Outputs (pure-Ruby evaluation of the source file):

  | input | normalize | likely_pattern |
  |---|---|---|
  | `RZESZOWLIDL 01PL` | `LIDL` | `LIDL` |
  | `RZESZOWJMP S.A. BIEDRONKA 7645PL` | `JMP S A BIEDRONKA` | `BIEDRONKA` |
  | `RzeszoweLeclercPL` | `ELECLERC` | `eLeclerc` |
  | `RzeszowP.U.N.K.TPL` | `P U N K T` | `P.U.N.K.T` |
  | `WWW.DEVSTYLE.PL` | `WWW DEVSTYLE` | `WWW.DEVSTYLE.` |
  | `POZNANSKA 12` | `SKA` (over-strip) | `SKA` |
  | `12345` | `""` | nil |

  The code comments promise `JMP S.A. BIEDRONKA` and `LECLERC`, which differ from the real output (U-316).
- **Evidence:** `app/services/enrichment/title_normalizer.rb:11-50`.
- **Status:** [V] for the cases asserted by specs. [I] for the other table rows.
- **Covered by:** `spec/services/enrichment/title_normalizer_spec.rb:6`, `:12`, `:16`, `:21`, `:26`.

<a id="br-265"></a>
### BR-265 "Facts-only" AI narration boundary

- **Rule:** ADR 0008 describes an `Analytics::AiInsight` card. Ruby computes every number; the LLM writes 3 sentences "using ONLY numbers in the facts"; a numeric guard rejects any digit sequence not present in the facts. **No such code exists at this commit**: no `AiInsight` class or view. The only LLM uses are the merchant suggester (BR-255) and the connection test (BR-249). The enrichment pipeline never sends amounts or dates and never lets the LLM produce numbers that are shown as facts. The ADR's notable-mover rule (|delta_pct| ≥ 100 % AND |amount| ≥ 200 PLN) is therefore not implemented (U-314).
- **Evidence:** `docs/adr/0008-ai-insight-architecture.md:19-27`; `grep -r AiInsight src` → no matches; `app/services/llm/*`.
- **Status:** [I]
- **Covered by:** untested (not implemented).

<a id="br-266"></a>
<a id="br-266"></a>
### BR-266 Showcase data set (`Seeders::Showcase`)

- **Rule:** Builds a deterministic demo tenant by calling the production services against fakes.
  - **Inputs:** `user`, `fake_eb`, `fake_llm` (all required; each missing one raises `user required` / `fake_eb required (test fake or production client)` / `fake_llm required (test fake or production client)`), `seed` (default `20260115`), `reference_time` (default `2026-01-15 12:00:00`).
  - **Setup:**
    - seeds the random generator and Faker;
    - runs in zone `Europe/Warsaw`;
    - time-travels to the reference time only when the test time helpers are available, otherwise uses the real now (as in the oracle);
    - temporarily redirects `EnableBanking::Client.new` to `fake_eb` unless running inside RSpec;
    - `fake_llm` is only validated, never used.
  - **Steps** (in **one DB transaction**):
    1. **Taxonomy:** BR-213 and BR-229.
    2. **LLM setting:** `gemini` / `fake-gemini-key` / `gemini-2.5-flash`.
    3. **Credentials:** two enable_banking SANDBOX credentials, `PKO BP (Showcase)` (primary, app id `fake-app-pko`) and `Revolut (Showcase)` (`fake-app-revolut`). Both use redirect `http://localhost:3000/admin/oauth/enable_banking/callback` and a fresh 2048-bit RSA key.
    4. **Fake bank sessions:**
       - PKO BP / PL valid 30 days;
       - Revolut LT / LT valid 90 days;
       - one expired PKO session.
    5. **Fake accounts:**

       | Bank | Product | Currency | Balance | IBAN | Holder |
       |---|---|---|---|---|---|
       | PKO | Konto Osobiste | PLN | 12 345.67 | PL61109010140000071219812874 | MACIEJ TEST |
       | PKO | Konto Oszczędnościowe | PLN | 50 000.00 | …2875 | MACIEJ TEST |
       | Revolut | EUR Pocket | EUR | 1 500.00 | LT123456789012345678 (alternate PL00000000000000000000000099) | Maciej Test |
       | Revolut | USD Pocket | USD | 250.00 | same LT IBAN | Maciej Test |

       Balances are given in minor units × 100.
    6. **Fake transactions**, with base date = today − 80 days:
       - PKO card debits: 30, one every 2 days. Amounts cycle 19.99 / 45.00 / 12.50 / 156.00 / 8.99 / 220.00 PLN. Titles cycle `BIEDRONKA WARSZAWA`, `ZABKA NANO`, `MCDONALD'S 5230`, `T-MOBILE POLSKA`, `ROSSMANN 0123`, `DECATHLON`.
       - PKO ATM debits: 6 × 200.00 PLN, every 12 days, title `WYP. BANKOMAT`, type `BLIK ATM`.
       - PKO salary credits: 3 × 6 500.00 PLN on base + 28·i + 5 days, title `WYNAGRODZENIE`, counterparty `Some Company sp. z o.o.`.
       - Revolut EUR debits: 15, one every 5 days. Amounts cycle 9.99 / 14.99 / 5.00 / 25.00. Titles `Spotify`, `Netflix`, `OpenAI`, `Anthropic` with counterparties `Spotify AB`, `Netflix Intl.`, `Openai LLC`, `Anthropic`.
    7. **Connections:** two, created through the real connection-creation operation.
    8. **Sync:** per connection, a `transaction_sync` run (manual) → real sync → rebuild → run succeeded. A failure marks only that run failed.
    9. **Cash:** enable cash tracking (PLN wallet). Six cash debits of 5, 8, 11, 14, 17, 20 PLN, weekly from today − 4 months, titles `Coffee at office`, `Tip at restaurant`, `Newspaper`, `Charity coin`, `Lottery`, `Parking meter`, created through the cash creator.
    10. **Sync schedules:** daily at 08:00. The first connection is enabled; the second is paused.
    11. **Hidden categories:** `noise_authorizations` and `noise_adjustments_fx`.
  - **Result:** `Result(success?, user, credentials, connections, accounts, bank/cash transactions, enrichments, runs, schedules)`. A validation error gives `success?: false` with its messages. Any other error gives `"<Class>: <message>"`.
- **Evidence:** `app/services/seeders/showcase.rb:13-333`.
- **Status:** [V] (specs + the oracle data set).
- **Covered by:** `spec/services/seeders/showcase_spec.rb:6`, `:13`, `:22`, `:29`, `:36`, `:43`, `:54`. The oracle fixture was built with it ([runs](../oracle/operation_runs_after_capture.jsonl) ids 1–4 = showcase `transaction_sync` runs for two tenants).

---

### Service catalogue (Part B)

<a id="svc-categories-creator"></a>
**`app/services/categories/creator.rb`** (`Categories::Creator`)
- Creates a category for a user. Inputs: `user`, `attributes`, `parent_path?`. Output: `Result(success?, category, error_messages)` (`error` = messages joined `", "`). It generates a slug when nil, auto-numbers collisions, composes `parent_path.slug`, and saves. Implements BR-205, BR-202, BR-203.

<a id="svc-categories-mover"></a>
**`app/services/categories/mover.rb`** (`Categories::Mover`)
- Updates a category and, when `parent_path` is given and the path changes, rewrites every descendant path of the same user in one UPDATE inside a transaction. Inputs: `category`, `attributes`, `parent_path?`. Output: `Result(success?, category, error_messages)`. Implements BR-206, BR-207.

<a id="svc-enrichment-classification-applier"></a>
**`app/services/enrichment/classification_applier.rb`** (`Enrichment::ClassificationApplier`)
- Applies a manual classification to one transaction in mode `only_this`, `all_for_merchant` or `create_rule`. Inputs: `transaction`, `actor`, `Input(mode, merchant, category, rule_field, rule_kind, rule_pattern)`. Output: `Result(success, message)`. Implements BR-237, BR-238, BR-239, BR-240.

<a id="svc-enrichment-own-account-merchant-syncer"></a>
**`app/services/enrichment/own_account_merchant_syncer.rb`** (`Enrichment::OwnAccountMerchantSyncer`)
- For one bank account, upserts an "Own account" system merchant plus iban rules (priority 200) for its IBANs, and disables rules for IBANs that are gone. Input: `bank_account` (or `sync_all(scope)`). Output: the merchant, or nil when the account has no IBAN. Implements BR-230, BR-227.

<a id="svc-enrichment-title-normalizer"></a>
**`app/services/enrichment/title_normalizer.rb`** (`Enrichment::TitleNormalizer`)
- Pure functions: `call(title)` → the normalized uppercase merchant signal; `likely_pattern(title)` → the fallback `contains` pattern. Implements BR-264. Used by BR-251, BR-255, BR-257.

<a id="svc-enrichment-transaction-enricher"></a>
**`app/services/enrichment/transaction_enricher.rb`** (`Enrichment::TransactionEnricher`)
- Rule engine. `call(tx, user)`, `enrich_pending(user, scope?)` → count, `rebuild!(user, scope?)`. Writes `TransactionEnrichment` rows from the first matching rule, else the payment-method fallback, else `unmatched`, and never touches manual or overridden rows. Implements BR-226, BR-233, BR-234, BR-235.

<a id="svc-llm-client"></a>
**`app/services/llm/client.rb`** (`Llm::Client`)
- Abstract LLM client and factory. `Client.for(user)` builds the user's configured client or raises `NotConfiguredError`. Defines the `structured(system_prompt, user_prompt, schema)` contract, the `Error` class, and the per-call credential context. Implements BR-247.

<a id="svc-llm-clients-gemini"></a>
**`app/services/llm/clients/gemini.rb`** (`Llm::Clients::Gemini`)
- Gemini implementation of `structured`: schema-constrained chat and JSON parsing, with errors wrapped as `Gemini API error: …` / `Gemini returned non-JSON content: …`. Implements BR-248.

<a id="svc-llm-clients-openai"></a>
**`app/services/llm/clients/openai.rb`** (`Llm::Clients::OpenAI`)
- OpenAI implementation of `structured`, with rate-limit retry (4 retries; the wait is parsed from the message, default 30 s) and errors wrapped as `OpenAI API error: …`. Implements BR-248.

<a id="svc-llm-connection-test-runner"></a>
**`app/services/llm/connection_test_runner.rb`** (`Llm::ConnectionTestRunner`)
- Sends a timestamp-echo probe with the user's setting and records an `llm_connection_test` operation run plus `last_tested_at`/`last_test_error`. Input: `user`. Output: `Result(run, setting)`. Raises `Failed(message)`. Implements BR-249, BR-245.

<a id="svc-llm-enrichable-query"></a>
**`app/services/llm/enrichable_query.rb`** (`Llm::EnrichableQuery`)
- `scope(user)` returns the bank transactions eligible for LLM enrichment. `groups(user, scope?)` returns ordered distinct `[normalized title, counterparty]` groups not covered by any existing rule, each mapped to a sample `{title, counterparty_name}`. Implements BR-250, BR-251.

<a id="svc-llm-enrichment-runner"></a>
**`app/services/llm/enrichment_runner.rb`** (`Llm::EnrichmentRunner`)
- Orchestrates one LLM enrichment run: limits groups (default 50), batches by 15, calls the suggester, enforces patterns, upserts merchants and rules with confidence gating (threshold env, default 0.85), throttles 2 s between batches, and rebuilds when anything was auto-applied. Inputs: `user`, `scope?`, `limit`, `client?`, `throttle_seconds`, `on_batch` callback. Output: `Result(processed, auto_applied, pending_review, skipped, errors)`. Implements BR-254, BR-257, BR-258, BR-259, BR-260, BR-261, BR-262.

<a id="svc-llm-merchant-suggester"></a>
**`app/services/llm/merchant_suggester.rb`** (`Llm::MerchantSuggester`)
- Builds the Polish system prompt (with the user's leaf category paths) and the user prompt for up to 15 items, calls `structured` with the batch schema, and maps results back by index (null result when missing). Exposes `last_input` and `last_response`. Inputs: `user`, `items`, `client?`. Output: an array of suggestion results. Implements BR-255, BR-256.

<a id="svc-llm-providers"></a>
**`app/services/llm/providers.rb`** (`Llm::Providers`)
- Static registry of supported providers (openai, gemini): label, default model, allowed models, client class, credential key. `keys`, `fetch` (raises `Unknown LLM provider: …`), `options_for_select`, `models_by_provider`. Implements BR-244.

<a id="svc-llm-enrichments-queuer"></a>
**`app/services/llm_enrichments/queuer.rb`** (`LlmEnrichments::Queuer`)
- Validates that the user has a configured LLM, creates a queued `llm_enrichment` operation run with `params.limit` (default 50), and enqueues `LlmEnrichmentJob`. Inputs: `user`, `Input(limit)`. Output: `Result(success?, run, error_messages)`. Implements BR-252 (BR-253 for execution).

<a id="svc-merchant-rules-creator"></a>
**`app/services/merchant_rules/creator.rb`** (`MerchantRules::Creator`)
- Creates a user-source, approved rule under a merchant and rebuilds the actor's enrichments on success. Inputs: `merchant`, `actor`, `attributes`. Output: `Result(success?, rule, error_messages)`. Implements BR-228, BR-224.

<a id="svc-merchant-rules-destroyer"></a>
**`app/services/merchant_rules/destroyer.rb`** (`MerchantRules::Destroyer`)
- Destroys a rule (nullifying enrichment references), then rebuilds the actor's enrichments. Inputs: `rule`, `actor`. Output: `Result(success?: true)`. Implements BR-228.

<a id="svc-merchant-rules-updater"></a>
**`app/services/merchant_rules/updater.rb`** (`MerchantRules::Updater`)
- Updates a rule's attributes, keeping its source, and rebuilds only after a successful update. Inputs: `rule`, `actor`, `attributes`. Output: `Result(success?, rule, error_messages)`. Implements BR-228.

<a id="svc-merchants-approver"></a>
**`app/services/merchants/approver.rb`** (`Merchants::Approver`)
- Stamps merchant approval, enables and approves the merchant's disabled llm rules (one transaction), then rebuilds the owner's enrichments. Inputs: `merchant`, `actor`. Output: `Result(success?, merchant)`. Implements BR-221, BR-258.

<a id="svc-merchants-creator"></a>
**`app/services/merchants/creator.rb`** (`Merchants::Creator`)
- Creates a user-source, approved merchant with slug generation and collision numbering. Inputs: `user`, `attributes`. Output: `Result(success?, merchant, error_messages)`. Implements BR-217, BR-216, BR-215.

<a id="svc-seeders-categories"></a>
**`app/services/seeders/categories.rb`** (`Seeders::Categories`)
- Idempotently upserts the 118-node baseline taxonomy for a user, keyed by slug (path with `_`), assigning name, kind, essential, path, position, icon and palette color. Input: `user`. No result value. Implements BR-213.

<a id="svc-seeders-merchant-rules"></a>
**`app/services/seeders/merchant_rules.rb`** (`Seeders::MerchantRules`)
- Idempotently upserts 25 retail system merchants and rules (priority 0), the ATM merchant and rule (priority 300) and the top-up merchant with 3 rules (priority 250). Requires the taxonomy. Input: `user`. Implements BR-229, BR-227.

<a id="svc-seeders-showcase"></a>
**`app/services/seeders/showcase.rb`** (`Seeders::Showcase`)
- Builds the deterministic demo tenant (taxonomy, rules, LLM setting, 2 credentials, 4 fake accounts, 54 fake bank transactions, syncs, cash wallet with 6 cash transactions, 2 sync schedules, 2 hidden categories) through production services. Inputs: `user`, `fake_eb`, `fake_llm`, `seed`, `reference_time`. Output: `Result(success?, user, tpp_credentials, connections, accounts, bank_transactions, cash_transactions, enrichments, operation_runs, sync_schedules, error_messages)`. Implements BR-266.


## Part C — Cash, ledger, analytics, money, time, presentation rules

Scope: the unified ledger read model (`LedgerEntry` view), analytics aggregation (`app/services/analytics/*`), cash
bookkeeping (`app/services/cash/*`, `ManualTransaction`, cash wallets, `User#track_cash`), money storage/formatting,
time zone and period logic, pagination, Ransack and the formatting/privacy helpers in `app/helpers/admin/*`.
All source paths are relative to the source checkout (`src/`). Oracle links are relative to `docs/`.
Oracle "today" was **2026-10-21** (UTC); tenant "main" is the Showcase seed.

Conventions used below:
- "cents" = integer minor units (`bigint`) of the ISO-4217 currency stored in the sibling `currency` column.
- "round()" = Ruby `Float#round` = round half **away from zero** to the stated number of digits.
- Spec references point to `inventory/specs.json` entries; the full suite passed (825 examples, 0 failures, `inventory/specs_run.json`), so a cited spec means **[V]** for what it asserts.

---

### Ledger read model

<a id="br-300"></a>
### BR-300 Unified ledger: one row per bank or manual transaction
**Rule.** Analytics and the `/api/v1/transactions` list read one relation, `ledger_entries` (Postgres VIEW, current
version v04), which is `UNION ALL` of two branches: every `bank_transactions` row (`source_type = 'BankTransaction'`)
and every `manual_transactions` row (`source_type = 'ManualTransaction'`). Natural key = (`source_type`, `source_id`);
`source_id` alone is not unique. Projected columns: `source_type, source_id, bank_account_id, amount_cents, currency,
direction, signed_amount_cents, status, booking_date, transaction_date, payment_method, title, counterparty_name,
counterparty_kind, enrichment_id, merchant_id, effective_category_id, category_path, essential, enrichment_source`.
Not projected: notes, raw payloads, IBANs, external ids. The relation is read-only (any update/save/destroy raises).
Version history (for context): v01 base projection; v02 added `category_path`, `essential`, `recurring`,
`recurrence_interval`; v03 added `counterparty_kind`; v04 dropped `recurring`/`recurrence_interval`.
Kotlin: implement as a DB view or an equivalent query; there is no materialisation and no cache — always fresh.
**Evidence.** `db/views/ledger_entries_v04.sql:13-77`; `db/views/ledger_entries_v01.sql:1-26` (invariants);
`db/views/ledger_entries_v02.sql:1-20`; `db/views/ledger_entries_v03.sql:1-14`; `app/models/ledger_entry.rb:33-41`;
`docs/adr/0003-postgres-view-for-analytics.md`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:31` exists as a database view; `:57` exactly one ledger row per source row (no leaks, no duplicates); `:35` sum-integrity invariant for mixed bank + manual rows; `:196` raises ReadOnlyRecord on update/save/destroy; `:243` round-trips source_record.
**Oracle.** [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) cases `default` (BankTransaction/1) and `manual` (ManualTransaction/1) → 200, entity shape incl. `category_path`.

<a id="br-301"></a>
### BR-301 Amount and sign conventions
**Rule.** `amount_cents` is always a **positive magnitude** on both source tables (bank amounts are stored as the
absolute value; manual amounts must be > 0). Direction is the separate field `direction ∈ {credit, debit}`.
`signed_amount_cents = +amount_cents` when `direction = 'credit'`, otherwise `-amount_cents` (any non-credit value is
treated as debit). API entities expose `amount {cents, currency}` (positive) and `signed_amount {cents, currency}`.
**Evidence.** `db/views/ledger_entries_v04.sql:20-23,54-57`; `app/services/enable_banking/transaction_normalizer.rb:106`
(`.abs`); `app/models/manual_transaction.rb:64` (`greater_than: 0`), `:103-105` (`signed_amount`);
`lib/api/entities/ledger_entry.rb:8-13`; `lib/api/entities/money.rb:5-14`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:74` signed_amount_cents positive for credits, negative for debits regardless of source; `spec/models/manual_transaction_spec.rb:90` positive Money for credits and negation for debits; `spec/models/manual_transaction_spec.rb:46` rejects zero/negative amount_cents.
**Oracle.** [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) case `default` → `amount.cents 2550`, `signed_amount.cents -2550` (debit); case `currency_eur_lowercase` → `101 / 101` (credit).

<a id="br-302"></a>
### BR-302 Effective category resolution
**Rule.** For each ledger row: `effective_category_id = enrichment.category_id` if set (explicit override), else the
enrichment merchant's `default_category_id`, else NULL. `category_path` = ltree path of that effective category (NULL
when unmatched); `essential` = that category's `essential`, **false** when unmatched. `merchant_id`,
`enrichment_source` come from the enrichment (NULL when the row has no enrichment). Changing a category's `kind` or
`essential` re-classifies all rows immediately (no re-enrichment needed). Archived categories are still joined (no
filter on `archived_at`) [I].
**Evidence.** `db/views/ledger_entries_v04.sql:31-36,37-43`; `app/models/concerns/ledger_entry_concern.rb:18-21` (same
rule on the write side).
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:92` override wins over merchant default; `:107` falls back to merchant default; `:121` NULL when neither; `:209` mirrors category_path; `:285` re-categorizes on the fly when a Category's kind changes; `spec/models/concerns/ledger_entry_concern_spec.rb:89` concern agrees with the view across override / merchant-default / unmatched.
**Oracle.** [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json) case `default` → unmatched rows show `effective_category_id: null, category_path: "", essential: false`.

<a id="br-303"></a>
### BR-303 Kind partitioning: spend, income, transfers, savings, ignored, unmatched
**Rule.** Category kinds are `expense | income | transfer | savings | ignored`. Partitions over ledger rows:
- **spend** = `direction = 'debit'` AND effective category kind = `expense`.
- **income** = `direction = 'credit'` AND effective category kind = `income`.
- **transfers** = kind `transfer` (any direction); **savings** = kind `savings` (any direction).
- **ignored** = kind `ignored` — appears in no analytics aggregate.
- **unmatched** = `effective_category_id IS NULL` — appears in no aggregate except the unmatched banner (BR-324).
Consequences: a **credit on an expense category (e.g. a refund) is in neither spend nor income** — it is not netted
against spend; a debit on an income category is in neither. Transfers, savings and ignored never enter cash flow,
spend, net, or savings rate. A BLIK ATM withdrawal is a transfer (category `money.transfers.atm`, kind `transfer`) and
never counts as spend (see U-406).
**Evidence.** `app/models/category.rb:39`; `app/models/ledger_entry.rb:72-78`; `app/services/analytics/cash_flow.rb:4-5`;
`app/services/seeders/categories.rb:146`; `docs/adr/0006-cash-tracking-opt-in.md` (Consequences).
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:132` spend narrows to debits on expense categories, excluding refunds, transfers, and unmatched rows; `:157` income narrows to credits on income categories; `spec/services/analytics/cash_flow_spec.rb:42` excludes transfers from spend and income.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) case `default`: October has a 200.00 PLN BLIK ATM debit (transfer) but `spend_cents: 0`.

<a id="br-304"></a>
### BR-304 Booked-only analytics; pending visible only in lists
**Rule.** Every analytics aggregate (dashboard, drilldowns, `/api/v1/analytics/*`) uses only `status = 'booked'` rows
(rationale: pending rows would double count once they settle). The ledger list `GET /api/v1/transactions` returns
**both** booked and pending unless `status=booked|pending` is passed.
**Evidence.** `app/services/analytics/filter.rb:68-74,76-82,113-121`; `app/services/analytics/spend_breakdown.rb:72-76`;
`lib/api/resources/transactions.rb:27-31`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:273` keeps pending rows visible in all but excludes them from booked.
**Oracle.** n/a (showcase data is all booked).

<a id="br-305"></a>
### BR-305 Single-currency aggregation and currency selection
**Rule.** Analytics never sums across currencies and never converts (no FX). Each request picks exactly one currency:
1. If param `currency` is present, upper-cased, and is one of the user's **available currencies** (distinct
   `currency` values among ledger rows on the user's owned accounts, any status, all time) → that currency (explicit).
2. Otherwise → **dominant currency** = the currency with the most ledger rows (count, any status, all time) on the
   user's owned accounts; ties broken by the database (unspecified order) [I]; if the user has no rows → `"PLN"`.
An unknown/unused currency param (e.g. `USD` with no USD rows) is silently ignored → dominant currency.
All aggregate scopes add `currency = <selected>`. The selected currency is echoed in every analytics API response as
`currency`. Raw `LedgerEntry` sums *can* mix currencies (literal cents addition) — only the Filter prevents it.
**Evidence.** `app/services/analytics/filter.rb:50-66,166-174`; `docs/adr/0003-postgres-view-for-analytics.md`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:52` picks dominant currency by ledger count and respects an explicit known currency override (bogus USD → PLN); `spec/requests/api/v1/analytics_spec.rb:117` honors a currency override that exists in the user's data; `spec/models/ledger_entry_spec.rb:302` raw sums add cents across currencies without conversion; `:313` per-currency grouping.
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) currency chips "EUR", "PLN" only (a USD account exists but has no rows); [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `default` → `"currency": "PLN"`.

<a id="br-306"></a>
### BR-306 Account scoping and the explicit-empty state
**Rule.** Owned accounts = synced accounts under the user's TPP credentials **plus** the user's cash wallets
(`manual_owner_id = user`). Analytics account set:
- `accounts=none` → empty set (every aggregate is 0; "explicit zero state").
- else `account_ids[]` → each value cast to integer, zeros dropped, **intersected with owned ids** (foreign ids silently
  dropped); if the intersection is empty → all owned accounts (default).
- `all_accounts?` = not `none` and no valid explicit ids.
`AccountBreakdown` intersects again with owned ids (defence in depth). Cash-wallet rows therefore participate in
analytics like any account (if categorised, see BR-345).
**Evidence.** `app/services/analytics/filter.rb:13-36`; `app/models/user.rb:74-78`; `app/services/analytics/account_breakdown.rb:15-18`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:26` defaults to full owned list and rejects forged ids; `:37` accounts=none is the explicit zero state, distinct from all_accounts?; `spec/requests/analytics_spec.rb:43` totals ignore another user's data.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) account chips link to `account_ids[]=…` lists (all owned minus the clicked one).

<a id="br-307"></a>
### BR-307 Category subtree filter (`under_path` / `category_path`)
**Rule.** A path filter keeps rows whose `category_path` is equal to or a descendant of the given ltree path
(`category_path <@ path`). Several paths are OR-ed. An empty list yields **no rows** (never widens). Analytics:
`under_path` param narrows both current and previous scopes; drill depth `aggregation_depth = 1` without
`under_path`, else `(number of dots in under_path) + 2`. If `under_path` matches no category of the user the page still
renders (drill chip absent). API `/api/v1/transactions?category_path=` uses the same subtree semantics.
**Evidence.** `app/models/ledger_entry.rb:62-67`; `app/services/analytics/filter.rb:73,81,134-145`;
`app/controllers/admin/analytics/dashboard_controller.rb:54`; `lib/api/resources/transactions.rb:35`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:222` filters under_path to subtree containment, none for empty input; `spec/requests/analytics_spec.rb:24` under_path resolves @drill_category; `:34` unknown under_path still renders.
**Oracle.** n/a.

---

### Time and periods

<a id="br-310"></a>
### BR-310 Time zone and "today"
**Rule.** No `config.time_zone` is configured, so the application zone is **UTC**. "Today" everywhere in this part
is `Date.current` = the current **UTC** calendar date (e.g. 2026-10-21 00:30 Europe/Warsaw is still 2026-10-20).
Ledger dates (`booking_date`, `transaction_date`) are SQL `DATE` (no time component, no conversion). All period
bounds are **inclusive** on both ends (`booking_date BETWEEN from AND to`). Week start is **Monday** (Rails default
`beginning_of_week`, Postgres `DATE_TRUNC('week')` also Monday). Only the showcase seeder uses Europe/Warsaw explicitly.
Whether UTC is intended is open (see U-405).
**Evidence.** `config/application.rb:32-46` (no `time_zone`); `app/models/ledger_entry.rb:57`; `app/services/analytics/period.rb:42-44,49`;
`app/services/seeders/showcase.rb:52`.
**Status.** [V] for Monday weeks and inclusive bounds (oracle); [I] for UTC (no oracle run straddling midnight).
**Covered by.** `spec/services/analytics/period_spec.rb:25` week buckets start at beginning_of_week.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `default` → `period.to = "2026-10-21"`; dashboard week labels start "13 Jul" (2026-07-13 is a Monday) in [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html).

<a id="br-311"></a>
### BR-311 Default period and date-param handling
**Rule.** Analytics period:
- Only when **both** `from` and `to` are present are they used; otherwise (none or just one) the period is
  **month-to-date**: `from = first day of the current month`, `to = today` (BR-310).
- Admin (HTML) params are parsed leniently; an unparseable date becomes **today** (no error).
- API params are typed `Date`; an invalid date → **400** `{"message":"Invalid parameters.","details":["from is invalid"]}`
  (wording per Grape, e.g. for `/api/v1/transactions`).
- `from > to` raises `ArgumentError("from must be <= to")` → **HTTP 500** in the API (JSON
  `{"message":"ArgumentError: from must be <= to"}`) and, by the same code path, in the admin dashboard [I] (see U-402).
- `length_days = (to − from) + 1` (inclusive).
**Evidence.** `app/services/analytics/filter.rb:176-190,202-206`; `app/services/analytics/period.rb:17-24`;
`lib/api/resources/analytics/cash_flow.rb:10-17`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:15` defaults to month-to-date; `spec/services/analytics/period_spec.rb:6` rejects from > to with ArgumentError; `:11` length_days inclusive; `spec/requests/api/v1/analytics_spec.rb:129` rejects an invalid date with 400.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `default` → period 2026-10-01..2026-10-21; `from_after_to` → 500 `{"message": "ArgumentError: from must be <= to"}`; [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json) `invalid_params` → 400 `["from is invalid", "direction does not have a valid value"]`.

<a id="br-312"></a>
### BR-312 Bucket granularity selection
**Rule.** Buckets are `day | week | month`. If param `bucket` is one of these it is used ("explicit"); any other value
is ignored in the admin UI (auto), while the API validates it → 400 `{"message":"Invalid parameters.","details":["bucket does not have a valid value"]}`.
Auto bucket by `days = length_days`: `1..31 → day`, `32..180 → week`, otherwise `month`.
**Evidence.** `app/services/analytics/filter.rb:42-48,193-200`; `lib/api/resources/analytics/cash_flow.rb:13`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:69` smart bucket default ≤31d day, ≤180d week, else month.
**Oracle.** [../oracle/http/GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json) 101-day range → `"bucket": "week"`; [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `invalid_bucket` (`bucket=year`) → 400.

<a id="br-313"></a>
### BR-313 Bucket boundaries and gap filling
**Rule.** Series bucket keys:
- `day`: every date from `from` to `to` inclusive.
- `week`: Mondays, starting at the Monday on/before `from`, stepping 7 days while `≤ to`.
- `month`: first-of-month dates, starting at the first of `from`'s month, stepping one month while `≤ to`.
The first week/month bucket key may lie **before** `from`, but only rows inside `[from, to]` are summed into it
(partial first/last buckets). Rows are grouped by `DATE_TRUNC(<bucket>, booking_date)::date`. Missing buckets are
filled with 0 (gap-fill in application code).
**Evidence.** `app/services/analytics/period.rb:30-66`; `app/services/analytics/cash_flow.rb:16-23,35-39`.
**Status.** [V]
**Covered by.** `spec/services/analytics/period_spec.rb:19` one date per day; `:25` week/month stepping; `:34` fill maps a sparse series onto every bucket; `spec/services/analytics/cash_flow_spec.rb:55` one Point per bucket gap-filled with zero.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `explicit_range` (`from=2026-07-13&to=2026-10-21&bucket=month`) → series dates `2026-07-01, 2026-08-01, 2026-09-01, 2026-10-01` (July bucket 0).

<a id="br-314"></a>
### BR-314 Comparison ("previous") period and its label
**Rule.** Previous range for deltas:
1. **Full calendar month** (`from` = 1st of a month and `to` = last day of that month): previous = the whole previous
   calendar month. Label: `"vs <Mon YYYY>"` of the previous month (e.g. `vs Sep 2026`).
2. Else **month-to-date** (`from` = 1st of current month and `to` = today): `prev_from` = 1st of previous month,
   `prev_to = min(prev_from + (length_days − 1), last day of previous month)`. Label: `"vs <Mon> <d1>–<d2>"` with an
   en dash (e.g. `vs Sep 1–21`).
3. Else: same-length window immediately before: `[from − length_days, from − 1]`. Label: `"vs previous <N> days"`.
Rule 1 is checked first (so the last day of a month counts as a full month). The previous scope uses the same
accounts, currency, booked filter and `under_path`.
**Evidence.** `app/services/analytics/filter.rb:76-132`; `app/services/analytics/period.rb:26-28`.
**Status.** [V]
**Covered by.** `spec/services/analytics/period_spec.rb:11` previous is the same-length window ending the day before from.
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) (MTD 1–21 Oct) → "less than Sep 1–21"; [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) (101 days) → "biggest swings · vs previous 101 days".

<a id="br-315"></a>
### BR-315 Period presets (dashboard filter strip)
**Rule.** Month presets (relative to today T): **This month** = 1st of T's month..T; **Last month** = previous calendar
month; **Last 3M / 6M / 12M** = 1st of the month 3/6/12 months before T .. last day of the previous month (complete
months only). Day presets **Today, 3d, 7d, 14d, 30d, 60d, 90d, 180d, 365d**: `from = T − (N − 1)`, `to = T`. Preset
links drop `bucket` (auto re-applies) and keep accounts/currency/under_path. A day preset is highlighted when
`length_days = N` and no month preset is active.
**Evidence.** `app/views/admin/analytics/shared/_filter_strip.html.erb:5-55,99-124`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) links: Last month `from=2026-09-01&to=2026-09-30`, Last 3M `2026-07-01..2026-09-30`, Last 12M `2025-10-01..2026-09-30`, 3d `2026-10-19..2026-10-21`, 365d `2025-10-22..2026-10-21`.

<a id="br-316"></a>
### BR-316 Filter state in URLs
**Rule.** Links between analytics views carry: `from`, `to` (ISO dates, always), `bucket` only if explicit,
`currency` only if explicit and valid, `under_path` if set, and either `accounts=none` (zero state) or
`account_ids[]` (explicit narrowing) or neither (default all accounts). Toggling an account chip: from the default
state removes that account (all others explicit); if the resulting set equals all owned accounts, no account param is
emitted; if empty, `accounts=none`. "Reset" removes the account params.
**Evidence.** `app/services/analytics/filter.rb:147-162`; `app/views/admin/analytics/shared/_filter_strip.html.erb:56-84,187-195`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:81` to_query_params omits accounts and bucket when at default state.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) links `?bucket=week&from=…`, `?currency=EUR&from=…`, `?account_ids[]=5&account_ids[]=4…`.

---

### Totals and KPIs

<a id="br-320"></a>
### BR-320 Cash-flow totals, net and series
**Rule.** Over the filtered scope (BR-304..BR-307, BR-311):
`spend_cents = Σ amount_cents of spend rows`; `income_cents = Σ amount_cents of income rows`;
`net_cents = income_cents − spend_cents` (may be negative). Series: per bucket (BR-313) the same three numbers.
API `GET /api/v1/analytics/cash_flow` returns `{currency, period:{from,to,bucket}, totals:{spend_cents,income_cents,net_cents}, series:[{date,spend_cents,income_cents,net_cents}]}`.
A series point is "quiet" when spend and income are both 0; if all points are quiet the dashboard shows "All quiet" /
"No transaction in the selected period changed the balance.". "Biggest <bucket>" = point with max `|net_cents|`.
**Evidence.** `app/services/analytics/cash_flow.rb:7-33`; `lib/api/resources/analytics/cash_flow.rb:18-34`;
`app/views/admin/analytics/dashboard/index.html.erb:494-516`.
**Status.** [V]
**Covered by.** `spec/services/analytics/cash_flow_spec.rb:28` totals split spend and income, net = income − spend; `spec/requests/api/v1/analytics_spec.rb:6` returns totals + a date-bucketed series.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `explicit_range` → totals `231240 / 1950000 / 1718760`; dashboard range "Net flow +zł17,187.60", "Biggest week +zł6,286.50 · 3 Aug".

<a id="br-321"></a>
### BR-321 Spend change percentage
**Rule.** `prev_spend = spend_cents` of the previous range (BR-314). If `prev_spend = 0` → no value (card shows "-",
hint "no prior period to compare"). Else `spend_delta_pct = round((spend − prev_spend) / prev_spend × 100)` (integer).
Display `+N%` when positive, `N%` otherwise; hint `more than <label>` / `less than <label>` / `same as <label>` where
`<label>` is the previous label without the leading `vs `.
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:12-17,80-83`; `app/views/admin/analytics/dashboard/index.html.erb:316-341`.
**Status.** [V]
**Covered by.** untested (only render 200 in `spec/requests/analytics_spec.rb:6`).
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) → "-100% Spend change less than Sep 1–21" (spend 0 vs >0); [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "- Spend change no prior period to compare".

<a id="br-322"></a>
### BR-322 Savings rate
**Rule.** If `income_cents = 0` → no value ("-", hint "no income in period"). Else
`savings_rate_pct = round((income − spend) / income × 100)` (integer, may be negative). Hint "of income kept" when ≥ 0,
"spent more than earned" when < 0.
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:18,85-88`; `app/views/admin/analytics/dashboard/index.html.erb:343-357`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "88% Savings rate of income kept" ((1950000−231240)/1950000 = 88.14 %); MTD page → "100%".

<a id="br-323"></a>
### BR-323 Average daily spend and month-end run-rate
**Rule.** `avg_daily_spend_cents = spend_cents div length_days` (integer division, truncation).
Run-rate only when the period is month-to-date (BR-314 case 2) **and** `days_elapsed = length_days ≥ 3`:
`run_rate_cents = round(spend_cents × days_in_current_month / days_elapsed)`. When run-rate exists the card
"Run-rate" replaces "Avg daily spend". In MTD, `prev_full_month_spend_cents` = spend of the whole previous calendar
month (same accounts/currency/under_path); hint `vs <amount> last month` (else "projected end of month").
Tone: `run_rate_delta_pct = round((run_rate − prev_full) / prev_full × 100)` only if `prev_full > 0`;
`> 5` → destructive, `< −5` → success, otherwise/none → info. Avg card hint: `per day · <N> account(s)`.
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:20-34`; `app/services/analytics/filter.rb:113-121`;
`app/views/admin/analytics/dashboard/index.html.erb:290-314`.
**Status.** [V]
**Covered by.** `spec/requests/analytics_spec.rb:15` computes month-to-date run rate when ≥ 3 days elapsed (asserts 200 only).
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) → "zł0 Run-rate vs zł1,309.95 last month" (Sep spend 130995 matches cash_flow Sep bucket); [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "zł22.89 Avg daily spend per day · 6 accounts" (231240 div 101 = 2289).

<a id="br-324"></a>
### BR-324 Unmatched-debit warning
**Rule.** `unmatched = booked debits in scope with effective_category_id IS NULL`. If `count > 0` show banner
`"<N> transaction(s) awaiting classification"` (Rails pluralize) with description
`"<amount>[ · <P>% of detected spend] - these don't appear in totals below until classified."`, action "Classify now"
→ AI enrichment page. `P = round(unmatched_cents / (spend_cents + unmatched_cents) × 100)`; the "· P%" fragment only
when `P > 0`. Separately, when the leaf category chart is empty: no active categories → "Taxonomy not set up"; else if
**any** booked debit in scope exists (including classified transfers) → `"<N> transactions awaiting classification"` /
"Raw debits exist in the period but none have been mapped to a category yet. Run AI enrichment or classify them
manually."; else "No spend" / "No spending in the selected period/accounts." (see U-412).
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:65-75`; `app/views/admin/analytics/dashboard/index.html.erb:259-275,376-401` (banner from line 261).
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "2 transactions awaiting classification zł37 · 2% of detected spend - these don't appear in totals below until classified." (3700/(231240+3700) = 1.6 % → 2); [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) → "1 transactions awaiting classification" empty state while the only debit is a classified ATM transfer.

<a id="br-325"></a>
### BR-325 Spend breakdown by category
**Rule.** Over **spend** rows with non-NULL `category_path`:
- `depth = nil` (leaf mode): one row per distinct full `category_path`.
- `depth = d`: rows with `nlevel(category_path) ≥ d`, grouped by the first `d` labels (`subpath(path,0,d)`); rows on
  shallower categories are **dropped** (so the total can be less than cash-flow spend, see U-413).
Row = `{path, name, amount_cents = Σ, count, prev_amount_cents, delta_pct}`; sorted by amount desc. `name` = the
user's category with that exact path, else the last path label with `_`→space, title-cased. `slug` = path with `.`→`_`.
With a previous scope: `prev_amount_cents` = same grouping over the previous range (0 if absent). Rows that exist
**only** in the previous range are not returned. `delta_pct = round((amount − prev) / prev × 100)` or null if prev is
0/nil. Dashboard: leaf chart (depth nil) and domain chart (`depth = aggregation_depth`, BR-307).
API `GET /api/v1/analytics/spend` (params from,to,bucket,currency,account_ids,under_path,depth) →
`{currency, period:{from,to,bucket}, total_cents = Σ rows.amount_cents, rows:[{path,slug,name,amount_cents,prev_amount_cents,count,delta_pct}]}`.
**Evidence.** `app/services/analytics/spend_breakdown.rb:5-32,84-106`; `lib/api/resources/analytics/spend.rb:19-45`;
`app/controllers/admin/analytics/dashboard_controller.rb:37-52`.
**Status.** [V]
**Covered by.** `spec/requests/api/v1/analytics_spec.rb:20` returns category-grouped rows with previous-period delta fields.
**Oracle.** [../oracle/http/GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json) `depth=2` → `total_cents 229241` vs cash-flow spend 231240 for the same range (difference 1999 = one row categorised directly on `food`, visible as "Jedzenie 19.99" in the leaf chart of [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html)); `prev_amount_cents: 0, delta_pct: null`.

<a id="br-326"></a>
### BR-326 Top movers
**Rule.** Input = leaf breakdown with previous amounts (BR-325). For each row: `delta = current − prev`; keep only if
`|delta| ≥ 5000` cents **and** `max(current, prev) ≥ 5000` cents (fixed 50.00 in any currency). Sort by `|delta|`
desc, take 5. `direction = up` if `delta ≥ 0` else `down`; `new_spend` = `prev = 0 and current > 0` (badge "new",
text "new this period"); otherwise show `±delta_pct%` and `"+<|delta|> vs prev"` / `"−<|delta|> vs prev"`. Card
subtitle `"biggest swings · <previous label>"`. Shown only if any mover. Categories whose spend fell to 0 cannot appear
(see U-409).
**Evidence.** `app/services/analytics/top_movers.rb:6-34`; `app/controllers/admin/analytics/dashboard_controller.rb:58`;
`app/views/admin/analytics/dashboard/index.html.erb:642-680`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → five movers all "new" (zł1,100 … zł62.50); "Drogerie" 44.95 and "Jedzenie" 19.99 excluded (< 50.00).

<a id="br-327"></a>
### BR-327 Top merchants
**Rule.** Spend rows with non-NULL `merchant_id`, grouped by merchant, `Σ amount_cents` desc, limited (dashboard 8,
API default 10, param `limit`), only merchants belonging to the user. Ties: database order [I]. API
`GET /api/v1/analytics/top_merchants` → `{currency, period:{from,to}, rows:[{merchant:{id,name,slug,default_category_id}, amount_cents, count}]}`.
No upper bound on `limit` [I].
**Evidence.** `app/services/analytics/top_merchants.rb:9-24`; `lib/api/resources/analytics/top_merchants.rb:9-40`;
`app/controllers/admin/analytics/dashboard_controller.rb:43`.
**Status.** [V]
**Covered by.** `spec/services/analytics/top_merchants_spec.rb:6` ordered by SUM desc limited; `:29` respects limit; `:46` Money wrapper; `spec/requests/api/v1/analytics_spec.rb:32` top spend merchants for the period.
**Oracle.** [../oracle/http/GET_api__version_analytics_top_merchants.json](../oracle/http/GET_api__version_analytics_top_merchants.json) `limit=5` → Decathlon 110000 (5) … McDonald's 6250 (5).

<a id="br-328"></a>
### BR-328 Account share of spend
**Rule.** Spend grouped by `bank_account_id`, `Σ desc`, owned accounts only; donut total = Σ rows; clicking an
account links to the dashboard with `account_ids[] = [that id]`. Empty → "No data" / "No spend on any of the
selected accounts.".
**Evidence.** `app/services/analytics/account_breakdown.rb:9-25`; `app/views/admin/analytics/dashboard/index.html.erb:146-153,518-528`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "Total zł2,312.40 1 account"; MTD page → "No data".

<a id="br-329"></a>
### BR-329 Essentials vs discretionary
**Rule.** Over spend rows: Essential = `essential = true`, Discretionary = `essential = false` (unmatched rows are not
spend, so not included). `total = ess + dis`; `share% = round(part / total × 100, 1)`, 0 when total = 0 (the two
shares are rounded independently and may not sum to 100.0). Card shown only when `spend_cents > 0`; subtitle
`"<left_share>% of spend covers needs"`; counts as `pluralize(n, "tx")`.
**Evidence.** `app/services/analytics/facet_breakdown.rb:9-24`; `app/views/admin/analytics/dashboard/index.html.erb:469-489`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "48.9% of spend covers needs Essential zł1,129.91 48.9% · 19 txes Discretionary zł1,182.49 51.1% · 11 txes".

<a id="br-330"></a>
### BR-330 Category drilldown
**Rule.** Category looked up by `slug` among the **user's** categories (unknown or other user's slug → 404).
Admin only: if the category (or an ancestor) is hidden → redirect to the dashboard (filter params kept) with alert
`"This category is private. Remove it from the hidden list in preferences to open it."`.
Merchants list = spend rows in the category **subtree** (BR-307) grouped by `merchant_id` (a NULL-merchant group is
included as `merchant: null`), Σ desc. `total_cents = Σ merchants` (= whole-subtree spend). Sub-category rows (only if
the category has descendants) = subtree spend grouped by the next level (`depth = dots + 2`); rows booked directly on
the category itself are excluded from the sub-category list. API `GET /api/v1/analytics/categories/:slug` →
`{category:{id,name,slug,path,kind}, currency, period:{from,to}, total_cents, merchants:[{merchant:{id,name,slug}|null, amount_cents, count}], subtree:[{path,slug,name,amount_cents,count}]}`.
The API applies **no** hidden-category gate (see U-411).
**Evidence.** `app/controllers/admin/analytics/categories_controller.rb:6-26`; `lib/api/resources/analytics/categories.rb:18-56`;
`app/services/analytics/spend_breakdown.rb:34-64`.
**Status.** [V]
**Covered by.** `spec/requests/analytics_spec.rb:55` 200 happy path; `:65` 404 unknown slug; `:74` 404 another user's category; `:85` redirects when hidden; `spec/requests/api/v1/analytics_spec.rb:64` category drilldown shape; `:44`, `:53` 404s; `spec/system/daily_login_analytics_spec.rb:48` drills into a category by slug.
**Oracle.** [../oracle/http/GET_api__version_analytics_categories__slug.json](../oracle/http/GET_api__version_analytics_categories__slug.json) `food` → `total_cents 38745` (merchants) while subtree rows sum to 36746 (the 1999 row on `food` itself is excluded from `subtree`); `unknown_slug` → 404 `{"message": "Couldn't find Category with [WHERE \"categories\".\"user_id\" = $1 AND \"categories\".\"slug\" = $2]"}`.

<a id="br-331"></a>
### BR-331 Merchant drilldown and 12-month trend
**Rule.** Merchant by `slug` among the user's merchants (else 404). Admin only: if the merchant's **default category**
is hidden → redirect with alert `"This merchant is in a hidden category. Remove it from the hidden list in preferences to open it."`.
Period figures: spend rows of that merchant in the filtered scope → `total_cents`, `count`, and a paginated list
ordered by `booking_date desc` (BR-367). **Monthly trend** ignores the selected period and accounts: always the last
12 calendar months including the current one (`from` = 1st of the month 11 months ago, `to` = today), all owned
accounts, selected currency, booked spend of that merchant, month buckets gap-filled with 0. API
`GET /api/v1/analytics/merchants/:slug` → `{merchant:{id,name,slug,default_category_id}, currency, period:{from,to}, total_cents, count, monthly_trend:[{period, amount_cents}], transactions:[LedgerEntry], pagination:{page,limit,count,pages}}`.
**Evidence.** `app/controllers/admin/analytics/merchants_controller.rb:6-39`; `app/services/analytics/spend_breakdown.rb:66-82`;
`lib/api/resources/analytics/merchants.rb:20-53`.
**Status.** [V]
**Covered by.** `spec/requests/analytics_spec.rb:97` zero totals for merchant without transactions; `:107` 404 unknown; `:116` 404 other user's; `:127` redirects when default category hidden; `spec/requests/api/v1/analytics_spec.rb:77`, `:86`, `:97`.
**Oracle.** [../oracle/http/GET_api__version_analytics_merchants__slug.json](../oracle/http/GET_api__version_analytics_merchants__slug.json) `biedronka` (range 07-13..10-21) → `total_cents 9995, count 5`, `monthly_trend` 2025-11-01 … 2026-10-01 (12 entries).

<a id="br-332"></a>
### BR-332 Dashboard lists and chart value conversion
**Rule.** Leaf category chart: first 20 rows, remaining rows collapsed into `"Other (<n>)"` with their summed amount.
Domain chart: first 10 rows; clicking narrows the dashboard via `under_path`. "Biggest transactions": top 5 spend rows by
`amount_cents desc` (ties in DB order). Chart values are `round(cents / 100.0, 2)` major units for **every** currency
(assumes 2-decimal currencies, see U-415). Date labels: day/week `"%-d %b"` (e.g. `13 Jul`), month `"%b %y"`.
Period hint: MTD `"<N> day(s) of <Mon>"`, else `"<N> day(s)"`.
**Evidence.** `app/views/admin/analytics/dashboard/index.html.erb:9-21,38-59,99-101,407-411`; `app/controllers/admin/analytics/dashboard_controller.rb:60-63`.
**Status.** [V]
**Covered by.** `spec/system/daily_login_analytics_spec.rb:16` renders the key stat cards; `:34` zero amounts for a brand-new user.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) chart config `"data":[1100.0,780.0,225.0,79.96,62.5,44.95,19.99]`, labels `13 Jul, 20 Jul, …`; "Spend 21 days of Oct" on the MTD page.

<a id="br-333"></a>
### BR-333 Hidden categories in analytics
**Rule.** A category is hidden for a user if it or any ancestor is in the user's hidden list, unless the user has
`reveal_hidden_categories` on. Hidden rows are **still counted** in all totals; only labels are replaced with `•••`
and drill links removed (category bars, top merchants whose default category is hidden, top movers, cash and bank
transaction rows). Admin drilldowns redirect (BR-330, BR-331). No masking in the JSON API (see U-411).
**Evidence.** `app/models/user.rb:49-64`; `app/views/admin/analytics/dashboard/index.html.erb:42-51,184-190,648-650`;
`app/helpers/admin/hide_private_helper.rb:7-20`.
**Status.** [I] (no hidden expense category in the oracle data)
**Covered by.** `spec/requests/analytics_spec.rb:85`, `:127` (redirects only).
**Oracle.** n/a.

<a id="br-334"></a>
### BR-334 AI insight card (ADR 0008) is not implemented
**Rule.** ADR 0008 describes `Analytics::AiInsight` (facts struct: spend total, delta vs previous, top category/merchant
with delta, 0–2 notable movers with `|delta_pct| ≥ 100 % AND amount ≥ 200 PLN`; LLM writes 3 sentences; a guard
rejects any digit sequence not present in the facts; failures degrade to a muted callout). **No such class, view or
route exists** in the checked-out code; the dashboard renders no AI card. Kotlin must not implement it unless decided
(see U-408).
**Evidence.** `docs/adr/0008-ai-insight-architecture.md`; absence: `grep -ri insight app lib` → no matches.
**Status.** [V] (absence confirmed by search; oracle dashboard has no AI card)
**Covered by.** `spec/system/daily_login_analytics_spec.rb:64` renders the dashboard with no LlmSetting (no AI insight callout).
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html).

---

### Cash bookkeeping

<a id="br-340"></a>
### BR-340 Cash tracking opt-in (`User#track_cash`)
**Rule.** `users.track_cash` boolean, default **false**. Manual cash entries can be created regardless of the flag;
the flag only gates **automatic ATM linking** (BR-349). When the App preferences update changes the flag from off to
on: (1) ensure a **PLN** wallet (always PLN, BR-341); (2) backfill: for every bank transaction of the user with
`payment_method = 'blik_atm'` and `direction = 'debit'`, run the linker; `linked` = number of newly created top-ups.
Flash: `"App settings saved. Created a PLN wallet and linked <N> historical ATM withdrawal(s)."` (the wallet sentence
appears even when the wallet already existed). Without the off→on transition: `"App settings saved."`. Turning the
flag off deletes nothing; only future links stop.
**Evidence.** `app/controllers/admin/settings/preferences_controller.rb:33-47`; `app/services/cash/tracking.rb:6-30`;
`docs/adr/0006-cash-tracking-opt-in.md`.
**Status.** [V] (service behaviour via specs); flash text [I] (oracle user already had the flag on).
**Covered by.** `spec/services/cash/tracking_spec.rb:6` backfills every eligible BLIK ATM debit and reports the count; `:21` second enable! reports 0; `:36` only blik_atm debits; `:52` creates the wallet but the linker no-ops when track_cash false; `:67` scoped to the requesting user; `spec/system/cash_with_atm_link_spec.rb:60` cash index renders without track_cash.
**Oracle.** [../oracle/http/PATCH_admin_settings_preferences_app.json](../oracle/http/PATCH_admin_settings_preferences_app.json) `default` → 302 to `/admin/settings/preferences/app`.

<a id="br-341"></a>
### BR-341 Cash wallet resolution (one wallet per user and currency)
**Rule.** A cash wallet is a `bank_accounts` row with `manual = true`, `manual_owner_id = user`, `tpp_credential_id = NULL`.
Lookup/creation key: `uid = "cash_<user_id>_<currency lower-case>"` (globally unique). If absent it is created with
`currency = <upper-case ISO>`, `cash_account_type = "CASH"`, `status = "active"`, `name = "Cash wallet (<ISO>)"`,
`all_account_ids = []`. Errors: no user → `ArgumentError "user required"`; blank currency → `"currency required"`.
Balances stay native per currency (no FX). The wallet is created **before** and outside the transaction that saves the
cash row, so it persists even if the row fails validation (see U-404).
**Evidence.** `app/services/cash/wallet_resolver.rb:4-41`; `app/models/bank_account.rb:54-57,134-138`; `app/services/cash/transaction_creator.rb:61-64`.
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:30` ' eur ' → EUR wallet uid `cash_<id>_eur`; `:79` two creates reuse the same wallet.
**Oracle.** [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `currency_eur_lowercase` → new wallet `bank_account_id 11`; [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) shows "Cash wallet (EUR)", "Cash wallet (PLN)".

<a id="br-342"></a>
### BR-342 Cash amount parsing and rounding
**Rule.** Input `amount` (string):
1. `to_string → trim → replace every "," with "."`.
2. Blank → create: `amount_cents = NULL` (validation error); update: **keep** the current amount.
3. Parse as exact decimal; any parse failure (letters, `"-"`, thousands separators such as `"1,234.56"` or
   `"1 234,56"`) → `amount_cents = NULL` → validation error.
4. `amount_cents = round(decimal × 10^exponent(currency), HALF_UP)` using the row currency (create: normalised input
   currency; update: the existing row currency — currency cannot change).
5. Negative or zero values parse but fail validation (`> 0`).
Rounding mode is money gem default `ROUND_HALF_UP` (money 7.0.2).
**Evidence.** `app/services/cash/transaction_creator.rb:26-32`; `app/services/cash/transaction_updater.rb:19-25`;
`bundle/.../money-7.0.2/lib/money/money.rb:235-237` (default rounding).
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:40` "12,34" → 1234 and blank → presence failure; `:89` junk amount → presence failure on amount_cents; `spec/services/cash/transaction_updater_spec.rb:49` "10,00" on EUR wallet → 1000; `:98` junk amount rolls back.
**Oracle.** [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `currency_eur_lowercase` (`amount "1.005"`, `currency "eur"`, `direction "credit"`) → 201, stored `amount.cents 101`, `currency "EUR"`, `signed_amount 101`, `booking_date "2026-10-21"` (today), `payment_method "cash"`, `counterparty_kind "unknown"`, `source "manual"`, enrichment `{source:"manual", category_id:null, category_overridden:false}`, new EUR wallet id 11 — i.e. 1.005 rounds **half-up** to 1.01; `invalid_amount` (`"12,3x"`) → 422 `{"message": "Amount cents is not a number, Amount is not a number, Amount cents can't be blank", "details": ["Amount cents is not a number", "Amount is not a number", "Amount cents can't be blank"]}`; [../oracle/http/PUT_admin_cash_transactions__id.json](../oracle/http/PUT_admin_cash_transactions__id.json) amount `"-"` → 422.

<a id="br-343"></a>
### BR-343 Cash create defaults and normalisation
**Rule.** `currency = trim(upper(input))`, blank → `"PLN"` (API param default is also `"PLN"`); `direction` blank →
`"debit"`; `payment_method` blank → `"cash"`; `booking_date` blank **or unparseable** → today (BR-310, silently);
`transaction_date` blank/unparseable → NULL; `title`, `note`, `counterparty_name` blank → NULL; `status = "booked"`;
`source = "manual"`; `created_by_user = current user`. API: `amount` required (missing → 400
`{"message":"Invalid parameters.","details":["amount is missing"]}`), `direction ∈ {credit, debit}`, dates typed.
Success: admin redirects to `/admin/cash_transactions` with notice `"Saved <expense|income> <formatted amount>."`
(`income` when credit) — e.g. `Saved expense zł25.00.` [I for exact rendering, BR-361]; API → 201 with the
ManualTransaction entity. Failure: admin re-renders the form with **422** and alert = messages joined by `", "` or
`"Could not save the transaction."`; API → 422 `{message, details[]}`.
**Evidence.** `app/services/cash/transaction_creator.rb:16-21,34-35,60-106`; `app/controllers/admin/cash_transactions_controller.rb:42-56,139-143`;
`lib/api/resources/cash_transactions.rb:35-59`.
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:11` persists in the PLN wallet with manual enrichment; `:54` defaults direction=debit, payment_method=cash, booking_date=today; `spec/requests/cash_spec.rb:96` expense notice; `:119` income notice; `:135` 422 re-render; `:150` falls back to a new record; `spec/requests/api/v1/transactions_spec.rb:84` 201; `:102` 422 with details.
**Oracle.** [../oracle/http/POST_admin_cash_transactions.json](../oracle/http/POST_admin_cash_transactions.json) `default` → 302 `/admin/cash_transactions`, `invalid_amount` → 422 form; [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `default` → 201, `missing_amount` → 400.

<a id="br-344"></a>
### BR-344 ManualTransaction validation rules and messages
**Rule.** Required: `amount_cents`, `currency`, `booking_date`. `amount_cents > 0` (numeric). `currency` ∈ all ISO
codes known to the money library. `direction ∈ {credit, debit}`; `status ∈ {booked, pending}`; `payment_method ∈
{cash, cash_atm_topup, cash_deposit, cash_fx_conversion, cash_adjustment}` or NULL; `source ∈ {manual, atm_link,
csv_import, recurring}`; `counterparty_kind ∈ {self, external, unknown}`. Account must be a wallet: error on
`bank_account` `"must be a manual cash wallet"` (full: "Bank account must be a manual cash wallet"); currency must
equal wallet currency: `"must match wallet currency (<ISO>)"`. At most one manual row per linked bank transaction
(DB partial unique index on `linked_bank_transaction_id`). Every change is audited (paper trail).
**Evidence.** `app/models/manual_transaction.rb:46-72,113-122`; annotation `:28` (unique index).
**Status.** [V]
**Covered by.** `spec/models/manual_transaction_spec.rb:46` amount > 0; `:61` wallet error; `:72` currency_matches_wallet; `:122` RecordNotUnique on a second link; `:110` for_user scoping.
**Oracle.** see BR-342 (`Amount cents can't be blank` etc.).

<a id="br-345"></a>
### BR-345 Enrichment written for manual rows
**Rule.** Create and update always (re)write the row's enrichment with `source = "manual"`, `enriched_at = now`,
`merchant` = the user's **active** merchant with `merchant_id` (else NULL), `category` = the user's **active** category
with `category_id` (else NULL), and `category_overridden = true` **iff a category_id was supplied** — even when the id
was foreign/archived and dropped (documented quirk). Because the source is `manual`, the automatic enricher never
touches these rows: a cash row with neither category nor merchant (or a merchant without default category) stays
**unmatched** forever, so it is excluded from spend/income and only shows in the unmatched banner (debits) — see U-407.
**Evidence.** `app/services/cash/transaction_creator.rb:91-98,110-118`; `app/services/cash/transaction_updater.rb:76-84,96-104`;
`app/services/enrichment/transaction_enricher.rb:96-99`.
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:11`; `:67` drops another user's category_id but flips category_overridden; `spec/services/cash/transaction_updater_spec.rb:18` rewrites as manual with overridden=true; `:60` clearing category_id → overridden false, category NULL; `:73` foreign category quirk; `:85` builds a missing enrichment.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) seeded cash expenses show "unclassified Manual".

<a id="br-346"></a>
### BR-346 Counterparty kind on manual rows
**Rule.** On manual create/update: `payment_method ∈ {cash_atm_topup, cash_deposit, cash_fx_conversion, cash_adjustment}`
→ `self`; else `counterparty_name` blank → `unknown`; else upper-cased/trimmed name equal to one of the user's own
account holder names → `self`; else `external`. (IBAN is never available for manual rows.) The ATM linker does **not**
run this resolver, so linked top-ups keep the DB default `unknown` (see U-401).
**Evidence.** `app/services/banking/counterparty_resolver.rb:10-35`; `app/services/cash/transaction_creator.rb:80-85`;
`app/services/cash/transaction_updater.rb:67-72`; `app/services/cash/atm_withdrawal_linker.rb:29-43`.
**Status.** [V]
**Covered by.** untested for manual rows specifically.
**Oracle.** [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) `manual` → ATM top-up (`payment_method "cash_atm_topup"`) has `counterparty_kind "unknown"`.

<a id="br-347"></a>
### BR-347 Cash update semantics (keep vs clear, currency lock)
**Rule.** Fields and blank handling on update:
| Field | Blank/absent input means |
|---|---|
| amount | keep |
| direction | keep |
| payment_method | keep |
| booking_date | keep (also when unparseable) |
| transaction_date | **clear** (NULL) |
| title, note, counterparty_name | **clear** (stored as given, `""` or NULL) |
| merchant_id, category_id | **clear** (and `category_overridden = false`) |
| currency | not accepted (admin strips it; API has no param) — row keeps its wallet currency |
The API `PATCH /api/v1/cash_transactions/:id` passes only supplied params, so **omitted** title/note/counterparty_name/
transaction_date/merchant/category are cleared (see U-403). Admin success → redirect with `"Updated <expense|income> <amount>."`;
failure → 422 with alert or `"Could not update the transaction."`.
**Evidence.** `app/services/cash/transaction_updater.rb:4-12,53-92`; `app/controllers/admin/cash_transactions_controller.rb:69-82`;
`lib/api/resources/cash_transactions.rb:80-103`.
**Status.** [V] (specs); API omission clearing [I].
**Covered by.** `spec/services/cash/transaction_updater_spec.rb:33` blank title/counterparty clear, blank direction/booking_date keep; `:49` currency lock; `spec/requests/cash_spec.rb:188` drops :currency; `:210` 422 re-render; `spec/requests/api/v1/transactions_spec.rb:134` updates via TransactionUpdater.
**Oracle.** [../oracle/http/PATCH_api__version_cash_transactions__id.json](../oracle/http/PATCH_api__version_cash_transactions__id.json) `default` (`amount "30"`) → `amount.cents 3000`; `invalid_direction` → 400 `["direction does not have a valid value"]`; [../oracle/http/PATCH_admin_cash_transactions__id.json](../oracle/http/PATCH_admin_cash_transactions__id.json) → 302.

<a id="br-348"></a>
### BR-348 Which cash rows are editable
**Rule.** Lookup is always scoped to wallets owned by the current user (else 404). Only `source = "manual"` rows can be
edited/updated/deleted: admin → redirect to the index with alert `"This transaction was auto-generated and isn't editable here."`;
API PATCH/DELETE → 422 `{"message":"This transaction was auto-generated and isn't editable here."}`. Admin `show` always
redirects to `edit`. Admin `edit` of a row in a hidden category → redirect with alert
`"This transaction is in a hidden category. Remove it from the hidden list in preferences to edit it."` (update/delete
do not check this). Delete → `"Transaction deleted."` (admin) / 204 empty (API).
**Evidence.** `app/controllers/admin/cash_transactions_controller.rb:7-8,28-30,58-67,84-99`; `lib/api/resources/cash_transactions.rb:61-110`.
**Status.** [V]
**Covered by.** `spec/requests/cash_spec.rb:81` show → edit; `:163` editable row; `:173` ATM-link edit alert; `:225` PATCH non-manual; `:243` delete; `:255` delete non-manual keeps row; `spec/requests/api/v1/transactions_spec.rb:147` 422 for ATM-link; `:161` 204; `:114`, `:123` 404s.
**Oracle.** [../oracle/http/GET_admin_cash_transactions__id_edit.json](../oracle/http/GET_admin_cash_transactions__id_edit.json) (row 1 is an ATM link) → 302; [../oracle/http/GET_admin_cash_transactions__id.json](../oracle/http/GET_admin_cash_transactions__id.json) `other_tenant_id` → 404; [../oracle/http/DELETE_api__version_cash_transactions__id.json](../oracle/http/DELETE_api__version_cash_transactions__id.json) → 204 / other tenant 404.

<a id="br-349"></a>
### BR-349 ATM withdrawal ↔ cash wallet linking
**Rule.** For a bank transaction T, create a cash top-up iff all hold:
1. `T.payment_method = "blik_atm"` and `T.direction = "debit"` (BLIK ATM credits/refunds are never linked);
2. no manual row exists with `linked_bank_transaction_id = T.id`;
3. T's owner has `track_cash = true`.
There is **no fuzzy matching window**: pairing is 1:1 by identity of T (no amount/date matching against existing manual
rows). T's status is not checked (a pending ATM debit is linked too, see U-410). Created row (in the wallet for
`T.currency`, created if missing): `amount_cents = T.amount_cents`, `currency = T.currency`, `direction = "credit"`,
`status = "booked"`, `booking_date = T.booking_date`, `transaction_date = T.transaction_date`,
`title = "ATM withdrawal (<label>)"` where label = current bank connection's bank name, else the TPP credential name,
else `"Bank"`; `counterparty_name = T.counterparty_name`; `payment_method = "cash_atm_topup"`; `source = "atm_link"`;
`linked_bank_transaction_id = T.id`; plus an enrichment `source = "system_fallback"` with category = user's category
with slug `cash_atm_topup` — which does not exist in the seeded taxonomy, so the category is NULL until the next
enrichment rebuild assigns `money.transfers.atm` (see U-400). Concurrent duplicate → unique violation swallowed, returns
"nothing linked". The pair moves money between own accounts: the bank debit and the wallet credit are both kind
`transfer`, so neither is spend nor income.
**Evidence.** `app/services/cash/atm_withdrawal_linker.rb:4-74`; `app/services/seeders/categories.rb:146,175-180`;
`app/services/enrichment/transaction_enricher.rb:29,39,96-99`.
**Status.** [V]
**Covered by.** `spec/services/cash/atm_withdrawal_linker_spec.rb:14` creates linked credit, source atm_link, cash_atm_topup, matching cents/currency (its category assertion compares NULL with NULL); `:33` idempotent; `:44` ineligible method; `:54` credit not linkable; `:62` track_cash false; `:72` race swallowed; `spec/system/cash_with_atm_link_spec.rb:47` index lists the linked top-up.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) six rows "ATM withdrawal (PKO BP) … Atm link +200.00 PLN"; [../oracle/http/GET_api__version_cash_transactions.json](../oracle/http/GET_api__version_cash_transactions.json) → `linked_bank_transaction_id 36`, enrichment `system_fallback`, `category_id 101` (assigned later by the showcase rebuild).

<a id="br-350"></a>
### BR-350 When linking runs
**Rule.** Linking is attempted (each attempt idempotent per BR-349): (a) when `track_cash` is switched on (BR-340,
synchronous, all of the user's BLIK ATM debits); (b) after every transaction sync, after enrichment, if the subject
user has `track_cash` — scope: User subject → all their BLIK ATM debits; BankAccount → that account; BankConnection →
its current accounts; per-transaction failures are logged and skipped; if enrichment raised, linking is skipped for
that run; (c) rake `cash:backfill_atm_links` for every user with `track_cash = true` (prints per-user linked /
already-linked-or-noop counts).
**Evidence.** `app/jobs/transaction_sync_job.rb:55-90`; `lib/tasks/cash.rake:3-30`; `app/services/cash/tracking.rb:26-30`.
**Status.** [I] (sync path); [V] (enable path via specs).
**Covered by.** `spec/services/cash/tracking_spec.rb:6`.
**Oracle.** n/a.

<a id="br-351"></a>
### BR-351 Cash wallet balances (cash index)
**Rule.** Per wallet of the user (ordered by currency): `balance_cents = Σ amount_cents(credit) − Σ amount_cents(debit)`
over **all** manual rows of that wallet (all dates, booked and pending, every source). Shown in the wallet currency
(BR-361). Negative balance → warning "Negative balance - you've logged more expenses than top-ups. Likely missing a
cash income entry.". Not FX-converted, no cross-wallet total.
**Evidence.** `app/controllers/admin/cash_transactions_controller.rb:24-25,127-137`; `app/views/admin/cash_transactions/index.html.erb:22-43`.
**Status.** [V]
**Covered by.** untested (balances); `spec/system/cash_with_atm_link_spec.rb:16` updates the list after a 50 PLN expense.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) → "Cash wallet (PLN) zł1,125.00" (6 × 200.00 top-ups − 75.00 cash expenses) and "Cash wallet (EUR) €1.01".

<a id="br-352"></a>
### BR-352 Cash index filters and new-form defaults
**Rule.** Index scope = manual rows on the user's wallets; filters: `wallet_id` (exact), `direction`, `from`
(`booking_date ≥`), `to` (`booking_date ≤`), plus Ransack `q[...]` (BR-368); default sort `booking_date desc`;
paginated (BR-367). New form defaults: `direction = param or "debit"`, `currency` = currency of the user's oldest
wallet or `"PLN"`, `booking_date = today`, `payment_method = "cash"`. Currency options = `{"PLN"} ∪ wallet currencies ∪
synced account currencies`, upper-cased, unique, sorted. Merchant options: active merchants by name (max 500);
category options: active categories by position, name.
**Evidence.** `app/controllers/admin/cash_transactions_controller.rb:10-40,101-125`.
**Status.** [V]
**Covered by.** `spec/requests/cash_spec.rb:6` only own rows; `:20` wallet_id; `:35` direction; `:48` from/to; `:61` default debit/current date; `:71` `?direction=credit`.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) "Showing 1–10 of 13 results", dates descending; [../oracle/http/GET_admin_cash_transactions_new.json](../oracle/http/GET_admin_cash_transactions_new.json) `default` / `credit` → 200.

---

### Money, formatting, presentation

<a id="br-360"></a>
### BR-360 Money storage and default currency
**Rule.** Every money value is stored as `<name>_cents` (bigint, minor units) + ISO-4217 `currency` column (3 chars).
Default currency PLN (`MoneyRails default_currency = :pln`). Conversion from a decimal uses the currency's subunit
(`Money.from_amount`), so 0-decimal currencies would store whole units, but analytics charts always divide by 100
(BR-332, see U-415). No FX conversion anywhere.
**Evidence.** `config/initializers/money.rb:3-10`; `app/models/ledger_entry.rb:43-44`; `app/models/manual_transaction.rb:61`.
**Status.** [V]
**Covered by.** `spec/services/analytics/top_merchants_spec.rb:46` wraps amount_cents in Money.
**Oracle.** all API amounts are `{cents, currency}`, e.g. [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json).

<a id="br-361"></a>
### BR-361 Money display format
**Rule.** UI locale is `en`; money formatting uses Rails `en` number-currency settings: thousands separator `,`,
decimal mark `.`, symbol **before** the number with no space (`%u%n`), symbol from the currency (PLN `zł`, EUR `€`).
Variants used:
- default (`no_cents_if_whole = false` globally): `zł1,125.00`;
- analytics cards/charts (`no_cents_if_whole: true`): `zł6,500`, `zł22.89`;
- tables (`symbol: false`): number then the ISO code in a muted span: `220.00 PLN`;
- cash list signs: credit `+`, debit `−` (U+2212 MINUS SIGN), e.g. `+200.00 PLN`, `−20.00 PLN`;
- net/biggest figures prefix `+` when ≥ 0; negatives get the money library's `-` (e.g. `-zł100`) [I].
**Evidence.** `config/initializers/money.rb:7-9`; `bundle/.../money-7.0.2/lib/money/locale_backend/i18n.rb:8-25`;
`app/views/admin/cash_transactions/index.html.erb:35,198`; `app/views/admin/analytics/dashboard/index.html.erb:279,287,507,631`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) ("zł1,125.00", "€1.01", "+1.01 EUR", "−20.00 PLN"); [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) ("zł2,312.40", "zł19,500", "220.00 PLN").

<a id="br-362"></a>
### BR-362 Percentages
**Rule.** Integer percentages (spend change, savings rate, unmatched share, delta_pct, run-rate delta) use
round-half-away-from-zero of a floating-point ratio × 100; essentials shares use 1 decimal. Division by zero is avoided
by returning null/"-" (spend change, savings rate, delta_pct) or 0 (unmatched share, essentials).
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:74-88`; `app/services/analytics/spend_breakdown.rb:10-13`;
`app/services/analytics/facet_breakdown.rb:12-13`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** see BR-322, BR-324, BR-329.

<a id="br-363"></a>
### BR-363 Privacy mode and sensitive-value kinds
**Rule.** Privacy mode is a cookie preference `privacy_mode = "1"`; when on, `<html>` gets class `privacy-mode`
server-side (no flash of unredacted content). Values wrapped as sensitive get classes `sensitive sensitive--<kind>`;
kinds: `blur` (default) — characters replaced by `•` client-side, text-shadow shield until masked; `mask` — same
bullet replacement (fixed-format values); `redact` — solid block over the text; `strong` — CSS-only text blur (large
JSON/certificates). Unknown kind → `blur`. Blank values are not wrapped (placeholders like "-" stay visible). No hover
reveal (all-or-nothing). A `sensitive:` component prop accepts `true` / a kind symbol / `{kind:, extra:}`.
**Evidence.** `app/helpers/admin/privacy_helper.rb:3-47`; `app/helpers/admin/preference_toggle_helper.rb:10-12`;
`app/views/layouts/admin.html.erb:2`; `app/assets/tailwind/application.css:110-162`.
**Status.** [V] (oracle UI capture); helper unit behaviour [I].
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_privacy_mask_toggled.png](../oracle/ui/admin_privacy_mask_toggled.png).

<a id="br-364"></a>
### BR-364 Server-side hiding of private category values
**Rule.** `hide_private_text(value, category)` returns the value unchanged unless the category is hidden for the user
(BR-333); blank stays blank; with `mask:` returns that fixed mask (used for amounts so digit count does not leak);
else `•` repeated `min(len(value), 24)` times. The original value is never sent to the browser.
**Evidence.** `app/helpers/admin/hide_private_helper.rb:5-20`.
**Status.** [I]
**Covered by.** untested.
**Oracle.** n/a.

<a id="br-365"></a>
### BR-365 Sortable column headers
**Rule.** `sort_link(label, column)`: the active sort is the first Ransack sort. If this column is active and ascending,
the link sorts descending; otherwise ascending. Other `q[...]` params are preserved; `q[s] = "<column> <dir>"`. Icon:
inactive `arrow_up_down` (dimmed), active asc `arrow_up`, active desc `arrow_down`.
**Evidence.** `app/helpers/admin/base_helper.rb:83-97`.
**Status.** [I]
**Covered by.** untested.
**Oracle.** n/a.

<a id="br-366"></a>
### BR-366 Enrichment-source and payment-method labels
**Rule.** Source labels: `system_rule → Auto`, `user_rule → Rule`, `llm_rule → AI`, `llm_pending → Pending review`,
`manual → Manual`, `unmatched → Unmatched`, `system_fallback → Fallback`; unknown → humanized. Badge variants:
manual success, user_rule info, llm_pending warning, llm_rule default, others muted. Payment-method labels: `card → Card`,
`card_authorization → Card authorization`, `blik_pos → BLIK at POS`, `blik_p2p → BLIK to phone`, `blik_atm → BLIK at ATM`,
`transfer → Transfer`, `internal_transfer → Internal transfer`, `topup → Top-up`, `fee → Fee`, `other → Other`; unknown →
humanized; filter options start with `["All", ""]`. Category select labels: `"-"` × depth + breadcrumb names joined
by `" / "`. Cash list "Source" column shows the humanized source (`Manual`, `Atm link`). Sync age: never →
`"never"`; `<1h → "<m>m"`, `<24h → "<h>h"`, else `"<d>d"`; class muted ≤24h, warning ≤7d, else destructive.
**Evidence.** `app/helpers/admin/enrichment_helper.rb:4-66`; `app/helpers/admin/base_helper.rb:143-159`;
`app/views/admin/cash_transactions/index.html.erb:190-191`.
**Status.** [V] (labels visible in oracle UI)
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) ("Manual", "Atm link"); dashboard account chips "· 0m".

<a id="br-367"></a>
### BR-367 Pagination
**Rule.** Offset pagination (pagy 43): default page size **10**, client may request `limit` up to **100** (larger values
are capped at 100; `0`/invalid → 10); `page` < 1 → 1; pages beyond the last return an empty page (no error) [I].
API list responses carry `pagination: {page, limit, count, pages}` and headers `link` (RFC 8288), `current-page`,
`page-limit`, `total-count`, `total-pages` [I]. Same defaults on admin index pages.
**Evidence.** `config/initializers/pagy.rb:5-8`; `lib/api/helpers/pagy_helper.rb:8-21`;
`bundle/.../pagy-43.5.3/lib/pagy/classes/request.rb:28-36`; `.../toolbox/helpers/headers_hash.rb:7-29`.
**Status.** [V] (default 10, client limit honoured, meta shape); cap at 100 [I] (oracle dataset had only 66 rows).
**Covered by.** `spec/requests/api/v1/transactions_spec.rb:6` LedgerEntry entity shape.
**Oracle.** [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json) `default` → `{"page":1,"limit":10,"count":66,"pages":7}`; `filtered_paged` (`limit=2&page=2`) → `{"page":2,"limit":2,"count":57,"pages":29}`; `limit_above_max` (1000) → all 66 rows.

<a id="br-368"></a>
### BR-368 Ransack search configuration and bank-transaction filters
**Rule.** Ransack converts `"0"`/`"false"` to false for custom scopes. Searchable attributes (allow-lists):
BankTransaction `id external_id booking_date value_date transaction_date amount_cents currency direction status title
type_hint counterparty_name counterparty_iban counterparty_kind payment_method bank_transaction_code bank_account_id
created_at updated_at` (associations `bank_account enrichment`); ManualTransaction `id booking_date transaction_date
amount_cents currency direction status title counterparty_name counterparty_kind payment_method source bank_account_id
linked_bank_transaction_id created_at updated_at` (associations `bank_account enrichment linked_bank_transaction`);
TransactionEnrichment `id source merchant_id category_id`. Admin bank transactions index (user's synced transactions):
explicit filters `merchant_id`, `category_id` (matches the enrichment's **explicit** category only, not merchant
defaults — see U-414), `enrichment_source`, `payment_method`, `enrichment_state ∈ {merchantless, llm_ready, no_llm_signal}`
(other values ignored); then Ransack `q`, default sort `booking_date desc`, paginated. A transaction in a hidden
category cannot be opened: redirect with `"This transaction is in a hidden category. Remove it from the hidden list in preferences to open it."`.
**Evidence.** `config/initializers/ransack.rb:3-6`; `app/models/bank_transaction.rb:85-93`; `app/models/manual_transaction.rb:93-101`;
`app/models/transaction_enrichment.rb:78-84`; `app/controllers/admin/bank_transactions_controller.rb:6-23,26-38,49-67`;
`app/controllers/admin/base_controller.rb:14-20`.
**Status.** [V] (filters render); semantics [I].
**Covered by.** untested for filter semantics.
**Oracle.** [../oracle/http/GET_admin_bank_transactions.json](../oracle/http/GET_admin_bank_transactions.json) `filtered` (`enrichment_state=unclassified&payment_method=card&q[title_cont]=BIED`) → 200.

<a id="br-369"></a>
### BR-369 Ledger list API filters
**Rule.** `GET /api/v1/transactions` over the user's ledger rows (all statuses): `from` (`booking_date ≥`), `to`
(`≤`), `direction`, `status`, `account_id`, `merchant_id`, `category_id` (= `effective_category_id`, i.e. includes
merchant defaults), `category_path` (subtree), `payment_method`, `currency` (upper-cased), `source_type ∈
{BankTransaction, ManualTransaction}`; order `booking_date desc, source_id desc`; response `{data:[LedgerEntry], pagination}`.
`GET /api/v1/transactions/:source_type/:source_id` → one entry, 404 if not the user's. Entity `category_path` is `""`
when NULL.
**Evidence.** `lib/api/resources/transactions.rb:11-60`; `lib/api/entities/ledger_entry.rb:5-28`.
**Status.** [V]
**Covered by.** `spec/requests/api/v1/transactions_spec.rb:6` entity shape; `:28` from/to range; `:43` single entry; `:57` 404 for another user's.
**Oracle.** [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json); [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) `other_tenant_id` → 404, `invalid_source_type` → 400 `["source_type does not have a valid value"]`.

---

### Service catalogue (Part C)

<a id="svc-cash-atm-withdrawal-linker"></a>
#### app/services/cash/atm_withdrawal_linker.rb
- `Cash::AtmWithdrawalLinker.link!(bank_transaction)` — mirrors an eligible BLIK ATM debit as a booked credit top-up in the owner's cash wallet. Input: one BankTransaction. Output: the created ManualTransaction, or nil (ineligible, already linked, owner without track_cash, or concurrent duplicate). Implements BR-349 (and BR-346 gap, BR-303). [V]

<a id="svc-cash-tracking"></a>
#### app/services/cash/tracking.rb
- `Cash::Tracking.enable!(user:, currency: "PLN")` — ensures the wallet and backfills ATM links for all of the user's BLIK ATM debits. Input: user, currency (default PLN). Output: `Result{wallet, linked}` (count of newly linked rows). Implements BR-340, BR-350. [V]

<a id="svc-cash-transaction-creator"></a>
#### app/services/cash/transaction_creator.rb
- `Cash::TransactionCreator.call(user:, input:)` — normalises input (amount/currency/direction/payment method/dates), resolves the wallet, saves the ManualTransaction and its manual enrichment in one DB transaction. Input: `Input{amount, currency, direction, booking_date, transaction_date, title, note, counterparty_name, merchant_id, category_id, payment_method}`. Output: `Result{success?, transaction, enrichment, error_messages}` (`error` = messages joined by ", "). Implements BR-341, BR-342, BR-343, BR-344, BR-345, BR-346. [V]

<a id="svc-cash-transaction-updater"></a>
#### app/services/cash/transaction_updater.rb
- `Cash::TransactionUpdater.call(transaction:, input:)` — updates a manual row with keep-vs-clear semantics and rewrites its enrichment as manual; currency is locked to the wallet. Input: the row + `Input` (same fields as the creator minus currency). Output: `Result{success?, transaction, error_messages}`. Implements BR-342, BR-345, BR-346, BR-347. [V]

<a id="svc-cash-wallet-resolver"></a>
#### app/services/cash/wallet_resolver.rb
- `Cash::WalletResolver.call(user:, currency: "PLN")` — find-or-create the user's cash wallet for a currency (uid `cash_<user_id>_<ccy>`). Output: BankAccount (manual). Raises ArgumentError for missing user/currency. Implements BR-341. [V]

<a id="svc-analytics-account-breakdown"></a>
#### app/services/analytics/account_breakdown.rb
- `Analytics::AccountBreakdown.call(scope, user:, currency:)` — spend per owned account, descending. Output: rows `{account, amount_cents, count, currency}`. Implements BR-328, BR-306. [V]

<a id="svc-analytics-cash-flow"></a>
#### app/services/analytics/cash_flow.rb
- `Analytics::CashFlow.totals(scope)` / `.series(scope, period:, currency:)` — spend, income and net totals and the gap-filled per-bucket series. Output: `{spend_cents, income_cents, net_cents}` / list of points `{date, spend_cents, income_cents, net_cents, quiet?}`. Implements BR-320, BR-313, BR-303. [V]

<a id="svc-analytics-facet-breakdown"></a>
#### app/services/analytics/facet_breakdown.rb
- `Analytics::FacetBreakdown.essential(scope, currency:)` — essential vs discretionary split of spend. Output: `Pair{left: Essential row, right: Discretionary row, total, left/right share % (1 decimal)}`. Implements BR-329. [V]

<a id="svc-analytics-filter"></a>
#### app/services/analytics/filter.rb
- `Analytics::Filter.new(user:, params:)` — turns request params into the analytics scope: owned-account set (incl. `accounts=none`), single currency (explicit or dominant, fallback PLN), period (default month-to-date) and bucket (auto by length), `under_path`, previous-period scope/label, previous full month scope, and URL params. Output: `scope`, `previous_scope`, `previous_full_month_scope`, `period`, `currency`, `previous_label`, `to_query_params`, … Implements BR-304, BR-305, BR-306, BR-307, BR-311, BR-312, BR-314, BR-316. [V]

<a id="svc-analytics-period"></a>
#### app/services/analytics/period.rb
- `Analytics::Period.new(from:, to:, bucket:)` / `.last_n_days(n)` — inclusive date window with day/week/month buckets, length, previous same-length window, gap-fill and SQL `DATE_TRUNC` expression; rejects bad bucket or `from > to` with ArgumentError. Implements BR-310, BR-311, BR-313, BR-314. [V]

<a id="svc-analytics-spend-breakdown"></a>
#### app/services/analytics/spend_breakdown.rb
- `Analytics::SpendBreakdown.by_category / by_subpath / by_merchant_in_category / merchant_monthly_trend / total_cents` — category-path spend grouping (leaf or depth-truncated) with previous-period amounts and delta %, next-level subtree rows, merchants within a category subtree, and the 12-month merchant trend. Output: `Row{path, name, merchant, amount_cents, prev_amount_cents, count, currency, slug, delta_pct}` lists or `[{bucket, value}]`. Implements BR-325, BR-330, BR-331. [V]

<a id="svc-analytics-top-merchants"></a>
#### app/services/analytics/top_merchants.rb
- `Analytics::TopMerchants.call(scope, user:, currency:, limit: 8)` — top merchants by spend. Output: rows `{merchant, amount_cents, count, currency}`. Implements BR-327. [V]

<a id="svc-analytics-top-movers"></a>
#### app/services/analytics/top_movers.rb
- `Analytics::TopMovers.from_breakdown(breakdown, limit: 5, min_amount_cents: 5000, min_change_cents: 5000)` — biggest category swings vs the previous period, filtered for noise. Output: rows `{path, name, slug, current_cents, prev_cents, delta_cents, delta_pct, direction, new_spend?}`. Implements BR-326. [V]
