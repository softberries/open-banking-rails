### U-500 BUG? Audit log (`/admin/versions`, `/admin/versions/:id`) is not tenant-scoped
- **What is unclear:** Whether the audit log is meant to be global. Every signed-in user can list and open every PaperTrail version of every tenant, including the attribute changes of `BankAccount` (IBAN, BBAN, name, details), `BankConnection` (bank name, status, validity), `ManualTransaction` (amounts, titles, notes) and `TppCredential` (name, redirect URL, certificate; private key and application id are excluded).
- **Evidence for / against:** `app/controllers/admin/versions_controller.rb:6,10` query `PaperTrail::Version` without any user filter; `has_paper_trail` in `app/models/bank_account.rb:71`, `bank_connection.rb:61`, `manual_transaction.rb:74`, `tpp_credential.rb:57`. Observed: [oracle](../oracle/http/GET_admin_versions.json) case `other_tenant_sees_all_versions -> 200`, [oracle](../oracle/http/GET_admin_versions__id.json) case `other_tenant_reads_main_version -> 200` **[V]**. Against: ADR 0011 says deployments are "single-user-shaped", so the author may have considered it harmless; but the same ADR keeps the schema multi-tenant and every other admin route is scoped (`AGENTS.md:252`).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** fix in Kotlin: only show versions whose item belongs to the current user (resolve ownership per `item_type`), or whose `whodunnit` is the current user; 404 for others.

### U-501 BUG? Sidekiq dashboard `/sidekiq` is available to every signed-in user
- **What is unclear:** Whether job administration should be restricted to an operator. Any authenticated tenant sees all jobs (arguments include run ids, user ids) and can retry/delete/kill jobs and cron entries of all tenants.
- **Evidence for / against:** `config/routes.rb:12-14` (`authenticate :user` only); **[V]** [oracle](../oracle/http/GET_sidekiq.json) case `authenticated -> 200`. ADR 0011 (single user per deployment in practice) makes it low impact today.
- **Who/what can resolve:** product owner / operator.
- **Human question?** yes (scope, migration choice).
- **Proposed default:** the Kotlin service does not expose a job dashboard to tenants; if an operator UI is needed, protect it with a separate operator credential.

### U-502 BUG? `POST /admin/bank_connections` with an invalid form answers 204 with an empty body
- **What is unclear:** The intended behaviour is evidently "re-render the new-connection form with the validation errors" (`flash.now[:alert]` is set and `new` is called), but no template is rendered, so the browser receives `204 No Content` and nothing visible happens.
- **Evidence for / against:** `app/controllers/admin/bank_connections_controller.rb:47-50`; **[V]** [oracle](../oracle/http/POST_admin_bank_connections.json) case `invalid_blank_aspsp -> 204`; `oracle/server.log.txt:15001` "No template found for Admin::BankConnectionsController#create, rendering head :no_content". No spec covers the invalid-form branch. The HTML form normally prevents an empty bank (required select), which is why it went unnoticed **[I]**.
- **Who/what can resolve:** original author / product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** Kotlin re-renders the "Add bank connection" form with 422 and the alert "<joined errors>" (e.g. "Aspsp name can't be blank").

### U-503 BUG? Unknown LLM provider on `PATCH /admin/settings/preferences/llm` -> 500
- **What is unclear:** A provider value outside the registry (only possible by tampering) raises `ArgumentError` "Unknown LLM provider: \"martian\"" while re-rendering the form instead of producing a validation error.
- **Evidence for / against:** **[V]** [oracle](../oracle/http/PATCH_admin_settings_preferences_llm.json) case `invalid_provider -> 500` (h1 "ArgumentError in Admin::Settings::Preferences#update_llm"); `app/services/llm/providers.rb:38`; `app/views/admin/settings/preferences/llm.html.erb:37`; `app/models/llm_setting.rb:41,73`. The model has an inclusion validation on provider, so the intent is clearly a 422.
- **Who/what can resolve:** reading/running; no product decision needed.
- **Human question?** no.
- **Proposed default:** Kotlin returns 422 with alert "Provider is not included in the list".

