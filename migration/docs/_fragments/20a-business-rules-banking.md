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

### BR-001 First-run gate: everything redirects to `/setup` while no user exists
- **Rule:** Every request through the HTML application controller checks whether at least one `User` row exists. If none exists and the
  request path is neither `/setup` nor `/up` (the health check), the response is a redirect to `/setup`. Once any user exists, the
  check passes. This check runs on every request: there is no caching, and the ADR accepts the per-request query. The JSON API (Grape)
  and `/mcp` (`ActionController::API`) do not inherit this filter. [V]
- **Evidence:** `app/controllers/application_controller.rb:5-15`; `docs/adr/0011-first-run-setup.md:15-21,34-35`; `app/controllers/mcp_controller.rb:3`.
- **Status:** [V]
- **Covered by:** `spec/system/first_run_setup_spec.rb:16` (empty-DB visit to root goes to /setup); `spec/system/first_run_setup_spec.rb:97` (deep link to /admin/analytics on fresh DB goes to /setup).
- **Oracle:** `../oracle/capture_log_setup.txt` line 1: `302 GET /admin/analytics [anon/no_users_redirects_to_setup]`.

### BR-002 Setup page is only available while no user exists
- **Rule:** `GET /setup` and `POST /setup` first check whether any user exists. If one does, the request is redirected without changing
  anything: a signed-in visitor goes to `/admin` and a signed-out visitor goes to `/admin/sign_in`. This makes `POST /setup` idempotent
  on the server: a second submission, for example from a stale tab, never creates a second user. If no user exists, `GET` renders the
  form ("Create your admin account") in the `admin_auth` layout. [V]
- **Evidence:** `app/controllers/setup_controller.rb:6-14,33-35`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:6`, `:14`, `:21`, `:67`, `:81`; `spec/system/first_run_setup_spec.rb:42`, `:50`; `spec/system/smoke/auth_spec.rb:30`, `:37`.
- **Oracle:** [oracle](../oracle/http/GET_setup.json) case `no_users` → 200, case `users_exist` → 302 `/admin/sign_in`; [oracle](../oracle/http/POST_setup.json) case `users_exist` → 302 `/admin/sign_in`.

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

### BR-005 No public registration; further users are created out-of-band
- **Rule:** Devise is mounted under the `/admin` path prefix with registrations skipped, so no sign-up route exists. The first user comes
  from `/setup` (BR-003). Every later user, such as a partner, is created from the Rails console. The data model stays multi-tenant
  (BR-013).
- **Evidence:** `config/routes.rb:4-10`; `docs/adr/0011-first-run-setup.md:19,29-30`.
- **Status:** [I]
- **Covered by:** untested (absence of route).

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

### BR-008 Sign-out
- **Rule:** Sign-out only accepts `DELETE /admin/sign_out`. It destroys the session and expires **all** remember-me tokens of the user
  (`expire_all_remember_me_on_sign_out = true`). Protected pages then redirect to the sign-in page. Devise's flash is "Signed out
  successfully.".
- **Evidence:** `config/initializers/devise.rb:173,272`; `config/locales/devise.en.yml:50-51`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:208`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_sign_out.json) case `signed_in` → 204, case `not_signed_in` → 401. These responses were for a non-browser request format. Browser clients get a redirect, per the spec above.

### BR-009 Remember-me
- **Rule:** The rememberable module is on with Devise defaults: the cookie lasts 2 weeks (`remember_for` is commented out, so the
  default applies). A password change rotates the remember token. The in-app password change re-signs the user in (BR-024).
- **Evidence:** `app/models/user.rb:23`; `config/initializers/devise.rb:170`; `app/controllers/admin/settings/preferences_controller.rb:21-23`.
- **Status:** [I]
- **Covered by:** untested.

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

### BR-012 Authentication requirement for the admin UI and the bank callback
- **Rule:** Every `/admin/**` controller (`Admin::BaseController`), the bank callback `/callback` and the Sidekiq web UI (`/sidekiq`)
  require a signed-in session. Anonymous requests are redirected to `/admin/sign_in`. Devise's message is "You need to sign in or sign
  up before continuing.". Because Devise stores the requested GET location, a bank callback that arrives without a session continues
  after sign-in, provided the state token has not expired (BR-068). [I]
