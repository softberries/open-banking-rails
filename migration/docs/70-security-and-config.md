# 70 - Security model and configuration (ENV vars, initializers)


> **Decisions apply.** Where Phase-4 decisions change behaviour for Kotlin, the [deviation register](decisions.md#deviation-register--where-the-kotlin-expectation-differs-from-the-ruby-oracle) (X-01…X-27) overrides the Ruby behaviour described here; unknowns carry a **Resolution** line ([unknowns.md](unknowns.md)).

Source paths are relative to `/workspace/ruby-service-investigator/src` (commit `cd3bf605`); oracle links are relative to `docs/`.
**[V]** = observed in the oracle run or asserted by a passing spec (cited); **[I]** = inferred from code only.
Background jobs, mailers and outbound integrations are in `60-async-and-integrations.md`; endpoint-level auth behaviour per route is in `30-http-api.md`.

---

## 1. Authentication

### 1.1 Browser sessions (Devise)

| Item | Value | Evidence |
|---|---|---|
| Devise modules on `User` | `database_authenticatable`, `recoverable`, `rememberable`, `validatable`. **Not** enabled: `registerable` (route also skipped), `confirmable`, `lockable`, `timeoutable`, `trackable`, `omniauthable` | `app/models/user.rb:2`, `config/routes.rb:4-10` [I] |
| Routes | `GET/POST /admin/sign_in`, `DELETE /admin/sign_out`, `GET /admin/password/new`, `GET /admin/password/edit`, `POST/PATCH/PUT /admin/password`; controllers `Admin::SessionsController`, `Admin::PasswordsController` (Devise subclasses that only change the layout to `admin_auth`) | `config/routes.rb:4-10`, `app/controllers/admin/sessions_controller.rb:4-6`, `app/controllers/admin/passwords_controller.rb:4-6`; `inventory/routes.txt` [V] `spec/requests/public_spec.rb:185`, `:217` |
| Login key | `email`, case-insensitive and whitespace-stripped (stored lower-case) | `config/initializers/devise.rb:61`, `:66` [I] |
| Email format | `/\A[^@\s]+@[^@\s]+\z/`; unique (DB unique index) | `devise.rb:189`; `inventory/schema.rb:358` [I] |
| Password rules | length 6..128, no complexity rules; confirmation must match | `devise.rb:184` [V] `spec/system/first_run_setup_spec.rb:67`; [V] [oracle](../oracle/http/PATCH_admin_settings_preferences_password.json) case too_short -> 422 |
| Hashing | bcrypt, cost 12 (1 in test), no pepper | `devise.rb:126` [I] |
| Failed sign-in | re-renders the form with HTTP 422 (not a redirect); the password is not echoed [V] `spec/requests/public_spec.rb:201`, [oracle](../oracle/http/POST_admin_sign_in.json) case wrong_password -> 422. Flash text `"Invalid Email or password."` (Devise `not_found_in_database` / `invalid`, `config/locales/devise.en.yml:15`) [I] - not captured in the oracle sample | see cell |
| Successful sign-in | 303 redirect to the stored location or `/admin` (-> `/admin/analytics`) | `devise.rb:309` (`redirect_status = :see_other`) [V] `spec/requests/public_spec.rb:193`; oracle case valid_credentials -> 303 |
| Lockout / throttling | **none** (no `lockable`, no rate limiting, see section 8) | [I] (see U-808) |
| Session timeout | **none** (no `timeoutable`); the session lasts as long as the browser session cookie | [I] (see U-819) |
| Remember me | checkbox on the sign-in form; cookie valid 2 weeks (Devise default `remember_for`), not extended on use; all remember tokens are invalidated on sign-out (`expire_all_remember_me_on_sign_out = true`) | `app/views/admin/sessions/new.html.erb:22-25`, `devise.rb:170-176` [I] |
| Sign-out | `DELETE` only (`sign_out_via = :delete`), signs out all scopes | `devise.rb:272` [V] `spec/requests/public_spec.rb:208` |
| Session cookie | Rails cookie store, name `_open_banking_rails_session`, `path=/; httponly; samesite=lax`; no `Secure` flag in development; in production it is Secure only when `FORCE_SSL=true` (force_ssl marks cookies secure) | [V] cookie header in every oracle case, e.g. [oracle](../oracle/http/GET_sidekiq.json) case anonymous; production [I] |
| Password reset | token valid 6 hours; user signed in automatically after reset; email described in `60-async-and-integrations.md` 5.1. **Not paranoid**: unknown email -> 422 re-render, known email -> 303 to `/admin/sign_in` [V]; this allows account enumeration. Expected texts (Devise defaults, not captured): form error `"Email not found"`, notice `"You will receive an email with instructions on how to reset your password in a few minutes."` [I] | `devise.rb:93` (paranoid commented out), `:230`; `config/locales/devise.en.yml:35`, `:61` [V] [oracle](../oracle/http/POST_admin_password.json) cases unknown_email -> 422, known_email -> 303; `spec/requests/public_spec.rb:224` (see U-808) |
| Password change in-app | `PATCH /admin/settings/preferences/password` requires the current password | [V] [oracle](../oracle/http/PATCH_admin_settings_preferences_password.json) case wrong_current_password -> 422 |
| HTTP auth | Devise HTTP Basic is not enabled (`http_authenticatable` default false); `skip_session_storage = [:http_auth]` | `devise.rb:82`, `:100` [I] |

Unauthenticated access to any `Admin::*` controller (all inherit `Admin::BaseController`, `before_action :authenticate_user!`, `app/controllers/admin/base_controller.rb:10`)
redirects to `/admin/sign_in` [V] `spec/system/smoke/auth_spec.rb:12`, `:18`, `:24`. `/callback`, `/api/:version/docs` and `/sidekiq` also require a session
(`app/controllers/oauth_callbacks_controller.rb:7`, `app/controllers/swagger_controller.rb:3`, `config/routes.rb:12-14`) [V] [oracle](../oracle/http/GET_sidekiq.json) case anonymous -> 302 `/admin/sign_in`.

### 1.2 Personal Access Tokens (JSON API `/api/v1/*` and MCP `/mcp`)

| Item | Value | Evidence |
|---|---|---|
| Format | `obrl_` + URL-safe Base64 of 32 random bytes | `app/models/personal_access_token.rb:28-29`, `app/services/auth/personal_access_token_issuer.rb:25` [V] `spec/services/auth/personal_access_token_issuer_spec.rb:30` |
| Storage | only `token_digest = SHA-256 hex(raw)` (unique) and `last_four`; the raw token is shown once at creation | `personal_access_token.rb:37-38`, `:52-54`; issuer `:26-32` [V] `spec/models/personal_access_token_spec.rb:59`, `:65`; `spec/services/auth/personal_access_token_issuer_spec.rb:19` |
| Name | 1..50 chars, trimmed, unique per user case-insensitively | `personal_access_token.rb:30`, `:34-36` [V] `spec/models/personal_access_token_spec.rb:40`, `:49` |
| Expiry | none; revocation by setting `revoked_at` | `personal_access_token.rb:40-45` [V] `spec/models/personal_access_token_spec.rb:107` |
| Presentation | header `Authorization: Bearer <token>` (prefix case-insensitive); anything else fails | `lib/api/helpers/auth_helper.rb:17-21`, `app/controllers/mcp_controller.rb:19-26` [V] `spec/requests/mcp/protocol_spec.rb:6`, `:13` |
| Verification | must be a String starting with `obrl_`, digest lookup among active tokens; all failures look the same | `app/services/auth/personal_access_token_authenticator.rb:15-30` [V] `spec/services/auth/personal_access_token_authenticator_spec.rb:6`, `:17`, `:48` |
| Usage stamp | each successful request sets `last_used_at` (and `updated_at`) without callbacks or PaperTrail | `personal_access_token.rb:47-50` [V] `spec/services/auth/personal_access_token_authenticator_spec.rb:36`, `spec/models/personal_access_token_spec.rb:82`, `:98` |
| Failure response | Grape API: 401 `{"message":"Invalid or missing access token."}`; MCP: 401 `{"error":"Invalid or missing access token."}` (different key) | `lib/api/helpers/auth_helper.rb:13`, `app/controllers/mcp_controller.rb:23` [V] [oracle](../oracle/http/GET_api__version_merchants.json) cases no_token / invalid_token / revoked_token -> 401; [oracle](../oracle/http/POST_mcp.json) cases no_token / revoked_token -> 401 |
| Scope | a token acts as its user with full rights (no per-token scopes) | [I]; [V] `spec/system/personal_access_token_lifecycle_spec.rb:16`, `:123` |

Token management UI: `/admin/settings/preferences/api_tokens` (session auth) - see `30-http-api.md` [V] `spec/system/personal_access_token_lifecycle_spec.rb:16`, `:151`.

---

## 2. Authorisation and tenancy

- **One role.** There are no roles, permissions or admin flags; every authenticated user is the full administrator of their own data
  (`inventory/schema.rb:347-360` has no role column; `docs/adr/0011-first-run-setup.md` "single-user-shaped multi-tenant") [I].
- **Tenant = user.** Every per-tenant table hangs off `users` directly or through `tpp_credentials` / cash wallets (`app/models/user.rb:6-25`) [I].
- **Enforcement** is done in each controller / Grape resource / MCP tool by starting queries from the current user (`current_user.<assoc>`, `Model.for_user(user)`,
  `BankConnection.for_user(@user)`); there is no global default scope or policy layer (grep; e.g. `app/services/transaction_syncs/queuer.rb:46`) [I].
  Another tenant's record id gives 404 in the UI and API (19 of 24 oracle cases with actor `other(...)` or `other_tenant_*` -> 404) [V] (`oracle/index.json`, e.g.
  [oracle](../oracle/http/GET_admin_versions__id.json) for the exception below); MCP returns a tool-error envelope instead of data [V] `spec/requests/mcp/protocol_spec.rb:101`;
  cross-tenant PAT reads blocked [V] `spec/system/personal_access_token_lifecycle_spec.rb:123`.