### U-504 `POST /admin/settings/preferences/llm/test` bypasses the `Llm::Client.for` seam
- **What is unclear:** Whether `ConnectionTestRunner` should obtain its client through `Llm::Client.for` like the rest of the LLM code. It calls `setting.build_client` directly, so the in-memory fake installed for the capture was bypassed and a real OpenAI call was made with the fake key.
- **Evidence for / against:** `app/services/llm/connection_test_runner.rb:129`; `app/services/llm/client.rb:24-31` (`for` only adds the not-configured check, then calls `build_client`); **[V]** run 14 `llm_connection_test` failed with "OpenAI API error: RubyLLM::UnauthorizedError: Incorrect API key provided ..." in `oracle/operation_runs_after_capture.jsonl`. In production both paths build the same client, so the user-visible behaviour is identical; the impact is on testability.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** in Kotlin route all provider calls through one injectable client factory.

### U-505 BUG? `Admin::MerchantsController#edit` is defined twice; the hidden-category guard is dead code
- **What is unclear:** Whether `GET /admin/merchants/:id/edit` should refuse merchants in hidden categories (as `show` does).
- **Evidence for / against:** first definition with guard at `app/controllers/admin/merchants_controller.rb:37-42` (alert "This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it."), second empty definition at `:58-59` which replaces it at class-load time **[I]**. No spec covers edit of a hidden merchant. The analogous category and cash edit actions do enforce the guard.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** enforce the guard (302 to `/admin/merchants` with the alert above), consistent with `show`.

### U-506 BUG? OAuth callback can attach another tenant's bank account (unscoped `find_existing_account`)
- **What is unclear:** `GET /callback` -> `EnableBanking::Operations::CreateConnection#find_existing_account` looks up `BankAccount.find_by(uid:)` across all tenants and then reassigns `tpp_credential` / `current_bank_connection` to the caller's, moving the account (and, through `BankTransaction.for_user`, its whole transaction history) to the second tenant.
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:55-63,85-93`; observed by the investigator while seeding two tenants (brief). Fallback lookup by IBAN is correctly scoped to the credential (`:92`).
- **Who/what can resolve:** product owner (is a shared bank account between two household users a supported case?).
- **Human question?** yes.
- **Proposed default:** scope the uid lookup to the current user's credentials; a uid owned by another tenant creates a separate account row.

### U-507 Password-reset request reveals whether an email is registered
- **What is unclear:** `POST /admin/password` answers 422 "Email not found" for unknown emails and 303 for known ones (Devise `paranoid` mode off), enabling account enumeration.
- **Evidence for / against:** `config/initializers/devise.rb:93` (`# config.paranoid = true`); **[V]** [oracle](../oracle/http/POST_admin_password.json) cases `unknown_email -> 422`, `known_email -> 303`; `spec/requests/public_spec.rb:224` describes the notice as "neutral", suggesting the author wanted non-enumeration.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** Kotlin always answers 303 to `/admin/sign_in` with the neutral notice "You will receive an email with instructions on how to reset your password in a few minutes." (Devise paranoid wording "If your email address exists in our database, you will receive a password recovery link at your email address in a few minutes." is an alternative).

### U-508 Password-reset e-mail delivery is not really configured
- **What is unclear:** Whether e-mail password reset is a supported feature. The Devise mailer sender is the placeholder "please-change-me-at-config-initializers-devise@example.com" and ADR 0011 says "Forgot-password without SMTP is a documented `bin/rails runner` one-liner".
- **Evidence for / against:** `config/initializers/devise.rb:27`; `docs/adr/0011-first-run-setup.md` (Consequences); `inventory/mailers.json`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** keep the routes, make sender and SMTP configurable via environment; if SMTP is not configured, still answer as today (no error to the user) and log.