- **Evidence:** `app/controllers/admin/base_controller.rb:10`; `app/controllers/oauth_callbacks_controller.rb:7`; `config/routes.rb:12-14`; `config/locales/devise.en.yml:17`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:518`; `spec/requests/public_spec.rb:96`; `spec/system/smoke/auth_spec.rb:12`, `:18`, `:24`; `spec/system/oauth_callback_error_spec.rb:105`.
- **Oracle:** [oracle](../oracle/http/GET_callback.json) case `anonymous_no_params` → 302 `/admin/sign_in`.

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

### BR-014 Cross-tenant access yields "not found"
- **Rule:** In the admin UI, requesting another tenant's credential, connection, account, transaction, sync run or schedule raises
  record-not-found, which is HTTP 404. The JSON API returns 404 with its standard envelope. MCP tools return a tool error such as
  `Error: Transaction not found.` with `isError: true`. In no case is the foreign record modified.
- **Evidence:** the scoped finders listed in BR-013.
- **Status:** [V]
- **Covered by:** `spec/support/shared_examples/cross_user_isolation.rb:11`, `:23`; `spec/system/cross_user_isolation_spec.rb:28`, `:38`, `:48`, `:58`, `:83`; `spec/requests/banking_spec.rb:317`, `:379`, `:404`, `:469`; `spec/requests/api/v1/banking_spec.rb:48`, `:98`, `:241`; `spec/requests/mcp/protocol_spec.rb:101`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_bank_connections__id.json) case `other_tenant_id` → 404; [oracle](../oracle/http/POST_mcp.json) case `tools_call:transactions.get:other_tenant` → `Error: Transaction not found.`.

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

### BR-016 Personal access token (PAT) format
- **Rule:** Raw token = `"obrl_"` + URL-safe Base64 (no padding) of 32 cryptographically random bytes. That is 5 + 43 = **48
  characters** (body alphabet `A-Z a-z 0-9 - _`). The token never expires and has no scopes: it grants the owner's full API and MCP
  access.
- **Evidence:** `app/models/personal_access_token.rb:28-29`; `app/services/auth/personal_access_token_issuer.rb:25`.
- **Status:** [V]
- **Covered by:** `spec/services/auth/personal_access_token_issuer_spec.rb:30`.

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

### BR-020 PAT revoke vs delete (two-step removal)
- **Rule:** `DELETE /admin/settings/preferences/api_tokens/:id` (scoped to the current user) has two outcomes:
  - Active token: sets `revoked_at = now`, keeps the row, notice **"Token \"<name>\" revoked."**.
  - Already-revoked token: hard-deletes the row, notice **"Token \"<name>\" deleted."**.
  
  A revoked token fails authentication immediately (BR-019).
- **Evidence:** `app/controllers/admin/settings/api_tokens_controller.rb:32-44`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:384`, `:399`; `spec/models/personal_access_token_spec.rb:107`.
- **Oracle:** [oracle](../oracle/http/DELETE_admin_settings_preferences_api_tokens__id.json) cases `first_delete_revokes`, `second_delete_destroys_revoked` → 302.

### BR-021 PAT listing order
- **Rule:** The token list is ordered by `revoked_at DESC, created_at DESC`. In PostgreSQL, NULLs sort first under `DESC`, so all active
  tokens come first (newest first), followed by revoked tokens (most recently revoked first). The list shows `last_four`, never the
  digest.