- **Exceptions / leaks:**
  - `/admin/versions` and `/admin/versions/:id` read `PaperTrail::Version` without any user filter (`app/controllers/admin/versions_controller.rb:5-11`): any
    signed-in user sees every tenant's audit trail (BankAccount, ManualTransaction, TppCredential, BankConnection changes including IBANs, names, amounts; the encrypted
    `raw_balances` appears only as ciphertext `{"p":...,"h":{"iv":...,"at":...}}`) [V] [oracle](../oracle/http/GET_admin_versions.json) case other_tenant_sees_all_versions -> 200,
    [oracle](../oracle/http/GET_admin_versions__id.json) case other_tenant_reads_main_version -> 200; ciphertext in `oracle/server.log.txt:1719-1766`. (See U-811.)
  - `/sidekiq` (Sidekiq Web) is mounted behind `authenticate :user` only (`config/routes.rb:12-14`): any signed-in user of any tenant can see all queues, job arguments
    (run ids, FailingJob kwargs) and retry/delete/kill jobs [V] [oracle](../oracle/http/GET_sidekiq.json) case authenticated -> 200 (see U-810).
  - `POST /api/v1/transaction_syncs` with another tenant's `bank_connection_id` does not leak data but silently syncs the caller's own connections (run subject = user)
    [V] [oracle](../oracle/http/POST_api__version_transaction_syncs.json) case other_tenant_connection -> 201 (see U-806 in `60-async-and-integrations.md`).
  - `EnableBanking::Operations::CreateConnection#find_existing_account` looks up `BankAccount.find_by(uid:)` without restricting to the user/credential (known finding,
    documented in `20-business-rules.md`) [I].
- **Turbo stream subscriptions** use signed stream names; the ActionCable connection itself is unauthenticated (no `app/channels`) [I] (`60-async-and-integrations.md` 3.1).

---

## 3. First-run setup

(`docs/adr/0011-first-run-setup.md`; `app/controllers/application_controller.rb:5-15`; `app/controllers/setup_controller.rb`)

- While **no user exists**, every request through `ApplicationController` (all HTML controllers, Devise included) is redirected to `/setup`, except `/setup` itself and
  `/up` [V] `spec/system/first_run_setup_spec.rb:16`, `:97`; [V] `oracle/capture_log_setup.txt` (`302 GET /admin/analytics [anon/no_users_redirects_to_setup]`). The Grape API and `/mcp`
  are not affected (they do not inherit `ApplicationController`) [I].
- `GET /setup` renders the form (name, email, password, confirmation). Anyone who can reach the instance first becomes the owner: there is no setup token [I] (see U-817).
- `POST /setup` re-checks `User.exists?`; on success creates the user, runs `Seeders::Categories` and `Seeders::MerchantRules`, signs in, redirects to `/admin` with notice
  `"Welcome - your account is ready."`; invalid input -> 422 re-render [V] `spec/requests/public_spec.rb:29`, `:51`; `spec/system/first_run_setup_spec.rb:25`, `:67`, `:82`.
  There is no lock, so two simultaneous first POSTs with different emails could both create users [I] (U-817).