### U-509 Framework default routes (ActionMailbox ingresses, Rails Conductor, ActiveStorage) — drop in Kotlin?
- **What is unclear:** Whether anything depends on the 23 framework routes. Their tables do not exist, so they can never work: ingresses 404, Conductor index/show 500 in development (403 elsewhere), ActiveStorage 404/422.
- **Evidence for / against:** `config/application.rb:8,11,12` load the engines; no mailboxes, attachments or rich text in `app/`; `inventory/models.json` `table_exists: false` for `action_mailbox_inbound_emails`, `active_storage_*`, `action_text_rich_texts`; **[V]** oracle cases listed in A.23 (all 404/422/500 except two Conductor form pages 200).
- **Who/what can resolve:** original author (were these left from `rails new`?).
- **Human question?** no (technical scope; confirm only).
- **Proposed default:** do not implement; unknown paths answer 404 in Kotlin. Optionally remove the engines from the Rails app.

### U-510 Turbo Native historical-location routes — needed?
- **What is unclear:** Whether a Hotwire Native mobile client exists or is planned; only then are `/recede_historical_location`, `/resume_historical_location`, `/refresh_historical_location` meaningful.
- **Evidence for / against:** drawn by turbo-rails 2.0.23 automatically; the app never redirects to them (no `*_or_redirect_to` helpers in `app/`); **[V]** oracle 200 with bodies "Going back…", "Staying put…", "Refreshing…".
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** omit unless the Kotlin service keeps a Turbo/Hotwire front end with native wrappers.

### U-511 Manual override of bank connection `status` / `valid_until` (`PATCH|PUT /admin/bank_connections/:id`)
- **What is unclear:** Intended use of the edit form. It lets the user set any of `pending, authorized, expired, revoked, replaced, error, closed` and any `valid_until`, bypassing the provider (e.g. marking an expired consent as authorized). Statuses are lower-case only; the oracle's upper-case `AUTHORIZED` was rejected with 422.
- **Evidence for / against:** `app/controllers/admin/bank_connections_controller.rb:18-24,99-101`; `inventory/models.json` BankConnection inclusion list; **[V]** [oracle](../oracle/http/PATCH_admin_bank_connections__id.json) case `default -> 422`, [oracle](../oracle/http/PUT_admin_bank_connections__id.json) case `invalid_status -> 422`. No spec covers update.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (intent).
- **Proposed default:** keep as an "advanced" override with the same allowed values; consider restricting to `valid_until` and `closed`.

### U-512 BUG? `POST /admin/transaction_syncs` silently widens an invalid connection to a user-wide sync and accepts reversed dates
- **What is unclear:** A blank, unknown, foreign or inactive `bank_connection_id` does not fail: the run's subject becomes the user (syncs all of the user's connections). `date_from > date_to` is stored unvalidated.
- **Evidence for / against:** `app/services/transaction_syncs/queuer.rb:25,60-63`; **[V]** [oracle](../oracle/http/POST_admin_transaction_syncs.json) case `missing_connection -> 302` -> run 13 subject `User`; run 8 in `oracle/operation_runs_after_capture.jsonl` has `date_from 2026-10-21`, `date_to 2026-07-13` and still `succeeded`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** blank id = sync all (keep, it is a UI option **[I]**); unknown/foreign id -> alert "Could not start sync: Bank connection not found"; `date_from > date_to` -> alert "Could not start sync: date_from must be <= date_to".

### U-513 Classification form without `mode` -> 500
- **What is unclear:** `PATCH /admin/bank_transactions/:id/enrichment` without `enrichment[mode]` calls `nil.to_sym` -> `NoMethodError` -> 500; with an empty string it yields "Unknown propagation mode: ".
- **Evidence for / against:** `app/services/enrichment/classification_applier.rb:15,36`; not covered by oracle or specs **[I]**.
- **Who/what can resolve:** reading/running.
- **Human question?** no.
- **Proposed default:** Kotlin treats a missing mode as invalid: 302 back with alert "Unknown propagation mode: ".