- **Evidence:** `app/controllers/admin/settings/api_tokens_controller.rb:7`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:308`, `:299`.

### BR-022 PAT lifetime
- **Rule:** Tokens have no expiry date. Deleting a user deletes all of their tokens.
- **Evidence:** `app/models/personal_access_token.rb:5-25`; `app/models/user.rb:43`.
- **Status:** [V]
- **Covered by:** `spec/models/personal_access_token_spec.rb:120`.

### BR-023 Profile preference
- **Rule:** `PATCH /admin/settings/preferences/profile` accepts only `user[name]`. On success: redirect to the profile page with notice
  **"Profile saved."**. On failure (e.g. a blank name): re-render with 422 and alert = joined full messages.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:10-17,100-102`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:6`, `:15`, `:26`.

### BR-024 Password change from preferences
- **Rule:** `PATCH /admin/settings/preferences/password` takes `current_password`, `password` and `password_confirmation`. The change is
  applied only when `current_password` is correct (Devise `update_with_password`). On success the session is rebound with
  `bypass_sign_in`, so the user stays signed in, and the notice is **"Password changed."**. On failure: re-render the profile page with
  422 and alert = joined full messages. The user stays signed in.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:19-29,104-106`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:36`, `:54`.

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

### BR-026 Hidden-category semantics
- **Rule:** Hiding a category hides its whole subtree: every category of the user whose `path` is a descendant of (or equal to) a hidden
  category's path. When `reveal_hidden_categories` is true, nothing is hidden. A blank category id is never hidden.
- **Evidence:** `app/models/user.rb:47-66`.
- **Status:** [V]
- **Covered by:** `spec/models/user_spec.rb:27`, `:43`.

### BR-027 "Own identity" sets used for self-transfer detection
- **Rule:** Two normalised sets are derived from all accounts the user owns (synced accounts plus cash wallets):
  - `own_ibans`: primary IBANs plus every `all_account_ids` entry with `scheme_name == "IBAN"` that differs from the primary. All
    whitespace is removed, values are upper-cased, blanks and duplicates dropped.
  - `own_holder_names`: account `name` values, stripped, upper-cased, blanks and duplicates dropped.
  
  These sets drive BR-106.
- **Evidence:** `app/models/user.rb:74-94`; `app/models/bank_account.rb:101-107`.
- **Status:** [V]
- **Covered by:** `spec/models/user_spec.rb:51`, `:65`, `:78`; `spec/models/bank_account_spec.rb:117`.

### BR-028 LLM preference form (cross-reference)
- **Rule:** `PATCH /admin/settings/preferences/llm` saves `provider`, `api_key` and `model`. A blank `api_key` on an existing setting
  keeps the stored key. Notice "LLM settings saved."; failures re-render with 422. `POST …/llm/test` requires a configured setting,
  otherwise it shows alert **"Save a provider and API key first."**. On success the notice is "Connection OK - <provider label>
  (<effective model>)."; on failure the alert is "Test failed: <message>". The provider and client behaviour belong to the LLM part.
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:49-83,116-118`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:127`, `:136`, `:149`, `:164`, `:176`, `:186`, `:200`.

---

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

### BR-051 First credential becomes primary automatically
- **Rule:** On `POST /admin/tpp_credentials`, if the user had no credentials before, the new credential is saved with `primary = true`.
  Later credentials are not primary. Success redirects to the credential page with notice **"TPP credential created. Run \"Test
  connection\" to verify it works."**.
- **Evidence:** `app/controllers/admin/tpp_credentials_controller.rb:18-29`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:35`, `:55`.

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

### BR-063 Configuration errors become operation failures
- **Rule:** Every banking operation (start auth, create connection, refresh, sync, close, verify) converts a configuration or key error
  raised during the call into that operation's own failure, with message `"Configuration error: <message>"`. The controllers rescue
  these failures. HTTP non-2xx responses are handled per operation as described in each rule.
- **Evidence:** `app/services/enable_banking/operations/base.rb:5-16`; `app/services/enable_banking/error.rb:3-7`; `docs/adr/0013-enable-banking-adapter-shape.md:27-29`.
- **Status:** [V] (via verify: `spec/services/enable_banking/operations/verify_credential_spec.rb:60`); [I] for the other operations.
- **Covered by:** `spec/services/enable_banking/operations/verify_credential_spec.rb:60`.

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

### BR-070 Callback success message
- **Rule:** After a successful connection creation, the user is redirected to `/admin/bank_connections/<new id>` with notice
  **"Bank connected - <bank_name>, <N> account(s)."**. `N` is the number of accounts whose current connection is the new one.
- **Evidence:** `app/controllers/oauth_callbacks_controller.rb:26-27`.
- **Status:** [V]
- **Covered by:** `spec/requests/public_spec.rb:150` (notice matches /PKO BP/); `spec/system/oauth_callback_success_spec.rb:16`; `spec/system/first_time_setup_spec.rb:55`.

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

### BR-078 Own-account merchant rules refreshed after account changes
- **Rule:** After saving each account (on connection creation and on details refresh, BR-091), the own-account merchant syncer runs for
  that account. It maintains rules that classify transfers to the user's own IBANs; details are in the enrichment part.