- Once a user exists, `/setup` redirects to `/admin` (signed in) or `/admin/sign_in`, and `POST /setup` creates nothing [V] `spec/requests/public_spec.rb:14`, `:21`, `:67`, `:81`;
  `spec/system/first_run_setup_spec.rb:50`. Further users can only be created from the Rails console (ADR 0011 "Consequences") [I].

---

## 4. Transport and browser protections

| Control | Behaviour | Evidence |
|---|---|---|
| CSRF | Enabled for `ActionController::Base` controllers in development and production (Rails 8.1 defaults, `config.load_defaults 8.1`); a missing token -> `ActionController::InvalidAuthenticityToken`, HTTP 422. Disabled in test (`allow_forgery_protection = false`). Not applicable to the Grape API (Rack app, token auth) or `/mcp` (`ActionController::API`). Devise rotates the CSRF token on sign-in (default) | `config/application.rb:33`, `config/environments/test.rb:29`, `app/controllers/mcp_controller.rb:3` [V] [oracle](../oracle/http/POST_admin_sign_in.json) case missing_csrf_token -> 422 |
| CORS | `Rack::Cors` first in the middleware stack: **all origins (`*`), all paths, any headers, methods GET POST PUT PATCH DELETE OPTIONS HEAD**; no credentials flag (browsers will not send cookies cross-origin with `*`). Applies to admin HTML paths too. Headers are added only when the request carries `Origin` (`Vary: Origin` on every response) | `config/initializers/cors.rb:1-6` [V] [oracle](../oracle/http/OPTIONS_api__version_merchants.json) case cors_preflight -> 200 `access-control-allow-origin: *`, `access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD`; see U-812 |
| CSP | **Not configured** for the application (initializer fully commented out); no `Content-Security-Policy` header on app pages. Only Sidekiq Web sends its own CSP | `config/initializers/content_security_policy.rb:7-29` [V] only [oracle](../oracle/http/GET_sidekiq.json) case authenticated carries `content-security-policy` among all captured responses; see U-813 |
| `allow_browser versions: :modern` | HTML controllers answer **406** with `public/406-unsupported-browser.html` ("Your browser is not supported (406 Not Acceptable)") to user agents older than the Rails "modern" baseline; runs before authentication; not applied to Grape/MCP | `app/controllers/application_controller.rb:2` [V] [oracle](../oracle/http/GET_admin_analytics.json) case legacy_browser_ua -> 406 |
| Default security headers | `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` (Rails defaults; Rails also sends `Referrer-Policy: strict-origin-when-cross-origin` and `X-Permitted-Cross-Domain-Policies: none` by default, not captured by the oracle) | [V] headers in e.g. [oracle](../oracle/http/GET_admin_versions.json); rest [I] |
| TLS | production: `assume_ssl` and `force_ssl` both = (`FORCE_SSL` default `"true"` == `"true"`); force_ssl means HTTP->HTTPS redirect, HSTS, secure cookies. **But the production compose defaults `FORCE_SSL=false` and `APP_PROTOCOL=http`** | `config/environments/production.rb:27-31`; `docker-compose.prod.yml:20`, `:22` [I] (see U-819) |
| Host authorization | production: `config.hosts` = comma-separated `APP_HOSTS`, falling back to `APP_HOST`; empty list = no check; `/up` always excluded | `config/environments/production.rb:95-103` [I] |
| Health check | `GET /up` (`rails/health#show`), not logged in production (`silence_healthcheck_path`), excluded from host check; used by the compose healthcheck (`curl -fsS http://127.0.0.1:3000/up`) | `config/routes.rb:21`, `production.rb:44`, `:103`, `docker-compose.prod.yml:98-103` [I] |
| Open redirect guard | `?return_to=` accepted only when it starts with `/admin/` or `/admin?` and contains no `//` | `app/controllers/admin/base_controller.rb:22-30` [I] |
| Error pages | production `consider_all_requests_local = false` (static `public/4xx/500.html`); development/test show full exception pages; Grape returns `"Internal server error."` in production and `"<Class>: <message>"` in dev/test | `production.rb:13`, `development.rb:22`, `lib/api/api.rb:33-41` [I] |

---

## 5. Logging and parameter filtering

- **Filtered parameters** (partial, case-insensitive match): `passw, passphrase, email, secret, token, _key, crypt, salt, certificate, otp, ssn, cvv, cvc` ->
  `[FILTERED]` in logs (`config/initializers/filter_parameter_logging.rb:6-8`) [V] (`oracle/server.log.txt:177`: `"user":{"email":"[FILTERED]"}`, `"authenticity_token":"[FILTERED]"`).
  Email addresses are therefore also hidden in request logs.
- **Lograge** is on in every environment: one JSON line per request with method, path, format, controller, action, status, allocations, duration, view, db, location (for redirects)
  and the filtered `params` (`config/initializers/lograge.rb:1-8`) [V] (`oracle/server.log.txt:177`, `:214`).
- Production logs to STDOUT tagged with `request_id`, level `RAILS_LOG_LEVEL` (default `info`); deprecations not reported; inspection of records limited to `id`
  (`config/environments/production.rb:37-47`, `:93`) [I]. Compose rotates container logs (json-file, 10 MB x 5) (`docker-compose.prod.yml:3-7`) [I].
- Sidekiq server logs in JSON (`config/initializers/sidekiq.rb:4`) [I].
- Development-only leakage: the full password-reset email with its token is logged (`oracle/server.log.txt:204-209`) [V]; SQL with literal values is logged (dev log level debug) [V].

---

## 6. Encryption at rest

(`docs/adr/0004-encryption-at-rest.md`; `config/initializers/active_record_encryption.rb`)

| Model.attribute | Mode | Notes | Evidence |
|---|---|---|---|
| `TppCredential.application_id`, `TppCredential.private_key_pem` | non-deterministic | used to sign Enable Banking JWTs; skipped by PaperTrail | `app/models/tpp_credential.rb:45`, `:57` |
| `BankConnection.session_id`, `.psu_id_hash`, `.raw_session_payload` | non-deterministic | skipped by PaperTrail | `app/models/bank_connection.rb:55`, `:61` |
| `BankAccount.raw_balances` | non-deterministic | **not** skipped by PaperTrail -> stored as ciphertext in `versions` | `app/models/bank_account.rb:64`, `:71` [V] `oracle/server.log.txt:1764-1766` |
| `BankTransaction.raw_payload` | non-deterministic | | `app/models/bank_transaction.rb:65` |
| `LlmSetting.api_key` | non-deterministic | | `app/models/llm_setting.rb:28` |
| `ActionText::EncryptedRichText.body` | framework model | table does not exist (framework default) | `inventory/models.json` |