### U-514 Data import with a non-file `bundle` parameter -> 500
- **What is unclear:** `params[:bundle].read` assumes an uploaded file; a plain string field raises `NoMethodError` -> 500.
- **Evidence for / against:** `app/controllers/admin/settings/data_exchange_controller.rb:38` **[I]**.
- **Who/what can resolve:** reading/running.
- **Human question?** no.
- **Proposed default:** treat a non-file value like a missing file (alert "Bundle file is required.").

### U-515 Analytics HTML pages with `from > to`
- **What is unclear:** `Analytics::Period` raises `ArgumentError` "from must be <= to"; the API variant is a known 500 (Part B). The HTML dashboard / category / merchant pages build the same filter and should also 500.
- **Evidence for / against:** `app/services/analytics/period.rb:19`; `app/services/analytics/filter.rb:38-40,176-190` **[I]**; not exercised by the oracle for HTML.
- **Who/what can resolve:** running the request.
- **Human question?** no.
- **Proposed default:** Kotlin swaps or rejects reversed ranges; for HTML show the page with an alert and the default month-to-date range.

### U-516 HTML error pages in Kotlin
- **What is unclear:** Whether the Kotlin service must reproduce the five static Rails error pages (400/404/406/422/500) byte-for-byte.
- **Evidence for / against:** `public/400.html`, `404.html`, `406-unsupported-browser.html`, `422.html`, `500.html`; production `consider_all_requests_local = false` (`config/environments/production.rb:13`).
- **Who/what can resolve:** product owner / UI owner.
- **Human question?** no (migration choice with obvious default).
- **Proposed default:** serve equivalent static pages with the same titles and texts (A.3); never expose stack traces outside development.

### U-517 CORS `origins "*"` also covers the HTML admin
- **What is unclear:** Whether the wildcard CORS policy was meant for the JSON API only.
- **Evidence for / against:** `config/initializers/cors.rb` (all resources, all methods, no credentials). Without `credentials: true` browsers do not send cookies on cross-origin XHR, so session-authenticated HTML is not readable cross-origin **[I]**.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** in Kotlin apply CORS only to `/api/**` (and `/mcp` if needed).

### U-518 Post-sign-in redirect may target a non-page URL
- **What is unclear:** Devise stores the last GET URL that required authentication; in the capture, sign-in redirected to `/api/v9/docs` (an earlier anonymous request), i.e. to a URL that does not even exist as a page.
- **Evidence for / against:** **[V]** [oracle](../oracle/http/POST_admin_sign_in.json) case `valid_credentials -> 303` Location `/api/v9/docs`; `app/controllers/swagger_controller.rb` (Part B).
- **Who/what can resolve:** product owner (low impact).
- **Human question?** no.
- **Proposed default:** store only GET HTML navigations under `/admin/**`, `/callback`, `/sidekiq` and the API docs page; otherwise redirect to `/admin/analytics`.

### U-519 OAuth `state` is readable and replayable within its TTL
- **What is unclear:** Whether the bank-auth state needs confidentiality / single use. It is HMAC-signed (not encrypted) and its nonce is not stored, so it can be reused for 30 minutes by the same user.
- **Evidence for / against:** `app/services/enable_banking/state.rb:9,12-35`; **[V]** decoded payload visible in [oracle](../oracle/http/POST_admin_bank_connections.json) case `default` Location. The user-id check (`app/controllers/oauth_callbacks_controller.rb:12`) prevents cross-user use.
- **Who/what can resolve:** security reviewer.
- **Human question?** no.
- **Proposed default:** keep signed state with 30-minute TTL and user check; optionally store the nonce and reject reuse.

### U-520 Session lifetime parity (no timeout, 2-week remember-me)
- **What is unclear:** Whether the Kotlin service should keep "no idle timeout" sessions and a 2-week remember-me cookie.
- **Evidence for / against:** `app/models/user.rb:23` (no `:timeoutable`, no `:lockable`); `config/initializers/devise.rb:170,173,194` (defaults commented out) **[I]**.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** same semantics: session cookie until browser close, remember-me 2 weeks, all remember tokens invalidated on sign-out and password change.