- **Evidence:** `app/services/enable_banking/operations/create_connection.rb:75`; `app/services/enable_banking/operations/refresh_account_details.rb:37-39`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/refresh_account_details_spec.rb:41`.

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

### BR-093 Account display helpers
- **Rule:**
  - `display_name` = first non-blank of `name`, `product`, `details`, `iban`, `uid`.
  - `bic` = `account_servicer.bic_fi`.
  - `owner` = the manual owner for wallets, else the credential's user.
- **Evidence:** `app/models/bank_account.rb:87-111`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_account_spec.rb:92`, `:106`.

---

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

### BR-101 Transaction pagination
- **Rule:** `GET /accounts/<uid>/transactions` is called with `date_from` and `date_to`, and with `continuation_key` on follow-up
  pages. Pages are concatenated in order until `continuation_key` is null or empty, or **100 pages** have been fetched. If the cap is
  reached while a key remains, `truncated = true` (rows beyond the cap are not fetched in this run). If any page fails, the whole call
  returns that failure and nothing from earlier pages is used. The result carries `transactions`, `pages_fetched` and `truncated`.
- **Evidence:** `app/services/enable_banking/api/get_account_transactions.rb:5-66`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/api/get_account_transactions_spec.rb:6`, `:25`, `:43`, `:60`.

### BR-102 No transaction-status filter is sent
- **Rule:** The sync never sends `transaction_status`. Most banks then return booked transactions only; PKO rejects `PDNG` with 400.
  Pending rows are stored only when the bank returns them anyway.
- **Evidence:** `app/services/enable_banking/api/get_account_transactions.rb:9-10`; `app/services/enable_banking/operations/sync_account_transactions.rb:30-35`.
- **Status:** [I]
- **Covered by:** untested.

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

### BR-107 Consent probe when a transaction fetch is rejected
- **Rule:** If the transactions call fails with HTTP 401, 403 or 410 and the account has a current connection, BR-086 runs once for
  that connection. It may set the connection to `expired` (or another mapped status) and record `last_error`. Any failure of that probe
  is swallowed. The account sync then fails with the **original** `<error_message>`. Other failure statuses do not trigger the probe.
- **Evidence:** `app/services/enable_banking/operations/sync_account_transactions.rb:24,36-39,98-112`.
- **Status:** [V]
- **Covered by:** `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:110`, `:140`, `:156`.

### BR-108 Connection-level sync and per-account isolation
- **Rule:** A connection sync processes the connection's current accounts with `status = "active"`, in ascending id order. Each
  account's sync failure is captured as a failed outcome so the next account still runs, and a progress callback fires after every
  account. Afterwards the connection gets `last_synced_at = now`, even when every account failed. The connection's own status is not
  checked: a connection chosen as the subject syncs whatever its status is.
- **Evidence:** `app/services/enable_banking/operations/sync_connection_transactions.rb:5-41`; `docs/adr/0013-enable-banking-adapter-shape.md:36-38`.
- **Status:** [V]
- **Covered by:** `spec/system/manual_sync_flow_spec.rb:16`, `:71`.

### BR-109 User-level sync covers authorized connections only
- **Rule:** A sync whose subject is the user runs BR-108 for every connection of the user with `status = "authorized"`, in ascending id
  order. Accounts attached to closed, expired, replaced or other non-authorized connections are skipped.
- **Evidence:** `app/services/enable_banking/operations/sync_user_transactions.rb:15-26`; `app/models/bank_connection.rb:74`.
- **Status:** [V] via the oracle (run 9 covered both of user 1's authorized connections).
- **Covered by:** `spec/system/first_time_setup_spec.rb:55`.
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` run 9 (`subject_type` `User`, accounts from `PKO BP` and `Revolut LT`).

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

### BR-111 Sign convention for bank transactions
- **Rule:** `amount_cents` is always ≥ 0. Signed amount = `+amount` for `credit` and `−amount` for `debit`. All downstream totals must
  use the signed amount.
- **Evidence:** `app/models/bank_transaction.rb:102-104`; `app/services/enable_banking/transaction_normalizer.rb:100-107`.
- **Status:** [V]
- **Covered by:** `spec/models/bank_transaction_spec.rb:45`; `spec/services/enable_banking/transaction_normalizer_spec.rb:143`.

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