- All app-level encryption is randomized (non-deterministic); no `deterministic: true` is used anywhere, so the deterministic key is configured but unused (`inventory/models.json`, grep) [I].
  Encrypted values are JSON envelopes `{"p": <base64 ciphertext>, "h": {"iv": ..., "at": ...}}` (AES-256-GCM) [V] (`oracle/server.log.txt` raw_balances insert).
- Keys come only from ENV (`ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY`, `..._DETERMINISTIC_KEY`, `..._KEY_DERIVATION_SALT`). If all three are present they are applied with
  `ActiveRecord::Encryption.configure`; in production, if any is missing and `SECRET_KEY_BASE_DUMMY` is blank, boot fails with
  `"ActiveRecord encryption keys missing - set ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY, ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY, ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT. The docker-entrypoint generates these on first boot when running under compose."`
  (`config/initializers/active_record_encryption.rb:15-32`) [I]. Dev/test without keys boot, but touching an encrypted attribute fails (the repo notes specs need the keys; `docs/pending-context-fabric.md`) [I].
- The data-export bundle stores `source_fingerprint` = first 16 hex chars of HMAC-SHA256(primary key, `"data-exchange-fingerprint-v1"`) as an informational hint only; import checks that a primary key is configured
  (`app/services/data_exchange/operations/export.rb:94-100`, `import.rb:144-146`) [I]. Bundles themselves are encrypted with AES-256-GCM, key from the user passphrase via PBKDF2-HMAC (200 000 iterations)
  (`app/services/data_exchange/bundle_cipher.rb:6`, `:19`, `:38-80`) [I] (details in `20-business-rules.md`).
- The Kotlin rebuild must decrypt existing Rails AR-encryption ciphertext (or migrate it), using the same three secrets (see U-818).

---

## 7. Secrets handling

- **No Rails encrypted credentials in production.** `config/credentials.yml.enc` exists but nothing reads it and no `RAILS_MASTER_KEY` is provided; all secrets come from ENV (ADR 0014; `config/initializers/active_record_encryption.rb:3-7`) [I].
- `bin/docker-entrypoint` (entrypoint of every production container: app, worker, migrate) for each of `SECRET_KEY_BASE`, `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY`,
  `ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY`, `ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT`: if the ENV variable is already set it wins; else if
  `$SECRETS_DIR/<file>` is missing or empty it writes `SecureRandom.hex(32)` (64 hex chars) with mode 600 and logs `[entrypoint] generated <file>`; then exports the file content.
  Files: `secret_key_base`, `ar_encryption_primary_key`, `ar_encryption_deterministic_key`, `ar_encryption_key_derivation_salt`. `SECRETS_DIR` default `/rails/secrets`, the `app_secrets` named volume
  shared by app, worker and migrate (`bin/docker-entrypoint:18-44`, `docker-compose.prod.yml:70-71`, `:88-90`, `:112-114`) [I].
- `SECRET_KEY_BASE` signs/encrypts the session cookie, the OAuth `state` tokens (`Rails.application.message_verifier("enable_banking:oauth_state")`), Turbo signed stream names, and is the Devise secret key
  (`config/initializers/devise.rb:15-17`, `app/services/enable_banking/state.rb:23`) [I]. Rotating it logs everyone out and invalidates in-flight bank auths and reset tokens [I].
- Development/test load `.env` through `dotenv-rails` (development/test group only, `Gemfile:55-56`) [I].
- The image build uses `SECRET_KEY_BASE_DUMMY=1` only for `assets:precompile` (`Dockerfile:55`) [I].
- Per-user secrets (TPP private keys, LLM API keys) are stored encrypted in the DB (section 6) and never logged; the connection test does not store the API key in the run [V] `spec/services/llm/connection_test_runner_spec.rb:162`.

---

## 8. Rate limiting and abuse protection

None. There is no `rack-attack` gem (`Gemfile`), no Rails 8 `rate_limit` call in any controller (grep), no Devise `lockable`, and no throttling of `/admin/sign_in`, `/admin/password`,
`/setup`, the API or `/mcp` [I] (see U-808). The only throttles are outbound: 2 s between LLM batches and OpenAI 429 back-off (`60-async-and-integrations.md` 4.4, 6.3).

---

## 9. Security tooling

- `bin/ci` (`config/ci.rb:3-16`) runs: setup, Tailwind build, `bin/rubocop`, `bin/bundler-audit`, `bin/importmap audit`,
  `bin/brakeman --quiet --no-pager --exit-on-warn --exit-on-error`, `bundle exec rspec` [I]. GitHub workflow `.github/workflows/ci.yml` runs lint, audits and the suite [I].
- `bin/brakeman` always passes `--ensure-latest` (`bin/brakeman:5`); there is no `config/brakeman.ignore` [I].
- `config/bundler-audit.yml:4-5` ignore list contains only the placeholder `CVE-THAT-DOES-NOT-APPLY` (no real exemptions); `bin/bundler-audit:5` adds `--config config/bundler-audit.yml` [I].

---

## 10. Error reporting

- `OpenTelemetryErrorSubscriber` is subscribed to `Rails.error`: for every reported error, if the current span is recording, it records the exception on the span and sets the span status to error
  with the message (`config/initializers/opentelemetry_error_subscriber.rb:3-13`) [I].
- Grape's catch-all does the same and logs `[API] <Class>: <message>` with the first 10 backtrace lines (`lib/api/api.rb:33-41`) [I].
- No external error tracker (Sentry, Honeybadger etc.) is installed (`Gemfile`) [I].

---

## 11. Environment variables

Column meaning: **Default** = value used when unset (as coded); **Req.** = required for the given environment; **Kind** = runtime ENV unless marked build-time ARG,
compose-only interpolation, shell-script or rake parameter. Each variable has its own anchor.

### 11.1 Application runtime

<a id="env-active-record-encryption-primary-key"></a>
#### ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY
Primary key for AR encryption. Default: none (prod: generated by entrypoint). Required: production (boot fails otherwise), dev/test only to touch encrypted fields.
Read: `config/initializers/active_record_encryption.rb:15`; also export fingerprint `app/services/data_exchange/operations/export.rb:97` and import guard `app/services/data_exchange/operations/import.rb:145`; generated/exported by `bin/docker-entrypoint:40`; template `.env.example:14`. Runtime, all envs [I].