### U-521 Hidden-category guard applies to show/edit but not to update/destroy
- **What is unclear:** For cash transactions and categories the "hidden category" guard protects only the GET pages; PATCH/PUT/DELETE on a hidden record still succeed if the id is known.
- **Evidence for / against:** `app/controllers/admin/cash_transactions_controller.rb:58-67` vs `:69-87`; `app/controllers/admin/categories_controller.rb:33-38` vs `:40-72` **[I]**.
- **Who/what can resolve:** product owner (the feature is a privacy screen, not access control).
- **Human question?** yes (intent).
- **Proposed default:** keep parity (guard on GET pages only), document as privacy screen.

### U-522 `/up` health check does not check dependencies
- **What is unclear:** Whether deployment health checks rely on `/up` being a pure liveness probe.
- **Evidence for / against:** `config/routes.rb:21` (`rails/health#show` only verifies the app booted) **[I]**; **[V]** [oracle](../oracle/http/GET_up.json) 200 green page; `docs/adr/0014-self-hosted-deployment.md`.
- **Who/what can resolve:** operator.
- **Human question?** no.
- **Proposed default:** Kotlin `/up` = liveness (200 when the process serves requests), optional separate readiness endpoint checking PostgreSQL and Redis.

### U-523 Browser gate (`allow_browser versions: :modern`)
- **What is unclear:** Whether the Kotlin service must reject "legacy" browsers with 406, and with which thresholds (Rails `:modern` = browsers supporting webp, web push, badges, import maps, CSS nesting and `:has`).
- **Evidence for / against:** `app/controllers/application_controller.rb:2`; **[V]** [oracle](../oracle/http/GET_admin_analytics.json) case `legacy_browser_ua -> 406` (UA string not recorded in the oracle file).
- **Who/what can resolve:** product owner / UI owner.
- **Human question?** yes (scope).
- **Proposed default:** keep the gate for HTML routes with equivalent minimum versions (Chrome 120, Safari 17.2, Firefox 121, Opera 106, IE none; Rails 8 preset **[I]**), serving the same 406 page; requests without User-Agent pass.

### U-524 BUG? Foreign category ids accepted in merchant and hidden-category forms
- **What is unclear:** `merchant[default_category_id]` (`PATCH|PUT /admin/merchants/:id`, `POST /admin/merchants`) and `user[hidden_category_ids][]` (`PATCH /admin/settings/preferences/app`) are not checked to belong to the current user, so a tampered request can link a merchant to another tenant's category (whose name then shows up as the effective category) or create a hidden-category link to a foreign category.
- **Evidence for / against:** `app/controllers/admin/merchants_controller.rb:105-107`; `app/models/merchant.rb:49` (`belongs_to :default_category` without user check); `app/controllers/admin/settings/preferences_controller.rb:108-114`; `app/models/user_hidden_category.rb:28-31` **[I]** (not exercised). `User#hides_category?` re-scopes to the user's categories, limiting the second case.
- **Who/what can resolve:** reading/running.
- **Human question?** no.
- **Proposed default:** Kotlin validates that every referenced category id belongs to the user ("Default category must exist" -> 422 / ignore foreign hidden ids).

### U-525 Regex dialect of user merchant rules
- **What is unclear:** Rules of kind `regex` are validated and executed with Ruby (Onigmo) regular expressions; the Kotlin (Java) engine differs in syntax details (e.g. `\h`, `\A`/`\z` supported in both, but possessive/atomic groups, named groups `(?<name>)`, `\p{...}` classes and case-insensitive Unicode behave differently), so existing patterns may change meaning or become invalid.
- **Evidence for / against:** `app/models/merchant_rule.rb:62,88-95`; error message "Pattern is not a valid regex: <RegexpError message>" exposes engine-specific text.
- **Who/what can resolve:** running all stored patterns through the Kotlin engine during migration.
- **Human question?** no.
- **Proposed default:** validate stored patterns at migration time and report incompatible ones; error message "Pattern is not a valid regex: <engine message>".