### BR-117 Per-account summary entry
- **Rule:** Each entry has `bank_account_id`, `iban` and `bank` (the current connection's `bank_name`), plus:
  - on success: `status: "succeeded"`, `inserted`, `updated`, `skipped`, `pages_fetched`, `truncated`, `date_from`, `date_to` (ISO
    dates);
  - on failure: `status: "failed"`, `error: <message>`.
- **Evidence:** `app/jobs/transaction_sync_job.rb:124-148`.
- **Status:** [V]
- **Covered by:** `spec/system/manual_sync_flow_spec.rb:16`, `:71` (`error` includes "Bank under maintenance").
- **Oracle:** `../oracle/operation_runs_after_capture.jsonl` run 5 summary, e.g. `{"bank":"PKO BP","iban":"PL61109010140000071219812874","status":"succeeded","date_to":"2026-10-21","skipped":0,"updated":0,"inserted":0,"date_from":"2026-10-14","truncated":false,"pages_fetched":1,"bank_account_id":1}`.

### BR-118 Post-sync enrichment and ATM linking
- **Rule:** After finalisation, the transactions in the run's scope that have no enrichment yet (the account, the connection's current
  accounts, or all of the user's transactions) are passed to the transaction enricher. Then, if the owner has `track_cash = true`,
  every debit with `payment_method = "blik_atm"` in the same scope is linked to the cash wallet; each link failure is logged and
  skipped. Any enrichment failure is logged and never changes the run's status.
- **Evidence:** `app/jobs/transaction_sync_job.rb:48-98`.
- **Status:** [I]
- **Covered by:** untested at job level. The enrichment itself is covered in the enrichment part; `spec/system/manual_sync_flow_spec.rb:16` runs the job end to end.

### BR-119 Job retry policy
- **Rule:** Sidekiq retries the sync job at most 3 times and never moves it to the dead set. Because the run is marked failed before
  the error is re-raised, a retry finds a terminal run and exits immediately. Retries therefore never re-sync, but they do notify the
  circuit breaker again (U-206).
- **Evidence:** `app/jobs/transaction_sync_job.rb:6-10,16,31-35`.
- **Status:** [I]
- **Covered by:** untested.

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

### BR-126 Due schedules
- **Rule:** A schedule is due when `enabled = true` AND (`next_run_at` IS NULL OR `next_run_at <= now`) AND (`paused_until` IS NULL OR
  `paused_until <= now`).
- **Evidence:** `app/models/sync_schedule.rb:45-51`.
- **Status:** [V]
- **Covered by:** `spec/models/sync_schedule_spec.rb:31`, `:47`, `:63`; `spec/services/auto_sync/dispatcher_spec.rb:71`.

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

### BR-128 Idempotency of scheduled runs
- **Rule:** A partial unique index on operation runs covers `(subject_type, subject_id, kind, scheduled_for)` where
  `scheduled_for IS NOT NULL`. Two dispatcher ticks racing for the same slot can therefore create only one run. Manual runs have a
  NULL `scheduled_for` and are unconstrained.
- **Evidence:** `app/models/operation_run.rb:31`; `app/services/auto_sync/dispatcher.rb:4-6,81-82`.
- **Status:** [V]
- **Covered by:** `spec/models/operation_run_spec.rb:111`, `:124`; `spec/services/auto_sync/dispatcher_spec.rb:55`.

### BR-129 Back-off for unauthorized connections
- **Rule:** When a due schedule's connection is not authorized, the schedule is paused for **6 hours**. This is not a circuit-breaker
  trip. After the pause the schedule is examined again. Re-authorizing creates a new connection; the old schedule is not transferred
  (U-204).
- **Evidence:** `app/services/auto_sync/dispatcher.rb:8-10,49-54`.
- **Status:** [V]
- **Covered by:** `spec/services/auto_sync/dispatcher_spec.rb:27`.

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

### BR-131 Time zone used for schedules
- **Rule:** The code asks the user for a time zone if the user exposes one. The user model has **no time-zone attribute**, so every
  schedule is computed in **UTC** and `preferred_hour = 8` means 08:00 UTC (U-202).
- **Evidence:** `app/services/auto_sync/dispatcher.rb:94-96`; `app/services/auto_sync/schedule_upserter.rb:86-88`; `app/models/user.rb:5-15`.
- **Status:** [I]
- **Covered by:** `spec/services/auto_sync/next_run_calculator_spec.rb:67` (zone honoured when supplied).

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

### BR-134 Manual syncs bypass the breaker
- **Rule:** A paused schedule never blocks a manual sync, and manual runs never change the breaker state.
- **Evidence:** `app/services/auto_sync/circuit_breaker.rb:16`; `app/services/transaction_syncs/queuer.rb:26-37`.
- **Status:** [V]
- **Covered by:** `spec/system/auto_sync_circuit_breaker_spec.rb:83`; `spec/services/auto_sync/circuit_breaker_spec.rb:6`.

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

### BR-142 Live progress broadcast
- **Rule:** After every committed update of a run of kind `transaction_sync` or `llm_enrichment`, an asynchronous Turbo Stream
  "replace" is broadcast on stream `operation_run_<id>`. It targets the DOM id `progress_operation_run_<id>` and renders partial
  `admin/<kind plural>/_run_progress`. Other kinds do not broadcast.
- **Evidence:** `app/models/operation_run.rb:63-67,140-147`.
- **Status:** [V]
- **Covered by:** `spec/models/operation_run_spec.rb:166`.

### BR-143 Visibility of sync runs
- **Rule:** The sync list and detail pages show only runs with `kind = transaction_sync` and `triggered_by_user_id = current user`,
  newest first. A scheduled run is visible to the connection owner because the dispatcher records the owner as `triggered_by_user`.
  The list also shows the user's authorized connections with their schedules, ordered by bank name.
- **Evidence:** `app/controllers/admin/transaction_syncs_controller.rb:4-19,45-51`.
- **Status:** [V]
- **Covered by:** `spec/requests/banking_spec.rb:390`, `:404`, `:415`; `spec/requests/api/v1/banking_spec.rb:212`.

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

### BR-156 Import outcome reporting
- **Rule:** On success the run succeeds with summary `{"strategy", "bundle": {id, source_env, exported_at, counts}, "result":
  {imported, updated, skipped, failed, warnings, per_resource: {key: {imported, updated, skipped, failed}}}}`. The UI notice is
  **"Import done - <imported> imported, <updated> updated, <skipped> skipped."**. On failure after the run exists, the run fails with
  the message and the partial counts, and the UI shows the alert. `failed` is always 0 and `warnings` is always empty in the current
  code (U-213).
- **Evidence:** `app/services/data_exchange/operations/import.rb:28-41,124-141`; `app/services/data_exchange/result.rb:4-24`; `app/controllers/admin/settings/data_exchange_controller.rb:43-45`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:260`; `spec/services/data_exchange/round_trip_spec.rb:41`.

### BR-157 Source fingerprint
- **Rule:** `source_fingerprint` is the first 16 hex characters of `HMAC-SHA256(key = ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY, message =
  "data-exchange-fingerprint-v1")`, or null when the key is unset. It is informational only, a hint that the bundle comes from this
  instance, and is never used for verification.
- **Evidence:** `app/services/data_exchange/operations/export.rb:94-101`.
- **Status:** [I]
- **Covered by:** untested.

---

### BR-170 Rake `banking:backfill_counterparty_kind`
- **Rule:** For every user, the task recomputes BR-106 for each of the user's bank and manual transactions. When the value changes it
  writes only the `counterparty_kind` column (no callbacks or audit). It prints `  user=<email>` per user and then totals:
  `users processed`, `bank rows updated`, `manual rows updated`.
- **Evidence:** `lib/tasks/banking.rake:4-34`.
- **Status:** [I]
- **Covered by:** untested.

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

### BR-172 Rake `banking:diagnose_duplicate_accounts`
- **Rule:** The task groups synced accounts with a non-blank IBAN by `(tpp_credential_id, iban, currency)` and lists the groups with
  more than one row. For each group it prints the owner e-mail, the credential, and per account: id, the first 8 characters of the uid,
  the connection (bank, status, id), bank and manual transaction counts, and the creation date. It ends with merge instructions, or
  prints "No duplicates found.". Read-only.
- **Evidence:** `lib/tasks/duplicate_bank_accounts.rake:13-41`.
- **Status:** [I]
- **Covered by:** untested.

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

### BR-176 Rake `cash:backfill_atm_links`
- **Rule:** For each user with `track_cash = true`, the task tries to link every debit with `payment_method = blik_atm` to the cash
  wallet. It counts new links versus no-ops, prints per-user and total counts, and prints a reconciliation reminder when anything was
  linked.
- **Evidence:** `lib/tasks/cash.rake:3-40`.
- **Status:** [I]
- **Covered by:** untested.

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