<a id="env-active-record-encryption-deterministic-key"></a>
#### ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY
Deterministic-encryption key (configured, unused by any attribute). Default: none (prod: entrypoint). Required: production. Read: `config/initializers/active_record_encryption.rb:16`;
`bin/docker-entrypoint:41`; `.env.example:15`. Runtime [I].

<a id="env-active-record-encryption-key-derivation-salt"></a>
#### ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT
Key-derivation salt for AR encryption. Default: none (prod: entrypoint). Required: production. Read: `config/initializers/active_record_encryption.rb:17`; `bin/docker-entrypoint:42`; `.env.example:16`. Runtime [I].

<a id="env-secret-key-base"></a>
#### SECRET_KEY_BASE
Rails master secret (cookies, message verifiers, Devise, Turbo signed streams). Implicit read by Rails in production (not referenced by app code). Default: generated by
`bin/docker-entrypoint:39` (`SecureRandom.hex(32)` persisted in `$SECRETS_DIR/secret_key_base`). Required: production. Dev/test use Rails' generated local secret. Runtime [I] (`inventory/env.txt` implicit section).

<a id="env-secret-key-base-dummy"></a>
#### SECRET_KEY_BASE_DUMMY
Build-time signal "no real secrets": skips the missing-encryption-keys check. Set to `1` only during image build (`Dockerfile:55`). Read: `config/initializers/active_record_encryption.rb:25`. Not for runtime use [I].

<a id="env-database-url"></a>
#### DATABASE_URL
Production database connection. Read: `config/database.yml:32` (production only) and checked by `bin/docker-migrate:18` (abort if unset). Default in compose:
`postgres://${POSTGRES_USER:-obr}:${POSTGRES_PASSWORD:-obr}@db:5432/${POSTGRES_DB:-obr_production}` (`docker-compose.prod.yml:17`). Required: production [I].

<a id="env-postgres-host"></a>
#### POSTGRES_HOST
Database host for development/test. Default `localhost`. Read: `config/database.yml:13`, `:24`; `.env.example:7`. Also set to `db` for the backup container (`docker-compose.prod.yml:128`, consumed by that image). Runtime dev/test [I].

<a id="env-postgres-port"></a>
#### POSTGRES_PORT
Database port dev/test. Default `5432`. Read: `config/database.yml:14`, `:25`; host port mapping in dev compose `docker-compose.yml:17`; `.env.example:8`. Runtime dev/test; compose interpolation [I].

<a id="env-postgres-user"></a>
#### POSTGRES_USER
Database user. Default `postgres` (dev/test, `config/database.yml:15`, `:26`); `obr` in prod compose (`docker-compose.prod.yml:17`, `:40`, `:46`, `:130`, `:165`); dev compose healthcheck `docker-compose.yml:21`; `.env.example:4`.
Runtime dev/test; compose interpolation in prod (builds DATABASE_URL, initialises the db container) [I].

<a id="env-postgres-password"></a>
#### POSTGRES_PASSWORD
Database password. Default `postgres` (dev/test, `config/database.yml:16`, `:27`); `obr` in prod compose (`docker-compose.prod.yml:17`, `:41`, `:131`, `:148`); `.env.example:5` (prod note: set a strong value, `.env.example:35`). Same kinds as POSTGRES_USER [I].

<a id="env-postgres-db"></a>
#### POSTGRES_DB
Database name. Default `open_banking_rails_development` (development, `config/database.yml:17`; test is fixed `open_banking_rails_test`, `:28`); `obr_production` in prod compose (`docker-compose.prod.yml:17`, `:42`, `:46`, `:129`, `:165`); `docker-compose.yml:21`; `.env.example:6` [I].

<a id="env-redis-url"></a>
#### REDIS_URL
Redis for ActionCable (`config/cable.yml:6`, `:14`, default `redis://localhost:6379/1`) and, implicitly, for Sidekiq client and server (Sidekiq default `redis://localhost:6379/0`; `config/initializers/sidekiq.rb` sets no URL).
Prod compose: `redis://redis:6379/0` (`docker-compose.prod.yml:18`); `.env.example:10`: `redis://localhost:6379/0`. Required: dev/prod (any process using Sidekiq/ActionCable) [I]. Note that dev defaults differ (cable DB 1 vs Sidekiq DB 0) when unset.

<a id="env-redis-port"></a>
#### REDIS_PORT
Host port mapping of the dev Redis container only. Default `6379`. Read: `docker-compose.yml:29`; `.env.example:11`. Compose-only, development [I].

<a id="env-app-host"></a>
#### APP_HOST
Public host[:port] (no scheme) of the production instance: mailer link host/port and fallback for allowed hosts. Default `localhost:3000`. Read: `config/environments/production.rb:61`, `:99`; compose `docker-compose.prod.yml:19`. Production [I].

<a id="env-app-hosts"></a>
#### APP_HOSTS
Comma-separated allowed Host headers (DNS-rebinding protection); empty -> falls back to APP_HOST; empty result disables the check. Default: compose `""`. Read: `config/environments/production.rb:99-100`; `docker-compose.prod.yml:21`. Production [I].

<a id="env-app-protocol"></a>
#### APP_PROTOCOL
Scheme for mailer links. Default `https` in code (`config/environments/production.rb:66`), but `http` in prod compose (`docker-compose.prod.yml:20`). Production [I].

<a id="env-force-ssl"></a>
#### FORCE_SSL
`"true"` enables `assume_ssl` + `force_ssl` (HTTPS redirect, HSTS, secure cookies); any other value disables both. Default `"true"` in code (`config/environments/production.rb:30-31`), **`false` in prod compose** (`docker-compose.prod.yml:22`). Production [I] (see U-819).

<a id="env-rails-env"></a>
#### RAILS_ENV
Rails environment. `production` baked into the image (`Dockerfile:24`) and set by compose (`docker-compose.prod.yml:16`); specs default it to `test` (`spec/rails_helper.rb:2`); development when unset. Runtime [I].

<a id="env-rails-log-level"></a>
#### RAILS_LOG_LEVEL
Production log level. Default `info`. Read: `config/environments/production.rb:41`; compose `docker-compose.prod.yml:23`. Production [I].

<a id="env-rails-max-threads"></a>
#### RAILS_MAX_THREADS
Puma threads (min = max) and DB pool size. Default `3` for Puma (`config/puma.rb:28-29`), `5` for the DB pool (`config/database.yml:9`); prod compose `5` (`docker-compose.prod.yml:24`). Runtime [I].

<a id="env-web-concurrency"></a>
#### WEB_CONCURRENCY
Number of Puma worker processes. Not read by app code: Puma reads it implicitly (`config/puma.rb:8` comment); default 1 worker (single mode, as in the oracle: `oracle/server.log.txt:5` "Puma starting in single mode..."); prod compose `2` (`docker-compose.prod.yml:25`). Runtime [I], dev default [V].

<a id="env-port"></a>
#### PORT
Puma listen port. Default `3000`. Read: `config/puma.rb:32`; exported by `bin/dev:9`. Runtime [I].

<a id="env-pidfile"></a>
#### PIDFILE
Optional Puma pid file path; unset -> Puma default. Read: `config/puma.rb:39`. Runtime [I].

<a id="env-llm-merchant-auto-approve-threshold"></a>
#### LLM_MERCHANT_AUTO_APPROVE_THRESHOLD
Confidence at or above which LLM merchant suggestions become enabled rules/approved merchants. Default `"0.85"` parsed as float, read **once at class load** (`app/services/llm/enrichment_runner.rb:9`). Not in `.env.example` or compose. Runtime, all envs [I] (see U-820; rule detail BR-200..BR-299 in `20-business-rules.md`).

<a id="env-psu-ip-address"></a>
#### PSU_IP_ADDRESS
If set, sent as `PSU-IP-Address` header on every Enable Banking request. Default: not sent. Read: `app/services/enable_banking/client.rb:35`; spec `spec/services/enable_banking/adapter_spec.rb:103`. Runtime, optional [I].

<a id="env-psu-user-agent"></a>
#### PSU_USER_AGENT
If set, sent as `PSU-User-Agent` header on every Enable Banking request. Read: `app/services/enable_banking/client.rb:36`; spec `spec/services/enable_banking/adapter_spec.rb:104`. Runtime, optional [I].

<a id="env-smtp-address"></a>
#### SMTP_ADDRESS
SMTP server; when blank, no SMTP settings are applied (Rails default localhost:25). Read: `config/environments/production.rb:73`, `:75`; compose `docker-compose.prod.yml:26` (default empty). Production, optional [I] (see U-822).

<a id="env-smtp-port"></a>
#### SMTP_PORT
SMTP port. Default `587` (`config/environments/production.rb:76`); compose passes `${SMTP_PORT:-}` (`docker-compose.prod.yml:27`) - an empty string would become port 0 via `to_i` [I] (see U-822).

<a id="env-smtp-domain"></a>
#### SMTP_DOMAIN
HELO domain. Default nil. Read: `config/environments/production.rb:77`; `docker-compose.prod.yml:28` [I].

<a id="env-smtp-username"></a>
#### SMTP_USERNAME
SMTP user. Default nil. Read: `config/environments/production.rb:78`; `docker-compose.prod.yml:29` [I].

<a id="env-smtp-password"></a>
#### SMTP_PASSWORD
SMTP password. Default nil. Read: `config/environments/production.rb:79`; `docker-compose.prod.yml:30` [I].

<a id="env-smtp-authentication"></a>
#### SMTP_AUTHENTICATION
SMTP auth method (symbolised). Default `plain`. Read: `config/environments/production.rb:80`; `docker-compose.prod.yml:31` (compose passes empty string when unset -> `:""`, see U-822) [I].

<a id="env-smtp-starttls"></a>
#### SMTP_STARTTLS
`"true"` enables STARTTLS auto. Default `"true"`. Read: `config/environments/production.rb:81`; `docker-compose.prod.yml:32` (empty string when unset -> STARTTLS **off**, see U-822) [I].

<a id="env-ci"></a>
#### CI
When present, the test environment eager-loads the app. Read: `config/environments/test.rb:16`. Test/CI only [I].

### 11.2 OpenTelemetry

<a id="env-otel-service-name"></a>
#### OTEL_SERVICE_NAME
Service name on all telemetry. Default `open-banking-rails`. Read: `config/initializers/opentelemetry.rb:6`; `.env.example:18`. Runtime [I].

<a id="env-otel-exporter-otlp-endpoint"></a>
#### OTEL_EXPORTER_OTLP_ENDPOINT
OTLP collector endpoint, read implicitly by the OTel SDK exporters. Template `http://localhost:4318` (`.env.example:19`); SDK default is the same for HTTP. Not set in prod compose. Runtime [I].

<a id="env-otel-exporter-otlp-protocol"></a>
#### OTEL_EXPORTER_OTLP_PROTOCOL
OTLP protocol, implicit SDK read. Template `http/protobuf` (`.env.example:20`). Runtime [I].

<a id="env-otel-traces-exporter"></a>
#### OTEL_TRACES_EXPORTER
Trace exporter selection (implicit SDK read; SDK default `otlp`). Template `otlp` (`.env.example:21`); specs force `none` (`spec/spec_helper.rb:10`). Runtime [I].

<a id="env-otel-metrics-exporter"></a>
#### OTEL_METRICS_EXPORTER
Metrics exporter selection (implicit; metrics SDK gem installed). Template `otlp` (`.env.example:22`); specs `none` (`spec/spec_helper.rb:11`). Runtime [I].

<a id="env-otel-logs-exporter"></a>
#### OTEL_LOGS_EXPORTER
Logs exporter selection (implicit; logs SDK gem installed). Template `otlp` (`.env.example:23`); specs `none` (`spec/spec_helper.rb:12`). Runtime [I].

<a id="env-otel-sdk-disabled"></a>
#### OTEL_SDK_DISABLED
`true` disables the SDK entirely. Specs set `true` (`spec/spec_helper.rb:13`). It was set in the oracle run [V] (`oracle/server.log.txt:4`). Runtime [I].

<a id="env-otel-sdk-standard-implicit"></a>
#### OTEL_* (SDK-standard, implicit)
Any other variable from the OpenTelemetry SDK specification (e.g. `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER`, per-signal endpoints) is honoured implicitly by
`opentelemetry-sdk` / exporters configured in `config/initializers/opentelemetry.rb:5-8` (`inventory/env.txt` implicit section). Kotlin: the OTel Java agent/SDK uses the same variable names [I].

### 11.3 Container, compose and scripts

<a id="env-secrets-dir"></a>
#### SECRETS_DIR
Directory for generated secrets. Default `/rails/secrets` (the `app_secrets` volume). Read: `bin/docker-entrypoint:18`. Production containers, shell script [I].

<a id="env-backups-dir"></a>
#### BACKUPS_DIR
Directory for pre-migration dumps. Default `/rails/backups` (bind mount `./backups`). Read: `bin/docker-migrate:15`. Production migrate service, shell script [I].

<a id="env-backup-schedule"></a>
#### BACKUP_SCHEDULE
Cron/descriptor for the backup container (`SCHEDULE`). Default `@daily`. `docker-compose.prod.yml:132`. Compose interpolation, consumed by `postgres-backup-local` [I].

<a id="env-backup-keep-days"></a>
#### BACKUP_KEEP_DAYS
Daily backups retained. Default `7`. `docker-compose.prod.yml:133` [I].

<a id="env-backup-keep-weeks"></a>
#### BACKUP_KEEP_WEEKS
Weekly backups retained. Default `4`. `docker-compose.prod.yml:134` [I].

<a id="env-backup-keep-months"></a>
#### BACKUP_KEEP_MONTHS
Monthly backups retained. Default `6`. `docker-compose.prod.yml:135` [I].

<a id="env-app-tag"></a>
#### APP_TAG
Image tag of `ghcr.io/maciejb2k/open-banking-rails`. Default `latest`. `docker-compose.prod.yml:10`. Compose interpolation [I].

<a id="env-app-port"></a>
#### APP_PORT
Host port published for the app container (container port 3000). Default `3000`. `docker-compose.prod.yml:87`. Compose interpolation [I].

<a id="env-compose-file"></a>
#### COMPOSE_FILE
In `bin/restore:14` and `bin/upgrade:15` this is a **local shell variable hard-coded** to `docker-compose.prod.yml` (any caller value is overwritten); passed explicitly via `-f`. Shell script [I].

<a id="env-bundle-gemfile"></a>
#### BUNDLE_GEMFILE
Gemfile location; defaults to the app's `Gemfile` if unset (`config/boot.rb:1`). Runtime (Ruby boot) [I].

<a id="env-bundle-path"></a>
#### BUNDLE_PATH
Gem install path `/usr/local/bundle`, set as image ENV (`Dockerfile:26`) and used in build steps (`Dockerfile:43`, `:81`). Build-time and runtime in the image [I].

<a id="env-ruby-version"></a>
#### RUBY_VERSION
**Build-time ARG** selecting the base image `ruby:$RUBY_VERSION-slim`, default `3.4.8` (`Dockerfile:11-12`). Not a runtime setting [I].

<a id="env-app-version"></a>
#### APP_VERSION
**Build-time ARG** (default `dev`) written to `/rails/VERSION` (`Dockerfile:66-67`); CI passes the git tag (`.github/workflows/release.yml:61-62`). At runtime `OpenBankingRails::ADMIN_VERSION` = contents of `VERSION` without leading `v`, or `"dev"` if the file is missing (`config/application.rb:25-30`); shown in the admin footer [I].

<a id="env-ruby-debug-open"></a>
#### RUBY_DEBUG_OPEN
`true` lets the `debug` gem accept remote connections; exported by `bin/dev:13`. Development only [I].

<a id="env-ruby-debug-lazy"></a>
#### RUBY_DEBUG_LAZY
`true` defers loading the debugger until `debugger` is called; exported by `bin/dev:14`. Development only [I].

<a id="env-annotaterb-skip-on-db-tasks"></a>
#### ANNOTATERB_SKIP_ON_DB_TASKS
If set (any value), development DB tasks skip annotate_rb model annotations. Read: `lib/tasks/annotate_rb.rake:4`. Development tooling [I].

### 11.4 Rake task parameters (see `60-async-and-integrations.md` section 7)

<a id="env-user-email"></a>
#### USER_EMAIL
`banking:start_auth`: email of the user owning the TPP credential; required (`abort "USER_EMAIL=... is required"`). `lib/tasks/eb_auth.rake:30` [I].

<a id="env-aspsp"></a>
#### ASPSP
`banking:start_auth`: bank name as Enable Banking expects it; required (`"ASPSP=... is required"`). `lib/tasks/eb_auth.rake:31` [I].

<a id="env-credential-id"></a>
#### CREDENTIAL_ID
`banking:start_auth`: TppCredential id of that user; default the user's primary credential. `lib/tasks/eb_auth.rake:35-36` [I].

<a id="env-redirect-url"></a>
#### REDIRECT_URL
`banking:start_auth`: one-shot override of the credential's redirect URL for this `/auth` call (not saved). `lib/tasks/eb_auth.rake:42-44` [I].

<a id="env-country"></a>
#### COUNTRY
`banking:start_auth`: ASPSP country, default `PL`. `lib/tasks/eb_auth.rake:49` [I].

<a id="env-psu-type"></a>
#### PSU_TYPE
`banking:start_auth`: `personal` or `business`, default `personal`. `lib/tasks/eb_auth.rake:50` [I].

<a id="env-days"></a>
#### DAYS
`banking:start_auth`: consent validity in days (1..180 per the task header), default `180`. `lib/tasks/eb_auth.rake:20`, `:51` [I].

<a id="env-code"></a>
#### CODE
`banking:finish_auth`: authorization code from the bank redirect; required (`"CODE=... is required"`). `lib/tasks/eb_auth.rake:79` [I].

<a id="env-state"></a>
#### STATE
`banking:finish_auth`: state token from the bank redirect; required (`"STATE=... is required"`). `lib/tasks/eb_auth.rake:80` [I].

<a id="env-canonical-id"></a>
#### CANONICAL_ID
`banking:merge_duplicate_accounts`: id of the BankAccount to keep; required. `lib/tasks/duplicate_bank_accounts.rake:45` [I].

<a id="env-dup-id"></a>
#### DUP_ID
`banking:merge_duplicate_accounts`: id of the BankAccount to drop; required. `lib/tasks/duplicate_bank_accounts.rake:46` [I].

<a id="env-confirm"></a>
#### CONFIRM
`banking:merge_duplicate_accounts`: `1` to write; anything else = dry run. `lib/tasks/duplicate_bank_accounts.rake:47` [I].

<a id="env-dry-run"></a>
#### DRY_RUN
`banking:backfill_payment_methods`: `1` = preview only. `lib/tasks/banking.rake:38` [I].

---

## 12. Initializers

<a id="init-active-record-encryption"></a>
### active_record_encryption.rb
Wires AR encryption keys from the three `ACTIVE_RECORD_ENCRYPTION_*` ENV vars via `ActiveRecord::Encryption.configure` (the railtie has already copied app config, so setting
`config.active_record.encryption.*` here would have no effect). Production without keys (and without `SECRET_KEY_BASE_DUMMY`) raises at boot with the message quoted in section 6.
`config/initializers/active_record_encryption.rb:1-32` [I].

<a id="init-assets"></a>
### assets.rb
Propshaft/Sprockets asset version `"1.0"`; no extra asset paths. `config/initializers/assets.rb:4` [I]. Kotlin: irrelevant except cache-busting of static assets.

<a id="init-content-security-policy"></a>
### content_security_policy.rb
Entirely commented-out Rails template - **no CSP is set** (no policy, no nonce generator, no report-only). `config/initializers/content_security_policy.rb:7-29` [I]; [V] no CSP header on app pages (section 4).

<a id="init-cors"></a>
### cors.rb
Inserts `Rack::Cors` at position 0: `origins "*"`, `resource "*", headers: :any, methods: [:get, :post, :put, :patch, :delete, :options, :head]`. `config/initializers/cors.rb:1-6` [V] (section 4).

<a id="init-devise"></a>
### devise.rb
Non-default values: `mailer_sender = "please-change-me-at-config-initializers-devise@example.com"` (`:27`); ORM active_record (`:39`); `case_insensitive_keys = [:email]` (`:61`);
`strip_whitespace_keys = [:email]` (`:66`); `skip_session_storage = [:http_auth]` (`:100`); `stretches = 1 in test, else 12` (`:126`); `reconfirmable = true` (`:163`, no effect without confirmable);
`expire_all_remember_me_on_sign_out = true` (`:173`); `password_length = 6..128` (`:184`); `email_regexp = /\A[^@\s]+@[^@\s]+\z/` (`:189`); `reset_password_within = 6.hours` (`:230`);
`sign_out_via = :delete` (`:272`); `responder.error_status = :unprocessable_content` (422) and `responder.redirect_status = :see_other` (303) (`:308-309`). Everything else is the Devise default
(no paranoid mode, remember 2 weeks, timeout/lock settings unused). `config/initializers/devise.rb:11-316` [I].

<a id="init-filter-parameter-logging"></a>
### filter_parameter_logging.rb
Adds `:passw, :passphrase, :email, :secret, :token, :_key, :crypt, :salt, :certificate, :otp, :ssn, :cvv, :cvc` to `filter_parameters` (partial match). `config/initializers/filter_parameter_logging.rb:6-8` [V] (section 5).

<a id="init-inflections"></a>
### inflections.rb
Acronym `OpenAI` (so `Llm::Clients::OpenAI` autoloads from `openai.rb`). `config/initializers/inflections.rb:13-15` [I].

<a id="init-json-schema"></a>
### json_schema.rb
If the `json-schema` gem (pulled in by `mcp`) is loaded, stop it using MultiJSON: `JSON::Validator.use_multi_json = false`. `config/initializers/json_schema.rb:1-3` [I].

<a id="init-lograge"></a>
### lograge.rb
`lograge.enabled = true`, JSON formatter, custom option `params` = request params (already filtered). All environments. `config/initializers/lograge.rb:1-8` [V] (section 5).

<a id="init-money"></a>
### money.rb
money-rails: default currency `PLN`, `no_cents_if_whole = false` (always two decimals when formatting), `locale_backend = :i18n`. Storage convention: every amount is a `*_cents` bigint plus an ISO 4217 currency column.
`config/initializers/money.rb:3-10` [I]. (Formatting rules: `40-ui.md` / `20-business-rules.md`.)

<a id="init-opentelemetry"></a>
### opentelemetry.rb
Requires the SDK, all instrumentations and the OTLP exporter; `OpenTelemetry::SDK.configure { service_name = ENV["OTEL_SERVICE_NAME"] || "open-banking-rails"; use_all }`. Exporters, endpoint, sampling via standard `OTEL_*` ENV.
`config/initializers/opentelemetry.rb:1-8` [I]; disabled in the oracle run [V].

<a id="init-opentelemetry-error-subscriber"></a>
### opentelemetry_error_subscriber.rb
Defines `OpenTelemetryErrorSubscriber#report(error, handled:, severity:, context:, source:)` -> record exception + error status on the current recording span; subscribed with `Rails.error.subscribe`.
`config/initializers/opentelemetry_error_subscriber.rb:3-13` [I].

<a id="init-pagy"></a>
### pagy.rb
Pagination defaults: `limit = 10` items per page, `max_limit = 100` (largest client-requestable page size); options frozen. `config/initializers/pagy.rb:5-8` [V] [oracle](../oracle/http/GET_api__version_merchants.json) case filtered -> `"pagination": {"page": 1, "limit": 10, ...}`.

<a id="init-paper-trail-ransack"></a>
### paper_trail_ransack.rb
On ActiveRecord load, allow Ransack search/sort on `PaperTrail::Version` attributes `created_at, event, id, item_id, item_type, object, object_changes, whodunnit` and no associations (used by `/admin/versions` filters).
`config/initializers/paper_trail_ransack.rb:1-11` [I].

<a id="init-ransack"></a>
### ransack.rb
`sanitize_custom_scope_booleans = true` - `"0"`/`"false"` are cast to false so unchecked checkboxes do not activate custom scopes. `config/initializers/ransack.rb:3-6` [I].

<a id="init-ruby-llm"></a>
### ruby_llm.rb
`RubyLLM.configure { request_timeout = 60; max_retries = 2 }`; deliberately no provider keys (bound per call per user). `config/initializers/ruby_llm.rb:11-14` [I]. Its comment says only normalized titles and counterparty
names are sent; the raw title is also sent (see `60-async-and-integrations.md` 6.3 and U-816).

<a id="init-sidekiq"></a>
### sidekiq.rb
`Sidekiq.configure_server`: JSON log formatter; if `config/schedule.yml` exists, `Sidekiq::Cron::Job.load_from_hash!(YAML.load_file(...))` (server-only cron registration). No client config, no Redis URL (ENV `REDIS_URL` / default).
`config/initializers/sidekiq.rb:3-13` [I].

## Kotlin-only configuration introduced by decisions

| Variable | Purpose | Default | Decision |
|---|---|---|---|
| `APP_TIME_ZONE` | Instance-wide IANA time zone for "today", default analytics periods, cash default booking date and sync-schedule `preferred_hour`. Timestamps remain stored in UTC. Parity tests against the Ruby oracle use `APP_TIME_ZONE=UTC`. | `Europe/Warsaw` | [D-007](decisions.md#d-007-time-zone-round-2-q1) |
| (job runner) | JobRunr replaces Sidekiq/sidekiq-cron; `REDIS_URL` is no longer required by the Kotlin service (still used by the Ruby app). JobRunr dashboard exposure must respect D-003/D-006. | – | D-001, D-006 |
