# 30 — HTTP API (every route)

> Every route of open-banking-rails at commit `cd3bf60`: Rails router (server-rendered admin UI, public/auth/framework routes) in **Part A**,
> REST API v1 (Grape), OpenAPI docs and the MCP server in **Part B**. Each route section gives verb, path, handler (`path:line`),
> authentication/authorisation, parameters and validation, responses/status codes, error format, and the **oracle sample** with the observed
> `case → status` list (`../oracle/http/<VERB>_<path>.json`; index: `../oracle/index.json`). **[V]** verified / **[I]** inferred.
> Source paths are relative to the repository root. Route inventory: `../inventory/routes_development.txt` (Rails, superset incl. dev-only),
> `../inventory/api_routes.json` (Grape), `../inventory/mcp_tools.json` (MCP).
> Business rules referenced by service name are in [20-business-rules.md](20-business-rules.md) (service catalogue at the end of each part).

> **Decisions apply.** Where Phase-4 decisions change behaviour for Kotlin, the [deviation register](decisions.md#deviation-register--where-the-kotlin-expectation-differs-from-the-ruby-oracle) (X-01…X-27) overrides the Ruby behaviour described here; unknowns carry a **Resolution** line ([unknowns.md](unknowns.md)).


## Part A — Server-rendered and public HTTP routes (Rails router)

This part documents every route served by the Rails router *outside* the Grape API (`/api/**`), the MCP endpoint (`/mcp`)
and the Grape mount itself (`MOUNT /`), which are documented in Part B. It covers the Devise authentication routes, first-run
setup, health check, the bank OAuth callback, the Sidekiq dashboard mount, all server-rendered `/admin/**` pages and form
endpoints (including the development-only `/admin/debug*` routes), the router-level redirects, the Turbo Native
"historical location" routes and the framework default routes (ActionMailbox, Rails Conductor, ActiveStorage).

Conventions used in this part:

- Source paths are relative to the source checkout `src/` (commit `cd3bf605`), e.g. `app/controllers/setup_controller.rb:12`.
  Spec references are `spec/...:LINE`; every spec cited here passed in the recorded run (`inventory/specs_run.json`, 825 examples, 0 failures),
  so an assertion by a cited spec is marked **[V]**.
- Oracle links point to `oracle/http/<VERB>_<path>.json` (capture in `RAILS_ENV=development`, two tenants "main" and "other",
  external adapters replaced by in-memory fakes). "main(session)" means a cookie session for tenant *main*.
- Business rules are referenced by owning service; BR id ranges: BR-001..199 identity/banking/sync, BR-200..299 classification/LLM,
  BR-300..399 cash/analytics. Exact BR ids are cross-linked later.
- Unknowns for this part: U-500..U-549 (fragment `unknowns-http-rails.md`).

### A.1 Summary of routes

Auth legend: **public** = no session required; **session** = Devise cookie session required (anonymous -> `302 /admin/sign_in`);
**+ CSRF** = Rails authenticity token required for the non-GET request; **dev only** = route is only drawn when `RAILS_ENV=development`
(`config/routes.rb:33-42`). The handler link jumps to the route section.

| Verb | Path | Handler | Auth | Oracle cases -> status |
|---|---|---|---|---|
| GET | `/admin/sign_in` | [`admin/sessions#new`](#route-get-admin-sign-in) | public | [default -> 200](../oracle/http/GET_admin_sign_in.json) |
| POST | `/admin/sign_in` | [`admin/sessions#create`](#route-post-admin-sign-in) | public + CSRF | [wrong_password -> 422; missing_csrf_token -> 422; valid_credentials -> 303](../oracle/http/POST_admin_sign_in.json) |
| DELETE | `/admin/sign_out` | [`admin/sessions#destroy`](#route-delete-admin-sign-out) | public + CSRF | [not_signed_in -> 401; signed_in -> 204](../oracle/http/DELETE_admin_sign_out.json) |
| GET | `/admin/password/new` | [`admin/passwords#new`](#route-get-admin-password-new) | public | [default -> 200](../oracle/http/GET_admin_password_new.json) |
| GET | `/admin/password/edit` | [`admin/passwords#edit`](#route-get-admin-password-edit) | public (token) | [no_token -> 302; bogus_token -> 200](../oracle/http/GET_admin_password_edit.json) |
| PATCH | `/admin/password` | [`admin/passwords#update`](#route-patch-admin-password) | public + CSRF | [bogus_token -> 422](../oracle/http/PATCH_admin_password.json) |
| PUT | `/admin/password` | [`admin/passwords#update`](#route-put-admin-password) | public + CSRF | [bogus_token -> 422](../oracle/http/PUT_admin_password.json) |
| POST | `/admin/password` | [`admin/passwords#create`](#route-post-admin-password) | public + CSRF | [unknown_email -> 422; known_email -> 303](../oracle/http/POST_admin_password.json) |
| MOUNT | `/sidekiq` | [`Sidekiq::Web (Rack app)`](#route-mount-sidekiq) | session (routing constraint) | [anonymous -> 302; authenticated -> 200](../oracle/http/GET_sidekiq.json) |
| GET | `/setup` | [`setup#new`](#route-get-setup) | public, only while no users | [users_exist -> 302; no_users -> 200](../oracle/http/GET_setup.json) |
| POST | `/setup` | [`setup#create`](#route-post-setup) | public, only while no users + CSRF | [users_exist -> 302; no_users_invalid -> 422; no_users_valid -> 302](../oracle/http/POST_setup.json) |
| GET | `/up` | [`rails/health#show`](#route-get-up) | public | [default -> 200](../oracle/http/GET_up.json) |
| GET | `/callback` | [`oauth_callbacks#enable_banking`](#route-get-callback) | session | [anonymous_no_params -> 302; bank_error_param -> 302; invalid_state -> 302; missing_state -> 302](../oracle/http/GET_callback.json) |
| GET | `/admin/debug` | [`admin/debug#index`](#route-get-admin-debug) | session; dev only | [default -> 200](../oracle/http/GET_admin_debug.json) |
| GET | `/admin/debug/runtime_error` | [`admin/debug#runtime_error`](#route-get-admin-debug-runtime-error) | session; dev only | [default -> 500](../oracle/http/GET_admin_debug_runtime_error.json) |
| GET | `/admin/debug/zero_division` | [`admin/debug#zero_division`](#route-get-admin-debug-zero-division) | session; dev only | [default -> 500](../oracle/http/GET_admin_debug_zero_division.json) |
| GET | `/admin/debug/argument_error` | [`admin/debug#argument_error`](#route-get-admin-debug-argument-error) | session; dev only | [default -> 500](../oracle/http/GET_admin_debug_argument_error.json) |
| GET | `/admin/debug/nested_error` | [`admin/debug#nested_error`](#route-get-admin-debug-nested-error) | session; dev only | [default -> 500](../oracle/http/GET_admin_debug_nested_error.json) |
| POST | `/admin/debug/enqueue_failing_job` | [`admin/debug#enqueue_failing_job`](#route-post-admin-debug-enqueue-failing-job) | session + CSRF; dev only | [default -> 204](../oracle/http/POST_admin_debug_enqueue_failing_job.json) |
| GET | `/admin` | [`redirect 301 -> /admin/analytics`](#route-get-admin) | none (router) | [default -> 301; default -> 301](../oracle/http/GET_admin.json) |
| GET | `/admin/styleguide` | [`admin/styleguide#index`](#route-get-admin-styleguide) | session | [default -> 200](../oracle/http/GET_admin_styleguide.json) |
| POST | `/admin/onboarding/seed_taxonomy` | [`admin/onboarding#seed_taxonomy`](#route-post-admin-onboarding-seed-taxonomy) | session + CSRF | [default -> 302](../oracle/http/POST_admin_onboarding_seed_taxonomy.json) |
| GET | `/admin/versions` | [`admin/versions#index`](#route-get-admin-versions) | session | [default -> 200; other_tenant_sees_all_versions -> 200](../oracle/http/GET_admin_versions.json) |
| GET | `/admin/versions/:id` | [`admin/versions#show`](#route-get-admin-versions-id) | session | [default -> 200; other_tenant_reads_main_version -> 200](../oracle/http/GET_admin_versions__id.json) |
| PATCH | `/admin/bank_transactions/:bank_transaction_id/enrichment` | [`admin/transaction_enrichments#update`](#route-patch-admin-bank-transactions-bank-transaction-id-enrichment) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json) |
| PUT | `/admin/bank_transactions/:bank_transaction_id/enrichment` | [`admin/transaction_enrichments#update`](#route-put-admin-bank-transactions-bank-transaction-id-enrichment) | session + CSRF | [create_rule_missing_fields -> 302](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json) |
| GET | `/admin/bank_transactions` | [`admin/bank_transactions#index`](#route-get-admin-bank-transactions) | session | [default -> 200; filtered -> 200](../oracle/http/GET_admin_bank_transactions.json) |
| GET | `/admin/bank_transactions/:id` | [`admin/bank_transactions#show`](#route-get-admin-bank-transactions-id) | session | [default -> 200; other_tenant_id -> 404](../oracle/http/GET_admin_bank_transactions__id.json) |
| GET | `/admin/cash_transactions` | [`admin/cash_transactions#index`](#route-get-admin-cash-transactions) | session | [default -> 200](../oracle/http/GET_admin_cash_transactions.json) |
| POST | `/admin/cash_transactions` | [`admin/cash_transactions#create`](#route-post-admin-cash-transactions) | session + CSRF | [default -> 302; invalid_amount -> 422](../oracle/http/POST_admin_cash_transactions.json) |
| GET | `/admin/cash_transactions/new` | [`admin/cash_transactions#new`](#route-get-admin-cash-transactions-new) | session | [default -> 200; credit -> 200](../oracle/http/GET_admin_cash_transactions_new.json) |
| GET | `/admin/cash_transactions/:id/edit` | [`admin/cash_transactions#edit`](#route-get-admin-cash-transactions-id-edit) | session | [default -> 302](../oracle/http/GET_admin_cash_transactions__id_edit.json) |
| GET | `/admin/cash_transactions/:id` | [`admin/cash_transactions#show`](#route-get-admin-cash-transactions-id) | session | [default -> 302; other_tenant_id -> 404](../oracle/http/GET_admin_cash_transactions__id.json) |
| PATCH | `/admin/cash_transactions/:id` | [`admin/cash_transactions#update`](#route-patch-admin-cash-transactions-id) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_cash_transactions__id.json) |
| PUT | `/admin/cash_transactions/:id` | [`admin/cash_transactions#update`](#route-put-admin-cash-transactions-id) | session + CSRF | [invalid_amount -> 422](../oracle/http/PUT_admin_cash_transactions__id.json) |
| DELETE | `/admin/cash_transactions/:id` | [`admin/cash_transactions#destroy`](#route-delete-admin-cash-transactions-id) | session + CSRF | [default -> 302](../oracle/http/DELETE_admin_cash_transactions__id.json) |
| POST | `/admin/categories/:id/archive` | [`admin/categories#archive`](#route-post-admin-categories-id-archive) | session + CSRF | [default -> 302](../oracle/http/POST_admin_categories__id_archive.json) |
| POST | `/admin/categories/:id/unarchive` | [`admin/categories#unarchive`](#route-post-admin-categories-id-unarchive) | session + CSRF | [default -> 302](../oracle/http/POST_admin_categories__id_unarchive.json) |
| GET | `/admin/categories` | [`admin/categories#index`](#route-get-admin-categories) | session | [default -> 200](../oracle/http/GET_admin_categories.json) |
| POST | `/admin/categories` | [`admin/categories#create`](#route-post-admin-categories) | session + CSRF | [default -> 302; invalid_blank_name -> 422; missing_csrf_token -> 422](../oracle/http/POST_admin_categories.json) |
| GET | `/admin/categories/new` | [`admin/categories#new`](#route-get-admin-categories-new) | session | [default -> 200](../oracle/http/GET_admin_categories_new.json) |
| GET | `/admin/categories/:id/edit` | [`admin/categories#edit`](#route-get-admin-categories-id-edit) | session | [default -> 200; other_tenant_id -> 404](../oracle/http/GET_admin_categories__id_edit.json) |
| PATCH | `/admin/categories/:id` | [`admin/categories#update`](#route-patch-admin-categories-id) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_categories__id.json) |
| PUT | `/admin/categories/:id` | [`admin/categories#update`](#route-put-admin-categories-id) | session + CSRF | [invalid_kind -> 422](../oracle/http/PUT_admin_categories__id.json) |
| DELETE | `/admin/categories/:id` | [`admin/categories#destroy`](#route-delete-admin-categories-id) | session + CSRF | [other_tenant_id -> 404; default -> 302](../oracle/http/DELETE_admin_categories__id.json) |
| POST | `/admin/merchants/:id/archive` | [`admin/merchants#archive`](#route-post-admin-merchants-id-archive) | session + CSRF | [default -> 302](../oracle/http/POST_admin_merchants__id_archive.json) |
| POST | `/admin/merchants/:id/unarchive` | [`admin/merchants#unarchive`](#route-post-admin-merchants-id-unarchive) | session + CSRF | [default -> 302](../oracle/http/POST_admin_merchants__id_unarchive.json) |
| POST | `/admin/merchants/:id/approve` | [`admin/merchants#approve`](#route-post-admin-merchants-id-approve) | session + CSRF | [default -> 302](../oracle/http/POST_admin_merchants__id_approve.json) |
| POST | `/admin/merchants/:merchant_id/merchant_rules` | [`admin/merchant_rules#create`](#route-post-admin-merchants-merchant-id-merchant-rules) | session + CSRF | [default -> 302; invalid_regex -> 302](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json) |
| PATCH | `/admin/merchants/:merchant_id/merchant_rules/:id` | [`admin/merchant_rules#update`](#route-patch-admin-merchants-merchant-id-merchant-rules-id) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_merchants__merchant_id_merchant_rules__id.json) |
| PUT | `/admin/merchants/:merchant_id/merchant_rules/:id` | [`admin/merchant_rules#update`](#route-put-admin-merchants-merchant-id-merchant-rules-id) | session + CSRF | [invalid_blank_pattern -> 302](../oracle/http/PUT_admin_merchants__merchant_id_merchant_rules__id.json) |
| DELETE | `/admin/merchants/:merchant_id/merchant_rules/:id` | [`admin/merchant_rules#destroy`](#route-delete-admin-merchants-merchant-id-merchant-rules-id) | session + CSRF | [default -> 302](../oracle/http/DELETE_admin_merchants__merchant_id_merchant_rules__id.json) |
| GET | `/admin/merchants` | [`admin/merchants#index`](#route-get-admin-merchants) | session | [default -> 200; filtered -> 200](../oracle/http/GET_admin_merchants.json) |
| POST | `/admin/merchants` | [`admin/merchants#create`](#route-post-admin-merchants) | session + CSRF | [default -> 302; invalid_blank_name -> 422](../oracle/http/POST_admin_merchants.json) |
| GET | `/admin/merchants/new` | [`admin/merchants#new`](#route-get-admin-merchants-new) | session | [default -> 200](../oracle/http/GET_admin_merchants_new.json) |
| GET | `/admin/merchants/:id/edit` | [`admin/merchants#edit`](#route-get-admin-merchants-id-edit) | session | [default -> 200](../oracle/http/GET_admin_merchants__id_edit.json) |
| GET | `/admin/merchants/:id` | [`admin/merchants#show`](#route-get-admin-merchants-id) | session | [default -> 200; other_tenant_id -> 404](../oracle/http/GET_admin_merchants__id.json) |
| PATCH | `/admin/merchants/:id` | [`admin/merchants#update`](#route-patch-admin-merchants-id) | session + CSRF | [default -> 302; other_tenant_id -> 404](../oracle/http/PATCH_admin_merchants__id.json) |
| PUT | `/admin/merchants/:id` | [`admin/merchants#update`](#route-put-admin-merchants-id) | session + CSRF | [invalid_blank_name -> 422](../oracle/http/PUT_admin_merchants__id.json) |
| DELETE | `/admin/merchants/:id` | [`admin/merchants#destroy`](#route-delete-admin-merchants-id) | session + CSRF | [default -> 302](../oracle/http/DELETE_admin_merchants__id.json) |
| GET | `/admin/llm_enrichments` | [`admin/llm_enrichments#index`](#route-get-admin-llm-enrichments) | session | [default -> 200](../oracle/http/GET_admin_llm_enrichments.json) |
| POST | `/admin/llm_enrichments` | [`admin/llm_enrichments#create`](#route-post-admin-llm-enrichments) | session + CSRF | [default -> 302](../oracle/http/POST_admin_llm_enrichments.json) |
| GET | `/admin/llm_enrichments/:id` | [`admin/llm_enrichments#show`](#route-get-admin-llm-enrichments-id) | session | [default -> 200](../oracle/http/GET_admin_llm_enrichments__id.json) |
| GET | `/admin/analytics` | [`admin/analytics/dashboard#index`](#route-get-admin-analytics) | session | [anonymous_redirects_to_sign_in -> 302; legacy_browser_ua -> 406; default -> 200; explicit_range -> 200; no_users_redirects_to_setup -> 302](../oracle/http/GET_admin_analytics.json) |
| GET | `/admin/analytics/categories/:slug` | [`admin/analytics/categories#show`](#route-get-admin-analytics-categories-slug) | session | [default -> 200; unknown_slug -> 404](../oracle/http/GET_admin_analytics_categories__slug.json) |
| GET | `/admin/analytics/merchants/:slug` | [`admin/analytics/merchants#show`](#route-get-admin-analytics-merchants-slug) | session | [default -> 200](../oracle/http/GET_admin_analytics_merchants__slug.json) |
| GET | `/admin/matching_engine` | [`admin/matching_engine#show`](#route-get-admin-matching-engine) | session | [default -> 200](../oracle/http/GET_admin_matching_engine.json) |
| GET | `/admin/transaction_syncs` | [`admin/transaction_syncs#index`](#route-get-admin-transaction-syncs) | session | [default -> 200](../oracle/http/GET_admin_transaction_syncs.json) |
| POST | `/admin/transaction_syncs` | [`admin/transaction_syncs#create`](#route-post-admin-transaction-syncs) | session + CSRF | [default -> 302; missing_connection -> 302](../oracle/http/POST_admin_transaction_syncs.json) |
| GET | `/admin/transaction_syncs/new` | [`admin/transaction_syncs#new`](#route-get-admin-transaction-syncs-new) | session | [default -> 200](../oracle/http/GET_admin_transaction_syncs_new.json) |
| GET | `/admin/transaction_syncs/:id` | [`admin/transaction_syncs#show`](#route-get-admin-transaction-syncs-id) | session | [default -> 200](../oracle/http/GET_admin_transaction_syncs__id.json) |
| POST | `/admin/tpp_credentials/:id/test_connection` | [`admin/tpp_credentials#test_connection`](#route-post-admin-tpp-credentials-id-test-connection) | session + CSRF | [default -> 302](../oracle/http/POST_admin_tpp_credentials__id_test_connection.json) |
| POST | `/admin/tpp_credentials/:id/make_primary` | [`admin/tpp_credentials#make_primary`](#route-post-admin-tpp-credentials-id-make-primary) | session + CSRF | [default -> 302](../oracle/http/POST_admin_tpp_credentials__id_make_primary.json) |
| GET | `/admin/tpp_credentials` | [`admin/tpp_credentials#index`](#route-get-admin-tpp-credentials) | session | [default -> 200](../oracle/http/GET_admin_tpp_credentials.json) |
| POST | `/admin/tpp_credentials` | [`admin/tpp_credentials#create`](#route-post-admin-tpp-credentials) | session + CSRF | [default -> 302; invalid_blank_name -> 422](../oracle/http/POST_admin_tpp_credentials.json) |
| GET | `/admin/tpp_credentials/new` | [`admin/tpp_credentials#new`](#route-get-admin-tpp-credentials-new) | session | [default -> 200](../oracle/http/GET_admin_tpp_credentials_new.json) |
| GET | `/admin/tpp_credentials/:id/edit` | [`admin/tpp_credentials#edit`](#route-get-admin-tpp-credentials-id-edit) | session | [default -> 200](../oracle/http/GET_admin_tpp_credentials__id_edit.json) |
| GET | `/admin/tpp_credentials/:id` | [`admin/tpp_credentials#show`](#route-get-admin-tpp-credentials-id) | session | [default -> 200; other_tenant_id -> 404](../oracle/http/GET_admin_tpp_credentials__id.json) |
| PATCH | `/admin/tpp_credentials/:id` | [`admin/tpp_credentials#update`](#route-patch-admin-tpp-credentials-id) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_tpp_credentials__id.json) |
| PUT | `/admin/tpp_credentials/:id` | [`admin/tpp_credentials#update`](#route-put-admin-tpp-credentials-id) | session + CSRF | [invalid_environment -> 422](../oracle/http/PUT_admin_tpp_credentials__id.json) |
| DELETE | `/admin/tpp_credentials/:id` | [`admin/tpp_credentials#destroy`](#route-delete-admin-tpp-credentials-id) | session + CSRF | [default -> 302](../oracle/http/DELETE_admin_tpp_credentials__id.json) |
| POST | `/admin/bank_connections/:id/refresh` | [`admin/bank_connections#refresh`](#route-post-admin-bank-connections-id-refresh) | session + CSRF | [default -> 302](../oracle/http/POST_admin_bank_connections__id_refresh.json) |
| POST | `/admin/bank_connections/:id/reauth` | [`admin/bank_connections#reauth`](#route-post-admin-bank-connections-id-reauth) | session + CSRF | [default -> 302](../oracle/http/POST_admin_bank_connections__id_reauth.json) |
| GET | `/admin/bank_connections/:bank_connection_id/sync_schedule/edit` | [`admin/sync_schedules#edit`](#route-get-admin-bank-connections-bank-connection-id-sync-schedule-edit) | session | [default -> 200](../oracle/http/GET_admin_bank_connections__bank_connection_id_sync_schedule_edit.json) |
| PATCH | `/admin/bank_connections/:bank_connection_id/sync_schedule` | [`admin/sync_schedules#update`](#route-patch-admin-bank-connections-bank-connection-id-sync-schedule) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_bank_connections__bank_connection_id_sync_schedule.json) |
| PUT | `/admin/bank_connections/:bank_connection_id/sync_schedule` | [`admin/sync_schedules#update`](#route-put-admin-bank-connections-bank-connection-id-sync-schedule) | session + CSRF | [invalid -> 422](../oracle/http/PUT_admin_bank_connections__bank_connection_id_sync_schedule.json) |
| GET | `/admin/bank_connections` | [`admin/bank_connections#index`](#route-get-admin-bank-connections) | session | [default -> 200](../oracle/http/GET_admin_bank_connections.json) |
| POST | `/admin/bank_connections` | [`admin/bank_connections#create`](#route-post-admin-bank-connections) | session + CSRF | [default -> 303; invalid_blank_aspsp -> 204](../oracle/http/POST_admin_bank_connections.json) |
| GET | `/admin/bank_connections/new` | [`admin/bank_connections#new`](#route-get-admin-bank-connections-new) | session | [default -> 200; with_aspsp -> 200](../oracle/http/GET_admin_bank_connections_new.json) |
| GET | `/admin/bank_connections/:id/edit` | [`admin/bank_connections#edit`](#route-get-admin-bank-connections-id-edit) | session | [default -> 200](../oracle/http/GET_admin_bank_connections__id_edit.json) |
| GET | `/admin/bank_connections/:id` | [`admin/bank_connections#show`](#route-get-admin-bank-connections-id) | session | [default -> 200; other_tenant_id -> 404](../oracle/http/GET_admin_bank_connections__id.json) |
| PATCH | `/admin/bank_connections/:id` | [`admin/bank_connections#update`](#route-patch-admin-bank-connections-id) | session + CSRF | [default -> 422](../oracle/http/PATCH_admin_bank_connections__id.json) |
| PUT | `/admin/bank_connections/:id` | [`admin/bank_connections#update`](#route-put-admin-bank-connections-id) | session + CSRF | [invalid_status -> 422](../oracle/http/PUT_admin_bank_connections__id.json) |
| DELETE | `/admin/bank_connections/:id` | [`admin/bank_connections#destroy`](#route-delete-admin-bank-connections-id) | session + CSRF | [other_tenant_id -> 404; own_connection -> 302](../oracle/http/DELETE_admin_bank_connections__id.json) |
| POST | `/admin/bank_accounts/:id/refresh_details` | [`admin/bank_accounts#refresh_details`](#route-post-admin-bank-accounts-id-refresh-details) | session + CSRF | [default -> 302](../oracle/http/POST_admin_bank_accounts__id_refresh_details.json) |
| POST | `/admin/bank_accounts/:id/refresh_balances` | [`admin/bank_accounts#refresh_balances`](#route-post-admin-bank-accounts-id-refresh-balances) | session + CSRF | [default -> 302](../oracle/http/POST_admin_bank_accounts__id_refresh_balances.json) |
| GET | `/admin/bank_accounts` | [`admin/bank_accounts#index`](#route-get-admin-bank-accounts) | session | [default -> 200](../oracle/http/GET_admin_bank_accounts.json) |
| GET | `/admin/bank_accounts/:id` | [`admin/bank_accounts#show`](#route-get-admin-bank-accounts-id) | session | [default -> 200](../oracle/http/GET_admin_bank_accounts__id.json) |
| GET | `/admin/settings` | [`redirect 301 -> /admin/settings/preferences`](#route-get-admin-settings) | none (router) | [default -> 301](../oracle/http/GET_admin_settings.json) |
| GET | `/admin/settings/preferences` | [`redirect 301 -> /admin/settings/preferences/profile`](#route-get-admin-settings-preferences) | none (router) | [default -> 301](../oracle/http/GET_admin_settings_preferences.json) |
| GET | `/admin/settings/preferences/profile` | [`admin/settings/preferences#profile`](#route-get-admin-settings-preferences-profile) | session | [default -> 200](../oracle/http/GET_admin_settings_preferences_profile.json) |
| PATCH | `/admin/settings/preferences/profile` | [`admin/settings/preferences#update_profile`](#route-patch-admin-settings-preferences-profile) | session + CSRF | [default -> 302; invalid_blank_name -> 422](../oracle/http/PATCH_admin_settings_preferences_profile.json) |
| PATCH | `/admin/settings/preferences/password` | [`admin/settings/preferences#update_password`](#route-patch-admin-settings-preferences-password) | session + CSRF | [wrong_current_password -> 422; too_short -> 422](../oracle/http/PATCH_admin_settings_preferences_password.json) |
| GET | `/admin/settings/preferences/app` | [`admin/settings/preferences#app`](#route-get-admin-settings-preferences-app) | session | [default -> 200](../oracle/http/GET_admin_settings_preferences_app.json) |
| PATCH | `/admin/settings/preferences/app` | [`admin/settings/preferences#update_app`](#route-patch-admin-settings-preferences-app) | session + CSRF | [default -> 302](../oracle/http/PATCH_admin_settings_preferences_app.json) |
| GET | `/admin/settings/preferences/llm` | [`admin/settings/preferences#llm`](#route-get-admin-settings-preferences-llm) | session | [default -> 200](../oracle/http/GET_admin_settings_preferences_llm.json) |
| PATCH | `/admin/settings/preferences/llm` | [`admin/settings/preferences#update_llm`](#route-patch-admin-settings-preferences-llm) | session + CSRF | [default -> 302; invalid_provider -> 500](../oracle/http/PATCH_admin_settings_preferences_llm.json) |
| POST | `/admin/settings/preferences/llm/test` | [`admin/settings/preferences#test_llm`](#route-post-admin-settings-preferences-llm-test) | session + CSRF | [default -> 302](../oracle/http/POST_admin_settings_preferences_llm_test.json) |
| GET | `/admin/settings/preferences/data_exchange` | [`admin/settings/data_exchange#show`](#route-get-admin-settings-preferences-data-exchange) | session | [default -> 200](../oracle/http/GET_admin_settings_preferences_data_exchange.json) |
| POST | `/admin/settings/preferences/data_exchange/export` | [`admin/settings/data_exchange#export`](#route-post-admin-settings-preferences-data-exchange-export) | session + CSRF | [default -> 200; blank_passphrase -> 302](../oracle/http/POST_admin_settings_preferences_data_exchange_export.json) |
| POST | `/admin/settings/preferences/data_exchange/import` | [`admin/settings/data_exchange#import`](#route-post-admin-settings-preferences-data-exchange-import) | session + CSRF | [missing_bundle -> 302; garbage_bundle -> 302](../oracle/http/POST_admin_settings_preferences_data_exchange_import.json) |
| GET | `/admin/settings/preferences/api_tokens` | [`admin/settings/api_tokens#index`](#route-get-admin-settings-preferences-api-tokens) | session | [default -> 200](../oracle/http/GET_admin_settings_preferences_api_tokens.json) |
| POST | `/admin/settings/preferences/api_tokens` | [`admin/settings/api_tokens#create`](#route-post-admin-settings-preferences-api-tokens) | session + CSRF | [default -> 302; invalid_blank_name -> 422](../oracle/http/POST_admin_settings_preferences_api_tokens.json) |
| DELETE | `/admin/settings/preferences/api_tokens/:id` | [`admin/settings/api_tokens#destroy`](#route-delete-admin-settings-preferences-api-tokens-id) | session + CSRF | [first_delete_revokes -> 302; second_delete_destroys_revoked -> 302](../oracle/http/DELETE_admin_settings_preferences_api_tokens__id.json) |
| GET | `/` | [`redirect 301 -> /admin`](#route-get-root) | none (router) | [default -> 301](../oracle/http/GET_root.json) |
| GET | `/recede_historical_location` | [`turbo/native/navigation#recede`](#route-get-recede-historical-location) | public (framework) | [default -> 200](../oracle/http/GET_recede_historical_location.json) |
| GET | `/resume_historical_location` | [`turbo/native/navigation#resume`](#route-get-resume-historical-location) | public (framework) | [default -> 200](../oracle/http/GET_resume_historical_location.json) |
| GET | `/refresh_historical_location` | [`turbo/native/navigation#refresh`](#route-get-refresh-historical-location) | public (framework) | [default -> 200](../oracle/http/GET_refresh_historical_location.json) |
| POST | `/rails/action_mailbox/postmark/inbound_emails` | [`action_mailbox/ingresses/postmark/inbound_emails#create`](#route-post-rails-action-mailbox-postmark-inbound-emails) | public (framework) | [default -> 404](../oracle/http/POST_rails_action_mailbox_postmark_inbound_emails.json) |
| POST | `/rails/action_mailbox/relay/inbound_emails` | [`action_mailbox/ingresses/relay/inbound_emails#create`](#route-post-rails-action-mailbox-relay-inbound-emails) | public (framework) | [default -> 404](../oracle/http/POST_rails_action_mailbox_relay_inbound_emails.json) |
| POST | `/rails/action_mailbox/sendgrid/inbound_emails` | [`action_mailbox/ingresses/sendgrid/inbound_emails#create`](#route-post-rails-action-mailbox-sendgrid-inbound-emails) | public (framework) | [default -> 404](../oracle/http/POST_rails_action_mailbox_sendgrid_inbound_emails.json) |
| GET | `/rails/action_mailbox/mandrill/inbound_emails` | [`action_mailbox/ingresses/mandrill/inbound_emails#health_check`](#route-get-rails-action-mailbox-mandrill-inbound-emails) | public (framework) | [default -> 404](../oracle/http/GET_rails_action_mailbox_mandrill_inbound_emails.json) |
| POST | `/rails/action_mailbox/mandrill/inbound_emails` | [`action_mailbox/ingresses/mandrill/inbound_emails#create`](#route-post-rails-action-mailbox-mandrill-inbound-emails) | public (framework) | [default -> 404](../oracle/http/POST_rails_action_mailbox_mandrill_inbound_emails.json) |
| POST | `/rails/action_mailbox/mailgun/inbound_emails/mime` | [`action_mailbox/ingresses/mailgun/inbound_emails#create`](#route-post-rails-action-mailbox-mailgun-inbound-emails-mime) | public (framework) | [default -> 404](../oracle/http/POST_rails_action_mailbox_mailgun_inbound_emails_mime.json) |
| GET | `/rails/conductor/action_mailbox/inbound_emails` | [`rails/conductor/action_mailbox/inbound_emails#index`](#route-get-rails-conductor-action-mailbox-inbound-emails) | public (framework) | [default -> 500](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails.json) |
| POST | `/rails/conductor/action_mailbox/inbound_emails` | [`rails/conductor/action_mailbox/inbound_emails#create`](#route-post-rails-conductor-action-mailbox-inbound-emails) | public (framework) | [no_csrf -> 422](../oracle/http/POST_rails_conductor_action_mailbox_inbound_emails.json) |
| GET | `/rails/conductor/action_mailbox/inbound_emails/new` | [`rails/conductor/action_mailbox/inbound_emails#new`](#route-get-rails-conductor-action-mailbox-inbound-emails-new) | public (framework) | [default -> 200](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails_new.json) |
| GET | `/rails/conductor/action_mailbox/inbound_emails/:id` | [`rails/conductor/action_mailbox/inbound_emails#show`](#route-get-rails-conductor-action-mailbox-inbound-emails-id) | public (framework) | [default -> 500](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails__id.json) |
| GET | `/rails/conductor/action_mailbox/inbound_emails/sources/new` | [`rails/conductor/action_mailbox/inbound_emails/sources#new`](#route-get-rails-conductor-action-mailbox-inbound-emails-sources-new) | public (framework) | [default -> 200](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails_sources_new.json) |
| POST | `/rails/conductor/action_mailbox/inbound_emails/sources` | [`rails/conductor/action_mailbox/inbound_emails/sources#create`](#route-post-rails-conductor-action-mailbox-inbound-emails-sources) | public (framework) | [no_csrf -> 422](../oracle/http/POST_rails_conductor_action_mailbox_inbound_emails_sources.json) |
| POST | `/rails/conductor/action_mailbox/:inbound_email_id/reroute` | [`rails/conductor/action_mailbox/reroutes#create`](#route-post-rails-conductor-action-mailbox-inbound-email-id-reroute) | public (framework) | [no_csrf -> 422](../oracle/http/POST_rails_conductor_action_mailbox__inbound_email_id_reroute.json) |
| POST | `/rails/conductor/action_mailbox/:inbound_email_id/incinerate` | [`rails/conductor/action_mailbox/incinerates#create`](#route-post-rails-conductor-action-mailbox-inbound-email-id-incinerate) | public (framework) | [no_csrf -> 422](../oracle/http/POST_rails_conductor_action_mailbox__inbound_email_id_incinerate.json) |
| GET | `/rails/active_storage/blobs/redirect/:signed_id/*filename` | [`active_storage/blobs/redirect#show`](#route-get-rails-active-storage-blobs-redirect-signed-id-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_blobs_redirect__signed_id__filename.json) |
| GET | `/rails/active_storage/blobs/proxy/:signed_id/*filename` | [`active_storage/blobs/proxy#show`](#route-get-rails-active-storage-blobs-proxy-signed-id-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_blobs_proxy__signed_id__filename.json) |
| GET | `/rails/active_storage/blobs/:signed_id/*filename` | [`active_storage/blobs/redirect#show`](#route-get-rails-active-storage-blobs-signed-id-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_blobs__signed_id__filename.json) |
| GET | `/rails/active_storage/representations/redirect/:signed_blob_id/:variation_key/*filename` | [`active_storage/representations/redirect#show`](#route-get-rails-active-storage-representations-redirect-signed-blob-id-variation-key-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_representations_redirect__signed_blob_id__variation_key__filename.json) |
| GET | `/rails/active_storage/representations/proxy/:signed_blob_id/:variation_key/*filename` | [`active_storage/representations/proxy#show`](#route-get-rails-active-storage-representations-proxy-signed-blob-id-variation-key-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_representations_proxy__signed_blob_id__variation_key__filename.json) |
| GET | `/rails/active_storage/representations/:signed_blob_id/:variation_key/*filename` | [`active_storage/representations/redirect#show`](#route-get-rails-active-storage-representations-signed-blob-id-variation-key-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_representations__signed_blob_id__variation_key__filename.json) |
| GET | `/rails/active_storage/disk/:encoded_key/*filename` | [`active_storage/disk#show`](#route-get-rails-active-storage-disk-encoded-key-filename) | public (framework) | [bogus_signed_id -> 404](../oracle/http/GET_rails_active_storage_disk__encoded_key__filename.json) |
| PUT | `/rails/active_storage/disk/:encoded_token` | [`active_storage/disk#update`](#route-put-rails-active-storage-disk-encoded-token) | public (framework) | [bogus_token -> 404](../oracle/http/PUT_rails_active_storage_disk__encoded_token.json) |
| POST | `/rails/active_storage/direct_uploads` | [`active_storage/direct_uploads#create`](#route-post-rails-active-storage-direct-uploads) | public (framework) | [no_csrf -> 422](../oracle/http/POST_rails_active_storage_direct_uploads.json) |

Counts: 141 route keys in this part (115 application routes incl. 6 development-only and the Sidekiq mount, 3 Turbo Native routes, 23 framework default
routes). The development router contains 6 routes more than the test router (the `/admin/debug*` group), see
`inventory/routes_development.txt` vs `inventory/routes.txt`. **[V]**

### A.2 Cross-cutting behaviour of all Rails-rendered routes

These rules apply to every route of this part unless the route section says otherwise. Route sections refer to them as C1..C14.

| # | Rule | Evidence |
|---|---|---|
| C1 | **Modern-browser gate.** Every controller inheriting from `ApplicationController` (all `/admin/**`, `/setup`, `/callback`, and the Devise controllers, whose parent is `ApplicationController` by Devise default) runs `allow_browser versions: :modern` *before* any other filter. A request whose `User-Agent` is classified as a legacy browser gets **406** with the static page `public/406-unsupported-browser.html` (title "Your browser is not supported (406 Not Acceptable)", text "Your browser is not supported. Please upgrade your browser to continue."). The check runs before authentication: an anonymous legacy browser gets 406, not a sign-in redirect. Requests without a User-Agent are not blocked (the capture client passed). Not applied to `/up`, `/sidekiq`, the Turbo Native routes or the framework routes (they do not inherit `ApplicationController`). | `app/controllers/application_controller.rb:2`; **[V]** [oracle](../oracle/http/GET_admin_analytics.json) case `legacy_browser_ua -> 406`; exact UA classification thresholds **[I]** (Rails `:modern` preset) (see U-523) |
| C2 | **First-run redirect.** If the `users` table is empty, every request handled by an `ApplicationController` descendant is redirected **302 -> `/setup`**, except a request whose path is exactly `/setup` (or `/up`, which does not reach this filter anyway). This runs before authentication, so on an empty instance `/admin/analytics` and `/admin/sign_in` both go to `/setup`. Router-level redirects (`/`, `/admin`, `/admin/settings`, `/admin/settings/preferences`) are not controllers and still emit their 301 first. | `app/controllers/application_controller.rb:5,9-15`; ADR `docs/adr/0011-first-run-setup.md`; **[V]** [oracle](../oracle/http/GET_admin_analytics.json) case `no_users_redirects_to_setup -> 302` (Location `/setup`); `spec/system/first_run_setup_spec.rb:16` |
| C3 | **Authentication.** All `/admin/**` controllers (except the Devise sessions/passwords controllers) require a Devise session (`before_action :authenticate_user!`). Anonymous request -> **302 -> `/admin/sign_in`** with flash alert "You need to sign in or sign up before continuing."; for GET HTML requests the original URL is stored in the session and used as the post-sign-in redirect target (see `POST /admin/sign_in`). There is no session timeout (Devise `:timeoutable` not enabled) and no account lockout (`:lockable` not enabled). Remember-me (`:rememberable`) uses the Devise default duration of 2 weeks; all remember-me cookies are expired on sign-out (see U-520). | `app/controllers/admin/base_controller.rb:10`; `app/models/user.rb:23`; `config/initializers/devise.rb:170,173,194`; **[V]** [oracle](../oracle/http/GET_admin_analytics.json) case `anonymous_redirects_to_sign_in -> 302`; flash text **[V]** observed in `oracle/ui/mobile_admin_analytics_dashboard.html`; `spec/requests/meta_spec.rb:294`, `spec/system/smoke/auth_spec.rb:12-28`; remember duration **[I]** |
| C4 | **Session cookie.** Cookie name `_open_banking_rails_session`, attributes `path=/; httponly; samesite=lax` (plus `secure` in production when `FORCE_SSL` is not `"false"`, default `true`). The session is the Rails signed+encrypted cookie store (no server-side session table). | **[V]** set-cookie header in [oracle](../oracle/http/POST_admin_sign_in.json); `config/environments/production.rb:31` **[I]** |
| C5 | **CSRF.** Every non-GET request handled by a controller (all POST/PATCH/PUT/DELETE in this part, including Devise and framework controllers) must carry a valid authenticity token, either the form field `authenticity_token` or the header `X-CSRF-Token` (value from `<meta name="csrf-token">`). Missing/invalid token raises `ActionController::InvalidAuthenticityToken` -> **422**: in development the exception page (title "Action Controller: Exception caught"), in production the static `public/422.html`. No controller in the application skips forgery protection. The Rack-mounted `/sidekiq` app has its own protection. | **[V]** [oracle](../oracle/http/POST_admin_categories.json) case `missing_csrf_token -> 422`, [oracle](../oracle/http/POST_admin_sign_in.json) case `missing_csrf_token -> 422`; no `skip_forgery_protection` in `app/controllers` **[I]** |
| C6 | **HTTP method override.** HTML forms submit `POST` with a hidden `_method=patch|put|delete`; Turbo (`data-turbo-method`) does the same for links/buttons. `PATCH` and `PUT` on the same path are routed to the same action and behave identically. | `config/routes.rb` (resources) **[I]**; **[V]** PATCH and PUT twins observed with identical status semantics, e.g. [oracle](../oracle/http/PUT_admin_categories__id.json) |
| C7 | **Tenant scoping and 404.** Every record addressed by an id or slug is looked up through the signed-in user (`current_user.<association>.find`, a `for_user(current_user)` scope, or `triggered_by_user_id = current_user.id`). A record that exists but belongs to another tenant is indistinguishable from a missing record: `ActiveRecord::RecordNotFound` -> **404** (development: exception page with h1 "ActiveRecord::RecordNotFound in ..."; production: `public/404.html`). Exceptions to this rule: `/admin/versions*` (no scoping, see U-500) and `/sidekiq` (global, see U-501). | `AGENTS.md:252`; `spec/AGENTS.md:576`; **[V]** many `other_tenant_id -> 404` oracle cases (listed per route); `spec/system/cross_user_isolation_spec.rb:28-110` |
| C8 | **Form failure pattern.** Create/update actions that fail validation re-render the form template with **422 Unprocessable Content** (not a redirect). The form shows an error summary box "Please fix the following errors:" followed by one list item per model full error message (e.g. "Name can't be blank"); some actions additionally set a flash alert for the same request only (`flash.now[:alert]`). Success redirects with **302 Found** (Rails default) and sets `flash[:notice]`; failures that are not validation failures redirect with `flash[:alert]`. Devise actions use **303 See Other** for redirects and **422** for errors (`config.responder.redirect_status = :see_other`, `error_status = :unprocessable_content`). | `AGENTS.md:215-240`; `app/views/admin/shared/form/_error_summary.html.erb`; `config/initializers/devise.rb:308-309`; **[V]** 422/302 statuses in oracle per route; error text "Name can't be blank" observed in `oracle/ui/admin_styleguide.html` |
| C9 | **Flash rendering.** Flash keys `notice` (green), `alert` (red) and `warning` (amber) are rendered at the top of the page, dismissible (`app/views/admin/shared/_flash.html.erb`); on the auth layout without dismiss button (`app/views/admin/shared/_auth_flash.html.erb`). Flash survives exactly one redirect. | **[V]** observed in `oracle/ui/admin_sign_in_failed.html`, `oracle/ui/admin_cash_transactions_edit.html`; one-hop semantics **[I]** |
| C10 | **Strong parameters.** Form bodies are nested under a model key (e.g. `merchant[name]`). Actions using `params.expect(key: [...])` or `params.require(:key)` raise `ActionController::ParameterMissing` when the key is absent or not a hash -> **400 Bad Request** (production `public/400.html`). Unknown nested attributes are silently dropped. Actions using `params.fetch(:key, {})` tolerate a missing key. | Rails behaviour **[I]**; per-route strong-params keys listed below |
| C11 | **Pagination, filtering and sorting.** Index pages use Pagy offset pagination: query param `page` (1-based), page size 10 (`Pagy::OPTIONS[:limit] = 10`, max 100). An out-of-range page is handled by Pagy (overflow) **[I]**. Where Ransack is used (`paginated` helper or `scope.ransack`), filters come as `q[<attribute>_<predicate>]` (e.g. `q[title_cont]=BIED`) and sorting as `q[s]=<attribute> <asc|desc>`; only the model's allow-listed `ransackable_attributes` / `ransackable_associations` are accepted (others are ignored or raise, Ransack default). | `config/initializers/pagy.rb`; `app/controllers/admin/base_controller.rb:14-20`; `config/initializers/ransack.rb`; ransackable lists in `inventory/models.json`; **[V]** `spec/requests/banking_spec.rb:370` (sort params accepted) |
| C12 | **Hidden categories ("privacy").** A user can hide categories (Preferences -> App, `hidden_category_ids`). Hiding a category hides its whole subtree. Unless the user has `reveal_hidden_categories = true`, routes that would open a record in a hidden category redirect back to the list with a specific flash alert (strings quoted per route). | `app/models/user.rb:49-66`; **[V]** `spec/requests/categorization_spec.rb:82,231`, `spec/requests/analytics_spec.rb:85,127` |
| C13 | **Formats.** All routes accept an optional `.:format` suffix, but controllers only provide HTML templates. Requesting another format (e.g. `/admin/merchants.json`) yields an "unknown format / missing template" error (406 in production) **[I]**. Responses are `text/html; charset=utf-8`; no Turbo Stream responses exist anywhere in the application (no `*.turbo_stream.erb` templates, no `respond_to` blocks). Forms rely on Turbo Drive (422 re-render, 302/303 follow). | `app/views` (no turbo_stream templates) **[I]**; **[V]** content-type headers in oracle |
| C14 | **Time zone and dates.** `config.time_zone` is not set, so the application time zone is **UTC**; every "today" default (`Date.current`) in this part is the UTC date. Dates in query/form params are parsed with `Date.parse` (ISO `YYYY-MM-DD` recommended). | `config/application.rb` (no `time_zone`) **[I]** |
| C15 | **CORS.** `Rack::Cors` is inserted first in the middleware stack with `origins "*"`, all resources, all methods, no credentials; this also applies to the HTML routes (responses carry `vary: Origin`). Because credentials are not allowed, cross-origin scripts cannot use the session cookie. | `config/initializers/cors.rb`; **[V]** `vary: Origin` header in oracle; risk assessment see U-517 |

<a id="a3-error-format"></a>
### A.3 Error format for HTML routes

The Rails routes return HTML error pages, never JSON (Part B documents the JSON API errors).

| Situation | Development (`consider_all_requests_local = true`) | Production (`consider_all_requests_local = false`) | Evidence |
|---|---|---|---|
| Record not found / foreign tenant (`ActiveRecord::RecordNotFound`) | 404, interactive exception page, `<title>Action Controller: Exception caught</title>`, h1 "ActiveRecord::RecordNotFound in Admin::XController#action", content-type `text/html; charset=UTF-8` | 404, static `public/404.html`: title "The page you were looking for doesn't exist (404 Not found)", text "The page you were looking for doesn't exist. You may have mistyped the address or the page may have moved. If you're the application owner check the logs for more information." | **[V]** dev page in [oracle](../oracle/http/GET_admin_merchants__id.json) case `other_tenant_id`, `oracle/ui/error_404_unknown_record.html`; production page **[I]** `public/404.html`, `config/environments/production.rb:13` |
| Invalid CSRF token (`ActionController::InvalidAuthenticityToken`) | 422 exception page | 422, `public/422.html`: title "The change you wanted was rejected (422 Unprocessable Entity)", text "The change you wanted was rejected. Maybe you tried to change something you didn't have access to. If you're the application owner check the logs for more information." | **[V]** dev [oracle](../oracle/http/POST_admin_categories.json) case `missing_csrf_token`; prod **[I]** |
| Missing required param key (`ActionController::ParameterMissing`), malformed request | 400 exception page | 400, `public/400.html`: title "The server cannot process the request due to a client error (400 Bad Request)", text "The server cannot process the request due to a client error. Please check the request and try again. If you're the application owner check the logs for more information." | **[I]** |
| Legacy browser (C1) | 406, `public/406-unsupported-browser.html` (same in all environments) | same | **[V]** [oracle](../oracle/http/GET_admin_analytics.json) case `legacy_browser_ua` |
| Any other unhandled exception | 500 exception page with class, message, backtrace, request params (e.g. h1 "RuntimeError in Admin::DebugController#runtime_error") | 500, `public/500.html`: title "We're sorry, but something went wrong (500 Internal Server Error)", text "We're sorry, but something went wrong. If you're the application owner check the logs for more information." | **[V]** dev [oracle](../oracle/http/GET_admin_debug_runtime_error.json); prod **[I]** |
| Validation failure on a form | 422 re-rendered form (C8), not an error page | same | **[V]** |

For production, Rails' default `exceptions_app` (`ActionDispatch::PublicExceptions`) serves `public/<status>.html` for HTML requests; for a request
that explicitly asks for JSON/XML it renders `{"status":<code>,"error":"<reason phrase>"}` instead **[I]**. All five static pages are self-contained
HTML (inline CSS, no assets). The Kotlin service should serve equivalent static pages for 400/404/406/422/500 and must never expose stack
traces (see U-516).

<a id="a4-safe-return-to"></a>
### A.4 Open-redirect guard `safe_return_to`

Several merchant actions accept an optional `return_to` parameter (query or form field) so the UI can send the user back to the page they came
from (e.g. the AI Enrichment review list). The value is accepted only if **all** of these hold, otherwise the action's default target is used
(`app/controllers/admin/base_controller.rb:24-30`):

1. it is not blank;
2. it starts with `/admin/` or with `/admin?`;
3. it does not contain `//` anywhere (blocks protocol-relative URLs such as `/admin//evil.com` and embedded `http://`).

The accepted value is used verbatim as the redirect `Location` (relative path, so same host). Used by `PATCH|PUT /admin/merchants/:id`,
`DELETE /admin/merchants/:id`, `POST /admin/merchants/:id/archive`, `POST /admin/merchants/:id/unarchive`, `POST /admin/merchants/:id/approve`.
**[V]** `spec/requests/categorization_spec.rb:273` (safe value honoured), `spec/requests/categorization_spec.rb:286` (hostile value falls back to
the merchant page). Rules 1-3 individually **[I]** (code reading). Note that `/admin` alone (without `/` or `?`) is rejected and that
backslashes or encoded characters are not specially handled **[I]**.

Other redirect-back mechanisms: `POST /admin/onboarding/seed_taxonomy` uses the HTTP `Referer` header (`redirect_back_or_to`), which Rails only
honours for same-host referers (Rails 7+ `allow_other_host: false` default) **[I]**; `spec/requests/onboarding_spec.rb:21` **[V]**.

### A.5 Authentication, first-run and public routes

<a id="route-get-admin-sign-in"></a>
#### `GET /admin/sign_in`

- **Handler:** `Admin::SessionsController#new` (Devise `SessionsController`, layout `admin_auth`) — `app/controllers/admin/sessions_controller.rb:4-6`; route `config/routes.rb:4-10` (`devise_for :users, path: "admin", skip: [:registrations]`). **[V]**
- **Auth:** public. C1, C2 apply (on an empty instance -> `/setup`). If a user is already signed in, Devise redirects to the post-sign-in target with alert "You are already signed in." (`config/locales/devise.en.yml:10`) **[I]**.
- **Response:** 200 HTML, page title "Sign in", h1 "Sign in to your account", form fields `user[email]`, `user[password]`, `user[remember_me]` (checkbox), hidden `authenticity_token`; link "Forgot password?" to `/admin/password/new`. **[V]** [oracle](../oracle/http/GET_admin_sign_in.json) case `default -> 200`; `spec/requests/public_spec.rb:185`.

<a id="route-post-admin-sign-in"></a>
#### `POST /admin/sign_in`

- **Handler:** `Admin::SessionsController#create` (Devise). **[V]**
- **Auth:** public; CSRF required (C5).
- **Parameters (form, key `user`):** `email` (string, required; case-insensitive and whitespace-stripped before lookup: `config/initializers/devise.rb:61,66`), `password` (string, required), `remember_me` (`"1"`/`"0"`, optional).
- **Behaviour:** looks up the user by email and verifies the bcrypt password (cost 12 outside test, `config/initializers/devise.rb:126`). On success the user is stored in the session; with `remember_me=1` a remember-me cookie is also set (C3).
- **Responses:**
  - success -> **303** to the stored location (the last GET HTML URL that bounced to sign-in) or, if none, to `/` (which then 301s to `/admin` -> `/admin/analytics`); flash notice "Signed in successfully." (`config/locales/devise.en.yml:49`). **[V]** [oracle](../oracle/http/POST_admin_sign_in.json) case `valid_credentials -> 303` (Location was `/api/v9/docs`, the location stored by an earlier anonymous request, see U-518); `spec/requests/public_spec.rb:193` (redirect, then redirect to `/admin`).
  - wrong email or password -> **422**, sign-in form re-rendered with flash alert "Invalid email or password." The submitted password is not echoed. **[V]** [oracle](../oracle/http/POST_admin_sign_in.json) case `wrong_password -> 422`; text observed in `oracle/ui/admin_sign_in_failed.html`; `spec/requests/public_spec.rb:201`. The same message is used for unknown email and wrong password (no enumeration on this route) **[I]** (`config/locales/devise.en.yml:12,15`).
  - missing CSRF token -> **422** (C5). **[V]** case `missing_csrf_token -> 422`.

<a id="route-delete-admin-sign-out"></a>
#### `DELETE /admin/sign_out`

- **Handler:** `Admin::SessionsController#destroy` (Devise; `config.sign_out_via = :delete`, `config/initializers/devise.rb:272`). A GET to this path is not routed (404 / routing error) **[I]**.
- **Auth:** public; CSRF required.
- **Behaviour:** clears the session and expires all remember-me tokens of the user (C3).
- **Responses** (Devise distinguishes "navigational" requests — HTML / Turbo Stream / browser `*/*` with HTML preference — from others):
  - browser (HTML or `turbo_stream` Accept) -> **303** to `/` with notice "Signed out successfully." **[V]** `oracle/server.log.txt:20482` (UI sign-out: format `turbo_stream`, status 303, Location `/`); `spec/requests/public_spec.rb:208` (redirect, after which `/admin/styleguide` requires sign-in).
  - non-navigational request (`Accept: */*` without HTML preference), signed in -> **204** empty. **[V]** [oracle](../oracle/http/DELETE_admin_sign_out.json) case `signed_in -> 204`.
  - non-navigational request, not signed in -> **401** (Devise `already_signed_out`, message "Signed out successfully."). **[V]** case `not_signed_in -> 401`.

<a id="route-get-admin-password-new"></a>
#### `GET /admin/password/new`

- **Handler:** `Admin::PasswordsController#new` (Devise `PasswordsController`, layout `admin_auth`) — `app/controllers/admin/passwords_controller.rb:4-6`.
- **Auth:** public (Devise redirects a signed-in user away, **[I]**).
- **Response:** 200, title "Reset password", h1 "Forgot your password?", field `user[email]`. **[V]** [oracle](../oracle/http/GET_admin_password_new.json) case `default -> 200`; `spec/requests/public_spec.rb:217`.

<a id="route-post-admin-password"></a>
#### `POST /admin/password`

- **Handler:** `Admin::PasswordsController#create` (Devise).
- **Auth:** public; CSRF required.
- **Parameters:** `user[email]` (string, required; case-insensitive, stripped).
- **Behaviour:** if a user with that email exists, generates a reset token (stored as digest in `users.reset_password_token`, `reset_password_sent_at` = now) and sends the Devise "reset password instructions" email (sender `please-change-me-at-config-initializers-devise@example.com`, `config/initializers/devise.rb:27`; see U-508). Token validity: 6 hours (`config/initializers/devise.rb:230`).
- **Responses:**
  - known email -> **303** to `/admin/sign_in`, notice "You will receive an email with instructions on how to reset your password in a few minutes." (`config/locales/devise.en.yml:35`). **[V]** status/Location [oracle](../oracle/http/POST_admin_password.json) case `known_email -> 303`; `spec/requests/public_spec.rb:224`; notice text **[I]**.
  - unknown email -> **422**, form re-rendered with error summary "Email not found" (Devise `paranoid` mode is off, `config/initializers/devise.rb:93`, so the route reveals whether an email is registered; see U-507). **[V]** status case `unknown_email -> 422`; message text **[I]** (`config/locales/devise.en.yml:61` "not found").

<a id="route-get-admin-password-edit"></a>
#### `GET /admin/password/edit`

- **Handler:** `Admin::PasswordsController#edit` (Devise).
- **Parameters:** `reset_password_token` (query, string, required).
- **Responses:**
  - no token -> **302** to `/admin/sign_in` with alert "You can't access this page without coming from a password reset email. If you do come from a password reset email, please make sure you used the full URL provided." (`config/locales/devise.en.yml:34`). **[V]** status [oracle](../oracle/http/GET_admin_password_edit.json) case `no_token -> 302`; text **[I]**.
  - any token (valid or not; it is only validated on submit) -> **200**, title "Set new password", h1 "Set a new password", fields `user[password]`, `user[password_confirmation]`, hidden `user[reset_password_token]`. **[V]** case `bogus_token -> 200`; `spec/requests/public_spec.rb:232` (valid token).

<a id="route-patch-admin-password"></a>
#### `PATCH /admin/password`

<a id="route-put-admin-password"></a>
#### `PUT /admin/password`

(Identical behaviour, C6.)

- **Handler:** `Admin::PasswordsController#update` (Devise).
- **Auth:** public; CSRF required.
- **Parameters (key `user`):** `reset_password_token` (string, required), `password` (string, 6..128 chars, `config/initializers/devise.rb:184`), `password_confirmation` (must equal `password`).
- **Behaviour:** finds the user by token digest; the token must be younger than 6 hours. On success sets the new password, clears the token, signs the user in.
- **Responses:**
  - success -> **303** to the post-sign-in target with notice "Your password has been changed successfully. You are now signed in." (`config/locales/devise.en.yml:37`) **[I]**.
  - invalid / expired token or invalid password -> **422**, form re-rendered with error summary (e.g. "Reset password token is invalid", "Reset password token has expired, please request a new one", "Password is too short (minimum is 6 characters)", "Password confirmation doesn't match Password") **[V]** status [oracle](../oracle/http/PATCH_admin_password.json) case `bogus_token -> 422`, [oracle](../oracle/http/PUT_admin_password.json) case `bogus_token -> 422`; message texts **[I]**.

<a id="route-get-setup"></a>
#### `GET /setup`

- **Handler:** `SetupController#new` — `app/controllers/setup_controller.rb:6-10`; route `config/routes.rb:18`. Layout `admin_auth`.
- **Auth:** public. Only usable while no user exists (ADR 0011).
- **Behaviour / responses:**
  - no users -> **200**, title "Create your account", h1 "Create your admin account", fields `user[name]`, `user[email]`, `user[password]`, `user[password_confirmation]`. **[V]** [oracle](../oracle/http/GET_setup.json) case `no_users -> 200`; `spec/requests/public_spec.rb:6`.
  - a user exists, visitor signed out -> **302** `/admin/sign_in`. **[V]** case `users_exist -> 302`; `spec/requests/public_spec.rb:14`.
  - a user exists, visitor signed in -> **302** `/admin` (`after_setup_path`, `app/controllers/setup_controller.rb:33-35`). **[V]** `spec/requests/public_spec.rb:21`.

<a id="route-post-setup"></a>
#### `POST /setup`

- **Handler:** `SetupController#create` — `app/controllers/setup_controller.rb:12-25`; strong params `user: [name, email, password, password_confirmation]` (`:29-31`, `params.require(:user)` -> 400 if absent, C10).
- **Auth:** public; CSRF required. Guard: if any user exists the request is a no-op redirect (same targets as `GET /setup`), even if the form was opened in another tab before the first user was created. **[V]** [oracle](../oracle/http/POST_setup.json) case `users_exist -> 302`; `spec/requests/public_spec.rb:67,81`; `spec/system/first_run_setup_spec.rb:50`.
- **Validation (User model):** `name` present ("Name can't be blank"); `email` present, unique (case-sensitive comparison after downcasing), format `^[^@\s]+@[^@\s]+$` ("Email is invalid"); `password` present, 6..128 characters, `password_confirmation` must match ("Password confirmation doesn't match Password"). `app/models/user.rb:23,25`, `config/initializers/devise.rb:184,189` **[I]** for message texts.
- **Behaviour on success:** creates the user, then seeds the per-user baseline taxonomy (`Seeders::Categories`) and system merchant rules (`Seeders::MerchantRules`) (BR-200..299), signs the new user in, **302** -> `/admin` with notice "Welcome - your account is ready." **[V]** [oracle](../oracle/http/POST_setup.json) case `no_users_valid -> 302` (Location `/admin`); `spec/requests/public_spec.rb:29` (seeders called with the user, notice matches /welcome/).
- **Failure:** **422**, form re-rendered with the error summary; seeders not called, no user created. **[V]** case `no_users_invalid -> 422`; `spec/requests/public_spec.rb:51`; `spec/system/first_run_setup_spec.rb:67`.
- Seeding is not wrapped in the same transaction as user creation: if a seeder raised, the user would exist without taxonomy (recoverable through `POST /admin/onboarding/seed_taxonomy`) **[I]**.

<a id="route-get-up"></a>
#### `GET /up`

- **Handler:** `Rails::HealthController#show` (framework) — route `config/routes.rb:21` (`as: :rails_health_check`).
- **Auth:** public; not subject to C1/C2 (does not inherit `ApplicationController`).
- **Response:** **200** `text/html; charset=utf-8`, body exactly `<!DOCTYPE html><html><body style="background-color: green"></body></html>` (73 bytes) when the application booted; if an exception is raised while rendering, 500 with a red page **[I]**. It does **not** check the database or Redis (see U-522). **[V]** [oracle](../oracle/http/GET_up.json) case `default -> 200`.

<a id="route-get-callback"></a>
#### `GET /callback`

- **Handler:** `OauthCallbacksController#enable_banking` — `app/controllers/oauth_callbacks_controller.rb:7-28`; route `config/routes.rb:25` (`as: :oauth_callback`). The path must equal the redirect URL registered at the provider (Enable Banking) and on the user's `TppCredential.redirect_url` (`:1-3`).
- **Auth:** Devise session required (`:5`); anonymous -> 302 `/admin/sign_in` (the callback URL is stored, so the flow resumes after sign-in). **[V]** [oracle](../oracle/http/GET_callback.json) case `anonymous_no_params -> 302`; `spec/requests/public_spec.rb:96`; `spec/system/oauth_callback_error_spec.rb:105`.
- **Parameters (query, sent by the bank):** `state` (string, signed token produced by `POST /admin/bank_connections`), `code` (string, authorization code), `error` (string, present when the user cancelled or the bank failed).
- **Behaviour (checked in this order; every rejection = 302 -> `/admin/bank_connections` with flash alert):**

  | # | Condition | Flash alert (exact) | Evidence |
  |---|---|---|---|
  | 1 | `error` param present (any value) | "Authorization was cancelled or failed at the bank." | `:8`; **[V]** case `bank_error_param -> 302`; `spec/requests/public_spec.rb:102`; `spec/system/connection_expiry_reauth_spec.rb:86` (exact text) |
  | 2 | `state` blank, signature invalid, or expired (TTL 30 minutes from `expires_at`) | "Invalid or expired state. Start the flow again." | `:10-11`; `app/services/enable_banking/state.rb:9,26-35`; **[V]** cases `invalid_state`, `missing_state -> 302`; `spec/requests/public_spec.rb:110` |
  | 3 | `state.user_id` != signed-in user id | "State user mismatch." | `:12`; **[V]** `spec/requests/public_spec.rb:119`; `spec/system/connection_expiry_reauth_spec.rb:113` |
  | 4 | `code` blank | "Authorization code missing." | `:13`; **[V]** `spec/requests/public_spec.rb:129` |
  | 5 | `state.tpp_credential_id` not among the current user's credentials | "TPP credential no longer exists." | `:15-16`; **[V]** `spec/requests/public_spec.rb:138`, `spec/system/oauth_callback_error_spec.rb:40` |
  | 6 | `EnableBanking::Operations::CreateConnection` raises `Failed` | the exception message, e.g. "Could not create session: <provider error>" or "Could not save records: <error>" | `:26-27`; `app/services/enable_banking/operations/create_connection.rb:18,28`; **[V]** `spec/requests/public_spec.rb:170` (alert equals the message) |

- **Success:** calls `EnableBanking::Operations::CreateConnection(credential:, code:, state:)` (BR-001..199: creates the BankConnection and its accounts, marks a replaced connection when `state.replaces_connection_id` is set), then **302** -> `/admin/bank_connections/:id` with notice "Bank connected - <bank_name>, <n> account(s)." where n = number of accounts currently linked to the new connection. **[V]** `spec/requests/public_spec.rb:150`, `spec/system/oauth_callback_success_spec.rb:47`. Known issue: account lookup by provider `uid` is not tenant-scoped (see U-506).
- The state token is signed (HMAC) but not encrypted; its payload (user id, credential id, bank name, country, PSU type, replaced connection id, expiry, nonce) is readable base64 JSON, and the nonce is not recorded, so a state can be replayed within its 30-minute TTL by the same user (see U-519). **[V]** payload visible in the Location of [oracle](../oracle/http/POST_admin_bank_connections.json) case `default`.

<a id="route-mount-sidekiq"></a>
#### `MOUNT /sidekiq`

- **Handler:** `Sidekiq::Web` Rack application mounted at `/sidekiq` inside `authenticate :user do ... end` — `config/routes.rb:12-14`.
- **Auth:** a Devise session is required at routing level; anonymous -> **302** `/admin/sign_in`. **Any** signed-in user (any tenant) gets the full Sidekiq dashboard (queues, scheduled/retry/dead jobs incl. their arguments, cron jobs from `sidekiq-cron`) and can retry/delete jobs; there is no admin role (see U-501). Not subject to C1/C2.
- **Response:** 200 HTML, title "[DEVELOPMENT] Sidekiq" in development. **[V]** [oracle](../oracle/http/GET_sidekiq.json) cases `anonymous -> 302`, `authenticated -> 200`; `oracle/ui/sidekiq_dashboard.html`.
- **Kotlin:** the Kotlin service will have its own job runner; an equivalent operator dashboard is optional. Proposed default: do not expose a job dashboard to tenants (U-501).

### A.6 Router-level redirects

These are `redirect(...)` routes evaluated by the router; no controller, no authentication, no first-run check, no CSRF. They answer
**301 Moved Permanently** with an absolute `Location` built from the request host, `content-type: text/html; charset=UTF-8` and a tiny body.

<a id="route-get-root"></a>
#### `GET /`

- `root to: redirect("/admin")` — `config/routes.rb:158`. **301** -> `/admin`. **[V]** [oracle](../oracle/http/GET_root.json) case `default -> 301`. On an empty instance the chain is `/` -> `/admin` -> `/admin/analytics` -> `/setup` **[V]** `spec/system/first_run_setup_spec.rb:16`.

<a id="route-get-admin"></a>
#### `GET /admin`

- `namespace :admin { root to: redirect("/admin/analytics") }` — `config/routes.rb:48`. **301** -> `/admin/analytics` for anonymous and signed-in users alike (authentication happens on the target). **[V]** [oracle](../oracle/http/GET_admin.json) cases `default -> 301` (anon and main(session)); `spec/system/smoke/auth_spec.rb:12`.

<a id="route-get-admin-settings"></a>
#### `GET /admin/settings`

- `get "/", to: redirect("/admin/settings/preferences")` — `config/routes.rb:124`. **301** -> `/admin/settings/preferences`. **[V]** [oracle](../oracle/http/GET_admin_settings.json) case `default -> 301`.

<a id="route-get-admin-settings-preferences"></a>
#### `GET /admin/settings/preferences`

- `get "preferences", to: redirect("/admin/settings/preferences/profile")` — `config/routes.rb:127-128`. **301** -> `/admin/settings/preferences/profile`. **[V]** [oracle](../oracle/http/GET_admin_settings_preferences.json) case `default -> 301`.

Note for Kotlin: 301 responses are cached by browsers; keep the targets stable or use 302 if they may change (migration choice, low risk).

### A.7 Development-only debug routes (`/admin/debug*`)

All six routes are drawn only when `Rails.env.development?` (`config/routes.rb:33-42`): they are **absent in test and production**
(compare `inventory/routes.txt` with `inventory/routes_development.txt`; coverage key flag `dev_only: true`). They exist to exercise the
OpenTelemetry error pipeline (`config/initializers/opentelemetry_error_subscriber.rb`). Handler `Admin::DebugController`
(`app/controllers/admin/debug_controller.rb`), inherits `Admin::BaseController`, so C1-C3 apply (session required). **The Kotlin service does
not need these routes** (proposed default: omit; observability tests can use test-only endpoints).

<a id="route-get-admin-debug"></a>
#### `GET /admin/debug` (dev only)

- `Admin::DebugController#index` (`:5-6`). 200, page "Debug", subtitle "Trigger errors and jobs to test observability pipeline.", one "Raise" button per error route below and a form for the failing job. **[V]** [oracle](../oracle/http/GET_admin_debug.json) case `default -> 200`; `oracle/ui/admin_debug.png`.

<a id="route-get-admin-debug-runtime-error"></a>
#### `GET /admin/debug/runtime_error` (dev only)

- `#runtime_error` (`:8-10`) raises `RuntimeError` "Test RuntimeError from admin debug endpoint" -> **500** exception page. **[V]** [oracle](../oracle/http/GET_admin_debug_runtime_error.json) case `default -> 500`.

<a id="route-get-admin-debug-zero-division"></a>
#### `GET /admin/debug/zero_division` (dev only)

- `#zero_division` (`:12-14`) evaluates `1 / 0` -> `ZeroDivisionError` "divided by 0" -> **500**. **[V]** [oracle](../oracle/http/GET_admin_debug_zero_division.json) case `default -> 500`.

<a id="route-get-admin-debug-argument-error"></a>
#### `GET /admin/debug/argument_error` (dev only)

- `#argument_error` (`:16-18`) evaluates `Integer("not_a_number")` -> `ArgumentError` -> **500**. **[V]** [oracle](../oracle/http/GET_admin_debug_argument_error.json) case `default -> 500`.

<a id="route-get-admin-debug-nested-error"></a>
#### `GET /admin/debug/nested_error` (dev only)

- `#nested_error` (`:20-26`) raises `StandardError` "wrapping error with cause" whose `cause` is `RuntimeError` "original cause" -> **500**. **[V]** [oracle](../oracle/http/GET_admin_debug_nested_error.json) case `default -> 500`.

<a id="route-post-admin-debug-enqueue-failing-job"></a>
#### `POST /admin/debug/enqueue_failing_job` (dev only)

- `#enqueue_failing_job` (`:28-31`), CSRF required. Param `error_type` (form/query, optional, default `"runtime"`; `"argument"` and `"zero_division"` select other errors, any other value makes the job succeed). Enqueues `FailingJob` (Sidekiq, queue `default`, `retry_on StandardError, wait: 3.seconds, attempts: 3`, `app/jobs/failing_job.rb`) and answers **204 No Content** (no redirect, no flash). **[V]** [oracle](../oracle/http/POST_admin_debug_enqueue_failing_job.json) case `default -> 204`.

### A.8 Admin meta routes

<a id="route-get-admin-styleguide"></a>
#### `GET /admin/styleguide`

- `Admin::StyleguideController#index` — `app/controllers/admin/styleguide_controller.rb:5`; route `config/routes.rb:49`. Session required (C3). No parameters, no data access: renders a static gallery of every reusable UI component (page headers, buttons, forms incl. a sample error summary "Name can't be blank", tables, badges). 200. **[V]** [oracle](../oracle/http/GET_admin_styleguide.json) case `default -> 200`; `spec/requests/meta_spec.rb:245` (anonymous -> sign-in), `:251` (200). Kotlin: developer aid only; optional (see the UI/pages document).

<a id="route-post-admin-onboarding-seed-taxonomy"></a>
#### `POST /admin/onboarding/seed_taxonomy`

- `Admin::OnboardingController#seed_taxonomy` — `app/controllers/admin/onboarding_controller.rb:8-15`; route `config/routes.rb:54`. Session + CSRF. No parameters.
- **Behaviour:** for the current user only: runs `Seeders::Categories` (baseline category tree), `Seeders::MerchantRules` (system merchants and rules), then `Enrichment::TransactionEnricher.rebuild!` (re-classifies all of the user's transactions) (BR-200..299). Seeders are expected to be idempotent (they are also run at `/setup`) **[I]**.
- **Response:** **302** back to the `Referer` (same host only) or, if absent, `/admin`; notice "Baseline taxonomy loaded - <N> categories, <M> system merchants. Existing transactions reclassified." with N = count of the user's categories and M = count of the user's merchants with `source = 'system'` after seeding. **[V]** [oracle](../oracle/http/POST_admin_onboarding_seed_taxonomy.json) case `default -> 302` (Location `/admin`); `spec/requests/onboarding_spec.rb:6` (both seeders + rebuild called for the user, notice present), `:21` (Referer honoured), `:33` (only the current user), `:48` (anonymous -> sign-in).

<a id="route-get-admin-versions"></a>
#### `GET /admin/versions`

- `Admin::VersionsController#index` — `app/controllers/admin/versions_controller.rb:5-7`; route `config/routes.rb:56`. Session required. Page "Audit Log".
- **Data:** all rows of the PaperTrail `versions` table (audit trail of `BankAccount`, `BankConnection` (without `session_id`, `psu_id_hash`, `raw_session_payload`), `ManualTransaction`, `TppCredential` (without `application_id`, `private_key_pem`) changes; `app/models/*.rb` `has_paper_trail`), paginated (C11), default sort `created_at desc`. Columns: resource (`item_type`), id, event (`create`/`update`/`destroy`), by (`whodunnit` user id or "-"), time.
- **Parameters:** `page`; Ransack `q[...]` over `created_at, event, id, item_id, item_type, object, object_changes, whodunnit` (`config/initializers/paper_trail_ransack.rb`), e.g. `q[item_type_eq]=BankAccount` (a "Resource" select offers every distinct `item_type`), `q[s]`.
- **Authorisation: none beyond sign-in. The query is not tenant-scoped**: every signed-in user sees every tenant's audit rows. **[V]** [oracle](../oracle/http/GET_admin_versions.json) cases `default -> 200`, `other_tenant_sees_all_versions -> 200`; `spec/requests/meta_spec.rb:260` (200 with no rows). See U-500 (BUG?).

<a id="route-get-admin-versions-id"></a>
#### `GET /admin/versions/:id`

- `Admin::VersionsController#show` — `app/controllers/admin/versions_controller.rb:9-11`. Path param `id` (integer). `PaperTrail::Version.find(id)` -> 404 if missing. Page "Version #<id>" with subtitle "<item_type> #<item_id> - <created_at, long format>" and a before/after table of the changeset (`app/views/admin/versions/show.html.erb`).
- **Not tenant-scoped**: another tenant can read any version, including the attribute changes (e.g. IBANs and names of another tenant's bank accounts). **[V]** [oracle](../oracle/http/GET_admin_versions__id.json) cases `default -> 200`, `other_tenant_reads_main_version -> 200`; `spec/requests/meta_spec.rb:269` (200), `:285` (unknown id -> 404). See U-500.

### A.9 Bank transactions and classification

<a id="route-get-admin-bank-transactions"></a>
#### `GET /admin/bank_transactions`

- `Admin::BankTransactionsController#index` — `app/controllers/admin/bank_transactions_controller.rb:7-24`; route `config/routes.rb:58`. Session required. Page "Bank Transactions".
- **Tenant scoping:** `BankTransaction.for_user(current_user)` = transactions whose bank account belongs to one of the user's TPP credentials (`app/models/bank_transaction.rb:82`). The account filter dropdown lists the user's bank accounts ordered by IBAN (`:43-48`).
- **Parameters (all query, optional):**

  | Name | Type | Effect |
  |---|---|---|
  | `merchant_id` | integer | enrichment's `merchant_id` equals value |
  | `category_id` | integer | enrichment's explicit `category_id` equals value (not the effective/inherited category) |
  | `enrichment_source` | string | enrichment `source` equals value (one of `unmatched, system_rule, user_rule, llm_rule, llm_pending, manual, system_fallback`, `app/models/transaction_enrichment.rb:44`) |
  | `payment_method` | string | `payment_method` equals value |
  | `enrichment_state` | `merchantless` \| `llm_ready` \| `no_llm_signal` | merchantless = enrichment without merchant; llm_ready = merchantless AND eligible for the LLM run (`Llm::EnrichableQuery`); no_llm_signal = merchantless minus llm_ready. Any other value: no filter (`:55-68`) |
  | `q[...]`, `q[s]` | Ransack | over `BankTransaction` ransackable attributes (`id, external_id, booking_date, value_date, transaction_date, amount_cents, currency, direction, status, title, type_hint, counterparty_name, counterparty_iban, counterparty_kind, payment_method, bank_transaction_code, bank_account_id, created_at, updated_at`) and associations `bank_account`, `enrichment`; default sort `booking_date desc` |
  | `page` | integer | C11 |

- **Response:** 200. Note that filters joining the enrichment exclude transactions without an enrichment row **[I]**. **[V]** [oracle](../oracle/http/GET_admin_bank_transactions.json) cases `default -> 200`, `filtered -> 200` (`enrichment_state=unclassified` = unknown value, ignored); `spec/requests/banking_spec.rb:354` (only own transactions), `:370`; `spec/system/cross_user_isolation_spec.rb:16`.

<a id="route-get-admin-bank-transactions-id"></a>
#### `GET /admin/bank_transactions/:id`

- `Admin::BankTransactionsController#show` — `:26-39`. Path `id` (integer). Lookup `for_user(current_user).find` -> **404** for other tenants (C7).
- **Hidden category guard (C12):** if the transaction's effective category is hidden -> **302** `/admin/bank_transactions`, alert "This transaction is in a hidden category. Remove it from the hidden list in preferences to open it." (`:32-36`) **[I]** for the text.
- **Response:** 200, page title "Transaction <external_id>", h1 = signed amount and currency (e.g. "−19.99 PLN", debit shown with U+2212 minus). Includes the classification form (merchant options = the user's active merchants ordered by name) posting to the enrichment route below. **[V]** [oracle](../oracle/http/GET_admin_bank_transactions__id.json) cases `default -> 200`, `other_tenant_id -> 404`; `spec/requests/banking_spec.rb:379`; `spec/system/cross_user_isolation_spec.rb:58`.

<a id="route-patch-admin-bank-transactions-bank-transaction-id-enrichment"></a>
#### `PATCH /admin/bank_transactions/:bank_transaction_id/enrichment`

<a id="route-put-admin-bank-transactions-bank-transaction-id-enrichment"></a>
#### `PUT /admin/bank_transactions/:bank_transaction_id/enrichment`

- `Admin::TransactionEnrichmentsController#update` — `app/controllers/admin/transaction_enrichments_controller.rb:5-27`; route `config/routes.rb:59` (singular resource `enrichment`). Session + CSRF.
- **Tenant scoping:** transaction via `BankTransaction.for_user(current_user).find(bank_transaction_id)` -> 404 for other tenants **[V]** `spec/requests/categorization_spec.rb:467`. `merchant_id` / `category_id` are resolved with `current_user.merchants.find_by` / `current_user.categories.find_by`: a foreign or unknown id silently becomes "no merchant"/"no category" **[V]** `spec/requests/categorization_spec.rb:432`.
- **Parameters (form, key `enrichment`, optional as a whole — `params.fetch(:enrichment, {})`):** `mode` (`only_this` \| `all_for_merchant` \| `create_rule`), `merchant_id`, `category_id`, `rule_field` (default `title`), `rule_kind` (default `contains`), `rule_pattern`.
- **Behaviour:** delegates to `Enrichment::ClassificationApplier` (BR-200..299): `only_this` writes a manual override on this transaction's enrichment; `all_for_merchant` sets the merchant's default category (if a category was given) and links the transaction to the merchant; `create_rule` creates an approved user `MerchantRule` (priority 100) for the merchant, optionally updates the merchant's default category, then rebuilds all of the user's classifications.
- **Response:** always **302** -> `/admin/bank_transactions/:id`:
  - success: notice "Applied: this transaction only" \| "Applied: all transactions for this merchant" \| "Applied: new rule + rebuild" (`app/services/enrichment/classification_applier.rb:48,101-107`) **[I]** text; **[V]** [oracle](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json) case `default -> 302`; `spec/requests/categorization_spec.rb:410` (controller relays the service message as notice).
  - failure: alert with the service message: "Unknown propagation mode: <mode>", "Pick a merchant" (mode other than `only_this` without a valid merchant), "Pick a pattern" (`create_rule` with blank pattern), or the joined validation messages (e.g. "Pattern is not a valid regex: <detail>") (`classification_applier.rb:36-38,49-50`). **[V]** [oracle](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json) case `create_rule_missing_fields -> 302`; `spec/requests/categorization_spec.rb:451` (alert relayed). A request without `enrichment[mode]` raises (nil mode) -> 500 **[I]** (see U-513).

### A.10 Cash transactions (manual wallet entries)

Handler `Admin::CashTransactionsController` (`app/controllers/admin/cash_transactions_controller.rb`), route `config/routes.rb:62`
(`resources :cash_transactions`). Only rows with `source = "manual"` are editable here; rows with any other source (`atm_link` = auto-generated from ATM withdrawals, `csv_import`, `recurring`;
`app/models/manual_transaction.rb:55`) are read-only (`:4-5,95-99`). Business rules: BR-300..399 (`Cash::TransactionCreator`, `Cash::TransactionUpdater`,
`Cash::WalletResolver`). Money: amounts are entered as decimal strings in major units and stored as integer minor units (`amount_cents`,
always positive) plus ISO currency; the sign is carried by `direction` (`debit` = expense, `credit` = income).

<a id="route-get-admin-cash-transactions"></a>
#### `GET /admin/cash_transactions`

- `#index` (`:10-26`). Session required. Page "Cash transactions".
- **Scoping:** `ManualTransaction.for_user` = rows in wallets (`bank_accounts.manual = true`) owned by the user (`app/models/manual_transaction.rb:86-88`).
- **Parameters (query, optional):** `wallet_id` (bank account id), `direction` (`debit`/`credit`), `from`, `to` (dates, inclusive bounds on `booking_date`, compared as strings by PostgreSQL date cast), Ransack `q[...]` (ManualTransaction ransackable attributes: `id, booking_date, transaction_date, amount_cents, currency, direction, status, title, counterparty_name, counterparty_kind, payment_method, source, bank_account_id, linked_bank_transaction_id, created_at, updated_at`), default sort `booking_date desc`, `page`.
- **Also shows** the user's wallets (ordered by currency) with a balance per wallet = sum(credit `amount_cents`) − sum(debit `amount_cents`) over **all** rows of that wallet (ignores the filters), as Money in the wallet currency (`:127-137`).
- **Response:** 200. **[V]** [oracle](../oracle/http/GET_admin_cash_transactions.json) case `default -> 200`; `spec/requests/cash_spec.rb:6` (own rows only), `:20` (wallet_id), `:35` (direction), `:48` (from/to), `:270` (anonymous -> sign-in).

<a id="route-get-admin-cash-transactions-new"></a>
#### `GET /admin/cash_transactions/new`

- `#new` (`:32-40`). Query `direction` (optional; default `debit`). Pre-filled: currency = currency of the user's oldest cash wallet, else `PLN`; `booking_date` = today (UTC, C14); `payment_method` = `cash`. Option lists: up to 500 active merchants by name, active categories by position/name, currencies = sorted unique upper-case set of `PLN` + the user's wallet currencies + bank account currencies (`:101-105,115-125`).
- 200, page "New cash transaction". **[V]** [oracle](../oracle/http/GET_admin_cash_transactions_new.json) cases `default -> 200`, `credit -> 200`; `spec/requests/cash_spec.rb:61,71`.

<a id="route-post-admin-cash-transactions"></a>
#### `POST /admin/cash_transactions`

- `#create` (`:42-56`). Session + CSRF. Strong params `cash_transaction: [amount, currency, direction, booking_date, transaction_date, title, note, counterparty_name, merchant_id, category_id, payment_method]` (`params.require` -> 400 if the key is absent).
- **Normalisation (`app/services/cash/transaction_creator.rb:218-247`):** `currency` stripped/upper-cased, default `PLN`; `direction` default `debit`; `payment_method` default `cash`; `amount` with `,` replaced by `.` then converted to minor units of the currency (unparseable -> nil); `booking_date` unparseable/blank -> today; `merchant_id`/`category_id` resolved among the user's *active* merchants/categories (foreign ids -> nil). The wallet for the currency is found or created **before** validation (a failed create can still leave a new empty wallet) **[I]**.
- **Validation (ManualTransaction):** `amount_cents`, `currency`, `booking_date` present; `amount_cents` > 0; currency must be a known ISO code and equal the wallet currency; e.g. "Amount cents can't be blank", "Amount cents must be greater than 0" **[I]** texts.
- **Success:** **302** -> `/admin/cash_transactions`, notice "Saved expense <amount>." or "Saved income <amount>." where `<amount>` is `Money#format` of the amount in its currency (money-rails, i18n backend, `config/initializers/money.rb`; e.g. "10.00 zł" for PLN **[I]**) (`:139-143`). **[V]** [oracle](../oracle/http/POST_admin_cash_transactions.json) case `default -> 302`; `spec/requests/cash_spec.rb:96` (notice matches /expense/), `:119` (/income/).
- **Failure:** **422**, form re-rendered; flash.now alert = the joined error messages, or "Could not save the transaction." if empty. **[V]** case `invalid_amount -> 422`; `spec/requests/cash_spec.rb:135,150`.

<a id="route-get-admin-cash-transactions-id"></a>
#### `GET /admin/cash_transactions/:id`

- `#show` (`:28-30`). Lookup `for_user.find` -> 404 for other tenants. Always **302** -> `/admin/cash_transactions/:id/edit` (there is no show page). **[V]** [oracle](../oracle/http/GET_admin_cash_transactions__id.json) cases `default -> 302`, `other_tenant_id -> 404`; `spec/requests/cash_spec.rb:81`.

<a id="route-get-admin-cash-transactions-id-edit"></a>
#### `GET /admin/cash_transactions/:id/edit`

- `#edit` (`:58-67`). Guards in order: (1) tenant lookup -> 404; (2) non-manual row -> **302** `/admin/cash_transactions`, alert "This transaction was auto-generated and isn't editable here."; (3) hidden effective category (C12) -> 302 `/admin/cash_transactions`, alert "This transaction is in a hidden category. Remove it from the hidden list in preferences to edit it.". Otherwise 200, page "Edit cash transaction". **[V]** [oracle](../oracle/http/GET_admin_cash_transactions__id_edit.json) case `default -> 302` (row 1 is an ATM-link row; alert observed in `oracle/ui/admin_cash_transactions_edit.html`); `spec/requests/cash_spec.rb:163,173`.

<a id="route-patch-admin-cash-transactions-id"></a>
#### `PATCH /admin/cash_transactions/:id`

<a id="route-put-admin-cash-transactions-id"></a>
#### `PUT /admin/cash_transactions/:id`

- `#update` (`:69-82`). Session + CSRF. Guards (1) and (2) of edit apply (non-manual -> 302 with the same alert, updater not called **[V]** `spec/requests/cash_spec.rb:225`); the hidden-category guard does **not** apply to update **[I]** (see U-521). Same strong params as create; `currency` is dropped (a transaction cannot change currency/wallet) **[V]** `spec/requests/cash_spec.rb:188`. Delegates to `Cash::TransactionUpdater` (BR-300..399).
- Success: **302** `/admin/cash_transactions`, notice "Updated expense <amount>." / "Updated income <amount>.". Failure: **422** edit form, flash.now alert = errors or "Could not update the transaction.". **[V]** [oracle](../oracle/http/PATCH_admin_cash_transactions__id.json) case `default -> 302`; [oracle](../oracle/http/PUT_admin_cash_transactions__id.json) case `invalid_amount -> 422`; `spec/requests/cash_spec.rb:210`.

<a id="route-delete-admin-cash-transactions-id"></a>
#### `DELETE /admin/cash_transactions/:id`

- `#destroy` (`:84-87`). Guards (1) and (2). Hard-deletes the row and its enrichment (`has_one :enrichment, dependent: :destroy`, `app/models/concerns/ledger_entry_concern.rb:9-12`); **302** `/admin/cash_transactions`, notice "Transaction deleted.". Non-manual row: 302 with the auto-generated alert, row kept. **[V]** [oracle](../oracle/http/DELETE_admin_cash_transactions__id.json) case `default -> 302`; `spec/requests/cash_spec.rb:243,255`.

### A.11 Categories

Handler `Admin::CategoriesController` (`app/controllers/admin/categories_controller.rb`), route `config/routes.rb:64-69`
(`resources :categories, except: [:show]` + member `archive`, `unarchive`). All member routes look up `current_user.categories.find(id)`
-> 404 for other tenants (`:76-78`). Strong params: `params.expect(category: [name, slug, parent_path, kind, color, icon, position, essential])`
(`:80-82`). Category tree semantics (ltree `path`, slug, kind) belong to BR-200..299 (`Categories::Creator`, `Categories::Mover`).

<a id="route-get-admin-categories"></a>
#### `GET /admin/categories`

- `#index` (`:7-10`): the user's active categories in tree order and, separately, archived ones. No parameters. 200, page "Categories". **[V]** [oracle](../oracle/http/GET_admin_categories.json) case `default -> 200`; `spec/requests/categorization_spec.rb:6`, `:537` (anonymous); `spec/system/cross_user_isolation_spec.rb:68`.

<a id="route-get-admin-categories-new"></a>
#### `GET /admin/categories/new`

- `#new` (`:12-15`): blank category with `kind = "expense"`; query `parent_path` (optional, ltree path of the parent, e.g. `food`) pre-selects the parent. 200, page "New category". **[V]** [oracle](../oracle/http/GET_admin_categories_new.json) case `default -> 200`; `spec/requests/categorization_spec.rb:20`.

<a id="route-post-admin-categories"></a>
#### `POST /admin/categories`

- `#create` (`:17-31`), CSRF. `Categories::Creator` builds the category under `parent_path` (slug generated from the name if blank, path = `<parent_path>.<slug>`).
- Validation messages (Category): "Name can't be blank", "Slug has already been taken", "Slug must be lowercase letters, digits, underscores, dashes", "Kind is not included in the list" (allowed `expense, income, transfer, savings, ignored`), "Path must be lowercase letters, digits, underscores, dot-separated", "Path has already been taken" (`inventory/models.json` Category) **[I]**.
- Success **302** `/admin/categories`, notice "Category created.". Failure **422** new form with error summary. Missing token 422 (C5). **[V]** [oracle](../oracle/http/POST_admin_categories.json) cases `default -> 302`, `invalid_blank_name -> 422`, `missing_csrf_token -> 422`; `spec/requests/categorization_spec.rb:29,47`.

<a id="route-get-admin-categories-id-edit"></a>
#### `GET /admin/categories/:id/edit`

- `#edit` (`:33-38`). Hidden category (C12) -> 302 `/admin/categories`, alert "This category is private. Remove it from the hidden list in preferences to edit it.". 200 page titled with the category name. **[V]** [oracle](../oracle/http/GET_admin_categories__id_edit.json) cases `default -> 200`, `other_tenant_id -> 404`; `spec/requests/categorization_spec.rb:61,71,82` (alert matches /private/).

<a id="route-patch-admin-categories-id"></a>
#### `PATCH /admin/categories/:id`

<a id="route-put-admin-categories-id"></a>
#### `PUT /admin/categories/:id`

- `#update` (`:40-52`), CSRF. `Categories::Mover` applies attributes and, when `parent_path`/slug change, moves the subtree. No hidden-category guard on update **[I]** (see U-521).
- Success **302** `/admin/categories`, notice "Category updated." **[V]** `spec/system/settings_change_spec.rb:40`. Failure **422** edit form. **[V]** [oracle](../oracle/http/PATCH_admin_categories__id.json) case `default -> 302`; [oracle](../oracle/http/PUT_admin_categories__id.json) case `invalid_kind -> 422`; `spec/requests/categorization_spec.rb:94,111`.

<a id="route-delete-admin-categories-id"></a>
#### `DELETE /admin/categories/:id`

- `#destroy` (`:54-62`). If the category is in use (has descendants, is a merchant's default category, or is referenced by any enrichment; `app/models/category.rb:112-114`) -> **302** `/admin/categories`, alert "Can't delete - this category is in use or has sub-categories. Archive it instead."; else hard delete, 302, notice "Category deleted.". **[V]** [oracle](../oracle/http/DELETE_admin_categories__id.json) cases `other_tenant_id -> 404`, `default -> 302`; `spec/requests/categorization_spec.rb:125,138`.

<a id="route-post-admin-categories-id-archive"></a>
#### `POST /admin/categories/:id/archive`

- `#archive` (`:64-67`): sets `archived_at = now` unless already archived (`app/models/category.rb:79-81`); **302** `/admin/categories`, notice "Category archived.". **[V]** [oracle](../oracle/http/POST_admin_categories__id_archive.json) case `default -> 302`; `spec/requests/categorization_spec.rb:150`.

<a id="route-post-admin-categories-id-unarchive"></a>
#### `POST /admin/categories/:id/unarchive`

- `#unarchive` (`:69-72`): clears `archived_at`; **302** `/admin/categories`, notice "Category restored.". **[V]** [oracle](../oracle/http/POST_admin_categories__id_unarchive.json) case `default -> 302`; `spec/requests/categorization_spec.rb:161`.

### A.12 Merchants and merchant rules

Handler `Admin::MerchantsController` (`app/controllers/admin/merchants_controller.rb`), route `config/routes.rb:71-78`. Member lookup
`current_user.merchants.find(id)` -> 404 for other tenants (`:101-103`). Strong params `params.expect(merchant: [name, slug, kind, default_category_id,
logo_url, notes])` (`:105-107`). Note: `default_category_id` is not validated against the user's categories in the controller (see U-524).

<a id="route-get-admin-merchants"></a>
#### `GET /admin/merchants`

- `#index` (`:7-18`). Query params (optional): `show_archived=1` (include archived; otherwise only active), `source` (`system`/`user`/`llm`), `category_id` (default category), `q` (case-insensitive substring of `name`, SQL `ILIKE '%q%'`; `%`/`_` in q act as wildcards **[I]**), `page`. Ordered by name; shows per-merchant transaction counts. 200, page "Merchants". **[V]** [oracle](../oracle/http/GET_admin_merchants.json) cases `default -> 200`, `filtered -> 200`; `spec/requests/categorization_spec.rb:172,186,198`.

<a id="route-get-admin-merchants-new"></a>
#### `GET /admin/merchants/new`

- `#new` (`:44-46`): blank merchant with `source = "user"`, `kind = "company"`. 200, page "New merchant". **[V]** [oracle](../oracle/http/GET_admin_merchants_new.json) case `default -> 200`.

<a id="route-post-admin-merchants"></a>
#### `POST /admin/merchants`

- `#create` (`:48-56`), CSRF. `Merchants::Creator` (slug generated from name when blank, unique per user). Validation (Merchant): "Name can't be blank", slug present/unique/format `[a-z0-9_-]+`, kind in `company, person, charity, government, platform, other` **[I]**.
- Success **302** `/admin/merchants/:id`, notice "Merchant created.". Failure **422** new form. **[V]** [oracle](../oracle/http/POST_admin_merchants.json) cases `default -> 302`, `invalid_blank_name -> 422`; `spec/requests/categorization_spec.rb:244,259`.

<a id="route-get-admin-merchants-id"></a>
#### `GET /admin/merchants/:id`

- `#show` (`:20-35`). Hidden default category (C12) -> 302 `/admin/merchants`, alert "This merchant is in a hidden category. Remove it from the hidden list in preferences to open it.". Otherwise 200 with: rules (ordered by source, then priority desc), linked-transaction count, last 10 bank transactions of the merchant (booking date desc), and a new-rule form pre-filled `field = title`, `kind = contains`. **[V]** [oracle](../oracle/http/GET_admin_merchants__id.json) cases `default -> 200`, `other_tenant_id -> 404`; `spec/requests/categorization_spec.rb:210,220,231`.

<a id="route-get-admin-merchants-id-edit"></a>
#### `GET /admin/merchants/:id/edit`

- `#edit`. 200, page "Edit: <name>". The class defines `edit` twice (`:37-42` with a hidden-category guard, alert "This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it."; and `:58-59` empty). Ruby keeps the later definition, so **the hidden-category guard is never executed** **[I]** (see U-505). **[V]** [oracle](../oracle/http/GET_admin_merchants__id_edit.json) case `default -> 200`.

<a id="route-patch-admin-merchants-id"></a>
#### `PATCH /admin/merchants/:id`

<a id="route-put-admin-merchants-id"></a>
#### `PUT /admin/merchants/:id`

- `#update` (`:61-71`), CSRF. Param `return_to` (optional, A.4). Updates the merchant; a default-category change is only logged (transactions inherit it through the effective category at read time).
- Success **302** to `safe_return_to(default: /admin/merchants/:id)`, notice "Merchant updated.". Failure **422** edit form. **[V]** [oracle](../oracle/http/PATCH_admin_merchants__id.json) cases `default -> 302`, `other_tenant_id -> 404`; [oracle](../oracle/http/PUT_admin_merchants__id.json) case `invalid_blank_name -> 422`; `spec/requests/categorization_spec.rb:273,286`.

<a id="route-delete-admin-merchants-id"></a>
#### `DELETE /admin/merchants/:id`

- `#destroy` (`:73-81`), CSRF. If any enrichment references the merchant -> **302** `/admin/merchants/:id`, alert "Can't delete - this merchant has linked transactions. Archive it instead."; else hard delete (its rules are deleted with it, `app/models/merchant.rb:51`), **302** `safe_return_to(default: /admin/merchants)`, notice "Merchant deleted.". Used by the AI Enrichment page to reject LLM proposals (with `return_to=/admin/llm_enrichments#awaiting-approval`, `app/views/admin/llm_enrichments/index.html.erb:141-148`). **[V]** [oracle](../oracle/http/DELETE_admin_merchants__id.json) case `default -> 302`; `spec/requests/categorization_spec.rb:299,314`.

<a id="route-post-admin-merchants-id-archive"></a>
#### `POST /admin/merchants/:id/archive`

- `#archive` (`:83-86`): `archived_at = now`; **302** `safe_return_to(default: /admin/merchants)`, notice "Merchant archived.". Archived merchants' rules stop matching (UI confirm text "Archive this merchant? Its rules will stop matching.") **[I]**. **[V]** [oracle](../oracle/http/POST_admin_merchants__id_archive.json) case `default -> 302`; `spec/requests/categorization_spec.rb:324`.

<a id="route-post-admin-merchants-id-unarchive"></a>
#### `POST /admin/merchants/:id/unarchive`

- `#unarchive` (`:88-91`): `archived_at = nil`; **302** `safe_return_to(default: /admin/merchants/:id)`, notice "Merchant restored.". **[V]** [oracle](../oracle/http/POST_admin_merchants__id_unarchive.json) case `default -> 302`.

<a id="route-post-admin-merchants-id-approve"></a>
#### `POST /admin/merchants/:id/approve`

- `#approve` (`:93-97`): `Merchants::Approver` (in one transaction: sets `approved_at = now`, `approved_by = current user` on the merchant and enables + approves its disabled `llm` rules; then rebuilds all of the user's classifications; BR-200..299, `app/services/merchants/approver.rb:14-23`). **302** `safe_return_to(default: /admin/merchants/:id)`, notice "Approved - historical transactions re-classified.". **[V]** [oracle](../oracle/http/POST_admin_merchants__id_approve.json) case `default -> 302`; `spec/requests/categorization_spec.rb:334`.

Merchant rules: handler `Admin::MerchantRulesController` (`app/controllers/admin/merchant_rules_controller.rb`), nested under the merchant
(`config/routes.rb:77`). The merchant is looked up via `current_user.merchants.find(merchant_id)` (404 for other tenants) and the rule via
`merchant.merchant_rules.find(id)` (404 if the rule belongs to another merchant) (`:33-39`). Strong params
`params.expect(merchant_rule: [kind, field, pattern, case_sensitive, priority, enabled])` (`:41-43`). All three actions always answer **302**
-> `/admin/merchants/:merchant_id` (never 422), with the outcome in the flash.

<a id="route-post-admin-merchants-merchant-id-merchant-rules"></a>
#### `POST /admin/merchants/:merchant_id/merchant_rules`

- `#create` (`:8-15`): `MerchantRules::Creator` creates a rule with `source = "user"`, approved by the current user now, then rebuilds all of the user's classifications. Validation: kind in `contains, regex, exact, prefix, iban`; field in `title, counterparty_name, counterparty_iban, payment_method`; pattern present; regex must compile ("Pattern is not a valid regex: <Ruby RegexpError message>"; note the Kotlin regex engine differs, see U-525).
- Success notice "Rule added - historical transactions re-classified."; failure alert "Could not add rule: <joined errors>". **[V]** [oracle](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json) cases `default -> 302`, `invalid_regex -> 302`; `spec/requests/categorization_spec.rb:348,365`.

<a id="route-patch-admin-merchants-merchant-id-merchant-rules-id"></a>
#### `PATCH /admin/merchants/:merchant_id/merchant_rules/:id`

<a id="route-put-admin-merchants-merchant-id-merchant-rules-id"></a>
#### `PUT /admin/merchants/:merchant_id/merchant_rules/:id`

- `#update` (`:17-24`): `MerchantRules::Updater` updates and rebuilds. Success notice "Rule updated."; failure alert "Could not update rule: <joined errors>" (e.g. "Could not update rule: Pattern can't be blank"). **[V]** [oracle](../oracle/http/PATCH_admin_merchants__merchant_id_merchant_rules__id.json) case `default -> 302`; [oracle](../oracle/http/PUT_admin_merchants__merchant_id_merchant_rules__id.json) case `invalid_blank_pattern -> 302`; `spec/requests/categorization_spec.rb:380`.

<a id="route-delete-admin-merchants-merchant-id-merchant-rules-id"></a>
#### `DELETE /admin/merchants/:merchant_id/merchant_rules/:id`

- `#destroy` (`:26-29`): `MerchantRules::Destroyer` deletes and re-classifies; notice "Rule deleted - transactions re-classified.". **[V]** [oracle](../oracle/http/DELETE_admin_merchants__merchant_id_merchant_rules__id.json) case `default -> 302`; `spec/requests/categorization_spec.rb:396`.

### A.13 AI (LLM) enrichment runs

Handler `Admin::LlmEnrichmentsController` (`app/controllers/admin/llm_enrichments_controller.rb`), route `config/routes.rb:81`. Runs are
`OperationRun` rows with `kind = "llm_enrichment"` and `triggered_by_user_id = current_user.id` (`:46-48`). Business rules BR-200..299
(`LlmEnrichments::Queuer`, `Llm::EnrichmentRunner`, `Llm::EnrichableQuery`).

<a id="route-get-admin-llm-enrichments"></a>
#### `GET /admin/llm_enrichments`

- `#index` (`:7-26`), page "AI Enrichment". Shows: count of the user's merchantless enrichments; count of LLM-eligible transactions; number of distinct (normalised title, counterparty) groups among them (= approximate number of LLM calls; empty/empty excluded) and the number of groups not already covered by a rule; whether an LLM API key is configured; LLM-proposed merchants awaiting approval (`source = "llm"`, `approved_at` null, newest first) with approve/reject actions; and the paginated run history (default sort `created_at desc`, Ransack `q`, `page`). **[V]** [oracle](../oracle/http/GET_admin_llm_enrichments.json) case `default -> 200`; `spec/requests/categorization_spec.rb:479` (own runs only); `spec/system/llm_enrichment_spec.rb:35-60`.

<a id="route-post-admin-llm-enrichments"></a>
#### `POST /admin/llm_enrichments`

- `#create` (`:32-42`), CSRF. Param `limit` (form, optional integer; blank -> 50 = `Llm::EnrichmentRunner::DEFAULT_LIMIT`, max groups per run; non-numeric -> `to_i` = 0 **[I]**).
- Not configured (no API key) -> **302** `/admin/settings/preferences/llm`, alert "Configure an LLM provider in Preferences before running enrichment.". Otherwise creates a queued run (`trigger = "manual"`, subject = the user, params `{"limit": n}`), enqueues `LlmEnrichmentJob`, **302** `/admin/llm_enrichments/:run_id`, notice "Run #<id> queued.". **[V]** [oracle](../oracle/http/POST_admin_llm_enrichments.json) case `default -> 302` (run 11 created, later `succeeded`, `oracle/operation_runs_after_capture.jsonl`); `spec/requests/categorization_spec.rb:494,506`.

<a id="route-get-admin-llm-enrichments-id"></a>
#### `GET /admin/llm_enrichments/:id`

- `#show` (`:28-30`). Run looked up among the user's `llm_enrichment` runs -> 404 for others' runs or other kinds. 200, page "AI Enrichment Run #<id>" (live progress view). **[V]** [oracle](../oracle/http/GET_admin_llm_enrichments__id.json) case `default -> 200`; `spec/system/cross_user_isolation_spec.rb:83` (foreign run -> 404).

### A.14 Analytics pages

Handlers under `Admin::Analytics` (`app/controllers/admin/analytics/*`), routes `config/routes.rb:83-87`. Every action first builds
`Analytics::Filter` from the query string (`app/controllers/admin/analytics/base_controller.rb:10-12`); all computations and money rules are
BR-300..399 (`Analytics::CashFlow`, `SpendBreakdown`, `TopMerchants`, `AccountBreakdown`, `FacetBreakdown`, `TopMovers`). Common query parameters
(`app/services/analytics/filter.rb`):

| Param | Meaning |
|---|---|
| `from`, `to` | Date range, inclusive. Only used when **both** are present; otherwise month-to-date (first day of the current UTC month .. today). Unparseable value -> today. `from > to` raises in `Analytics::Period` ("from must be <= to") -> 500 **[I]** (see U-515) |
| `currency` | ISO code (upper-cased); only honoured if it is one of the user's available currencies, else the dominant currency is used |
| `bucket` | time bucket for the series (one of `Analytics::Period::BUCKETS`); default depends on range length |
| `under_path` | category ltree path to drill into (dashboard only) |
| `accounts=none`, `account_ids[]` | account selection |

<a id="route-get-admin-analytics"></a>
#### `GET /admin/analytics`

- `Admin::Analytics::DashboardController#index` (`app/controllers/admin/analytics/dashboard_controller.rb:6-76`); `/admin` redirects here. Page "Analytics". Computes spend, income, net, previous-period spend and delta %, savings rate %, average daily spend (integer cents division), month-to-date run-rate (only from day 3 of the month: spend × days_in_month / days_elapsed, rounded), previous full month spend, cash-flow series, category breakdown, top 8 merchants, per-account breakdown, domain breakdown at the filter's aggregation depth, essential vs discretionary split, top 5 movers, top 5 largest spend transactions, and an "unmatched debits" banner (count, amount, share % of spend+unmatched, rounded). Percentages are rounded half away from zero to integers; delta % and savings rate are `nil` (not shown) when the denominator is 0.
- Responses: 200; anonymous 302 sign-in; legacy browser 406; empty instance 302 `/setup`. **[V]** [oracle](../oracle/http/GET_admin_analytics.json) cases `anonymous_redirects_to_sign_in -> 302`, `legacy_browser_ua -> 406`, `default -> 200`, `explicit_range -> 200`, `no_users_redirects_to_setup -> 302`; `spec/requests/analytics_spec.rb:6,15,24,34,43,140`; `spec/system/daily_login_analytics_spec.rb:25-28`.

<a id="route-get-admin-analytics-categories-slug"></a>
#### `GET /admin/analytics/categories/:slug`

- `Admin::Analytics::CategoriesController#show` (`app/controllers/admin/analytics/categories_controller.rb:6-26`). Path `slug` (category slug, unique per user). `current_user.categories.find_by!(slug:)` -> 404 for unknown or other tenants' slugs. Hidden category (C12) -> 302 `/admin/analytics?<filter params>`, alert "This category is private. Remove it from the hidden list in preferences to open it.". Otherwise 200: spend by merchant in the category, total, sub-category breakdown if it has descendants, breadcrumbs (hidden ancestors omitted) that keep the filter params.
- **[V]** [oracle](../oracle/http/GET_admin_analytics_categories__slug.json) cases `default -> 200`, `unknown_slug -> 404`; `spec/requests/analytics_spec.rb:55,65,74,85`; `spec/system/cross_user_isolation_spec.rb:97`.

<a id="route-get-admin-analytics-merchants-slug"></a>
#### `GET /admin/analytics/merchants/:slug`

- `Admin::Analytics::MerchantsController#show` (`app/controllers/admin/analytics/merchants_controller.rb:6-39`). `current_user.merchants.find_by!(slug:)` -> 404. Hidden default category -> 302 `/admin/analytics?<filter params>`, alert "This merchant is in a hidden category. Remove it from the hidden list in preferences to open it.". Otherwise 200: total spend and count in the period, paginated spend transactions (booking date desc, `page`), monthly trend in the filter currency, breadcrumbs (merchant name marked sensitive for the privacy mask).
- **[V]** [oracle](../oracle/http/GET_admin_analytics_merchants__slug.json) case `default -> 200`; `spec/requests/analytics_spec.rb:97,107,116,127`.

<a id="route-get-admin-matching-engine"></a>
#### `GET /admin/matching_engine`

- `Admin::MatchingEngineController#show` (`app/controllers/admin/matching_engine_controller.rb:5-36`), route `config/routes.rb:91`. Read-only debugging view of the classification pipeline: the user's merchant rules in execution order (source rank user=2, llm=1, system=0 desc, then priority desc, then id asc), paginated (`page`), with per-rule match counts and totals over all rules; the payment-method fallback map (`Enrichment::TransactionEnricher::PAYMENT_METHOD_FALLBACK`) with the matching user categories and per (direction, payment_method) counts over bank and cash enrichments with `source = "system_fallback"`; unmatched and total enrichment counts. 200, page "Matching engine". **[V]** [oracle](../oracle/http/GET_admin_matching_engine.json) case `default -> 200`; `spec/requests/categorization_spec.rb:522`.

### A.15 Transaction syncs and auto-sync schedules

Handler `Admin::TransactionSyncsController` (`app/controllers/admin/transaction_syncs_controller.rb`), route `config/routes.rb:95`. Runs are
`OperationRun` rows with `kind = "transaction_sync"` and `triggered_by_user_id = current_user.id` (`:45-47`). BR-001..199
(`TransactionSyncs::Queuer`, `TransactionSyncJob`, `EnableBanking::BackfillWindow`).

<a id="route-get-admin-transaction-syncs"></a>
#### `GET /admin/transaction_syncs`

- `#index` (`:9-14`), page "Sync Transactions": the user's sync runs (paginated, Ransack over OperationRun `id, kind, status, trigger, subject_type, subject_id, triggered_by_user_id, started_at, finished_at, created_at, updated_at`, default `created_at desc`) and the auto-sync schedule of each active connection of the user (ordered by bank name). **[V]** [oracle](../oracle/http/GET_admin_transaction_syncs.json) case `default -> 200`; `spec/requests/banking_spec.rb:390`.

<a id="route-get-admin-transaction-syncs-new"></a>
#### `GET /admin/transaction_syncs/new`

- `#new` (`:21-25`): form with the user's active connections; default `date_from` = today − 90 days (`EnableBanking::BackfillWindow::DEFAULT_DAYS = 90`), `date_to` = today (UTC). 200, page "New sync". **[V]** [oracle](../oracle/http/GET_admin_transaction_syncs_new.json) case `default -> 200`; `spec/requests/banking_spec.rb:415`.

<a id="route-post-admin-transaction-syncs"></a>
#### `POST /admin/transaction_syncs`

- `#create` (`:27-41`), CSRF. Params (top-level form fields, not nested): `bank_connection_id` (optional), `date_from`, `date_to` (optional dates as strings; stored only when present). The connection is resolved among the user's **active** connections; blank, foreign, inactive or unknown id -> the run's subject becomes the user (sync of all the user's connections) instead of an error (see U-512). No validation of `date_from <= date_to`.
- Creates a queued run (`trigger = "manual"`), enqueues `TransactionSyncJob`, **302** `/admin/transaction_syncs/:run_id`, notice "Sync #<id> queued.". On run-creation failure: **302** `/admin/transaction_syncs/new`, alert "Could not start sync: <errors>". **[V]** [oracle](../oracle/http/POST_admin_transaction_syncs.json) cases `default -> 302` (run 12, subject BankConnection 1), `missing_connection -> 302` (run 13, subject `User` 1, `oracle/operation_runs_after_capture.jsonl`); `spec/requests/banking_spec.rb:429,446`.

<a id="route-get-admin-transaction-syncs-id"></a>
#### `GET /admin/transaction_syncs/:id`

- `#show` (`:16-19`): run among the user's sync runs (404 otherwise), with per-account rows from `summary["accounts"]`. 200, page "Sync #<id>". **[V]** [oracle](../oracle/http/GET_admin_transaction_syncs__id.json) case `default -> 200`; `spec/requests/banking_spec.rb:404` (foreign run -> 404).

Auto-sync schedule: handler `Admin::SyncSchedulesController` (`app/controllers/admin/sync_schedules_controller.rb`), singular nested resource
(`config/routes.rb:113`). Connection looked up via `BankConnection.for_user(current_user).find(bank_connection_id)` -> 404 (`:30-32`).

<a id="route-get-admin-bank-connections-bank-connection-id-sync-schedule-edit"></a>
#### `GET /admin/bank_connections/:bank_connection_id/sync_schedule/edit`

- `#edit` (`:7-9`): existing schedule or an unsaved default one. 200, page "Auto-sync settings". **[V]** [oracle](../oracle/http/GET_admin_bank_connections__bank_connection_id_sync_schedule_edit.json) case `default -> 200`; `spec/requests/banking_spec.rb:458,469`.

<a id="route-patch-admin-bank-connections-bank-connection-id-sync-schedule"></a>
#### `PATCH /admin/bank_connections/:bank_connection_id/sync_schedule`

<a id="route-put-admin-bank-connections-bank-connection-id-sync-schedule"></a>
#### `PUT /admin/bank_connections/:bank_connection_id/sync_schedule`

- `#update` (`:11-26`), CSRF. Strong params `params.expect(sync_schedule: [enabled, cadence, preferred_hour])`. `AutoSync::ScheduleUpserter` (BR-001..199): `enabled` cast to boolean (`"1"`, `"true"` -> true; missing -> false/nil), blank `cadence`/unparseable `preferred_hour` keep the previous value; validation: cadence in `daily, every_2_days, weekly` ("Cadence is not included in the list"), preferred_hour integer in 0..23 ("Preferred hour must be in 0..23") **[I]** texts. `next_run_at` is recomputed (in the user's time zone, which falls back to UTC because `User` has no `timezone` attribute) only when timing changed or the schedule was re-enabled.
- Success **302** `/admin/transaction_syncs`, notice "Auto-sync settings saved.". Failure **422** edit form, flash.now alert = joined errors or "Could not save.". **[V]** [oracle](../oracle/http/PATCH_admin_bank_connections__bank_connection_id_sync_schedule.json) case `default -> 302`; [oracle](../oracle/http/PUT_admin_bank_connections__bank_connection_id_sync_schedule.json) case `invalid -> 422`; `spec/requests/banking_spec.rb:480,502`.

### A.16 TPP credentials (Enable Banking application credentials)

Handler `Admin::TppCredentialsController` (`app/controllers/admin/tpp_credentials_controller.rb`), route `config/routes.rb:101-106`. Member lookup
`current_user.tpp_credentials.find(id)` -> 404 (`:66-68`). Strong params `params.expect(tpp_credential: [name, provider, environment, redirect_url,
application_id, private_key_pem, public_cert_pem])` (`:70-75`); `private_key_pem` and `application_id` are encrypted at rest and excluded from the
audit trail (ADR 0004). BR-001..199.

<a id="route-get-admin-tpp-credentials"></a>
#### `GET /admin/tpp_credentials`

- `#index` (`:7-9`): the user's credentials, paginated, Ransack (`id, name, provider, environment, status, primary, redirect_url, cert_expires_at, last_verified_at, user_id, created_at, updated_at`), default `created_at desc`. 200, page "TPP Credentials". **[V]** [oracle](../oracle/http/GET_admin_tpp_credentials.json) case `default -> 200`; `spec/requests/banking_spec.rb:6`.

<a id="route-get-admin-tpp-credentials-new"></a>
#### `GET /admin/tpp_credentials/new`

- `#new` (`:14-16`): defaults `provider = "enable_banking"`, `environment = "PRODUCTION"`. 200, page "New TPP credential". **[V]** [oracle](../oracle/http/GET_admin_tpp_credentials_new.json) case `default -> 200`; `spec/requests/banking_spec.rb:25`.

<a id="route-post-admin-tpp-credentials"></a>
#### `POST /admin/tpp_credentials`

- `#create` (`:18-29`), CSRF. The user's first credential is automatically marked primary; later ones are not. Validation (TppCredential): name, provider (`enable_banking` only), status, application_id, private_key_pem, redirect_url present; environment in `PRODUCTION, SANDBOX` (blank allowed); only one primary per user ("Primary another credential is already primary for this user") **[I]** texts.
- Success **302** `/admin/tpp_credentials/:id`, notice `TPP credential created. Run "Test connection" to verify it works.`. Failure **422** new form. **[V]** [oracle](../oracle/http/POST_admin_tpp_credentials.json) cases `default -> 302`, `invalid_blank_name -> 422`; `spec/requests/banking_spec.rb:35,55,75`.

<a id="route-get-admin-tpp-credentials-id"></a>
#### `GET /admin/tpp_credentials/:id`

- `#show` (`:11-12`). 200, page titled with the credential name. **[V]** [oracle](../oracle/http/GET_admin_tpp_credentials__id.json) cases `default -> 200`, `other_tenant_id -> 404`; `spec/system/cross_user_isolation_spec.rb:38`.

<a id="route-get-admin-tpp-credentials-id-edit"></a>
#### `GET /admin/tpp_credentials/:id/edit`

- `#edit` (`:31-32`). 200, page "Edit credential". **[V]** [oracle](../oracle/http/GET_admin_tpp_credentials__id_edit.json) case `default -> 200`.

<a id="route-patch-admin-tpp-credentials-id"></a>
#### `PATCH /admin/tpp_credentials/:id`

<a id="route-put-admin-tpp-credentials-id"></a>
#### `PUT /admin/tpp_credentials/:id`

- `#update` (`:34-40`), CSRF. Success **302** `/admin/tpp_credentials/:id`, notice "Updated.". Failure **422** edit form (e.g. "Environment is not included in the list"). **[V]** [oracle](../oracle/http/PATCH_admin_tpp_credentials__id.json) case `default -> 302`; [oracle](../oracle/http/PUT_admin_tpp_credentials__id.json) case `invalid_environment -> 422`.

<a id="route-delete-admin-tpp-credentials-id"></a>
#### `DELETE /admin/tpp_credentials/:id`

- `#destroy` (`:42-50`). If any bank connection references the credential -> **302** `/admin/tpp_credentials/:id`, alert "Cannot delete - credential has bank connections. Remove them first."; else delete, **302** `/admin/tpp_credentials`, notice "Credential deleted.". **[V]** [oracle](../oracle/http/DELETE_admin_tpp_credentials__id.json) case `default -> 302`; `spec/requests/banking_spec.rb:87,100`.

<a id="route-post-admin-tpp-credentials-id-test-connection"></a>
#### `POST /admin/tpp_credentials/:id/test_connection`

- `#test_connection` (`:52-56`), CSRF. `EnableBanking::Operations::VerifyCredential` calls the provider's "get application" endpoint and never raises. Always **302** `/admin/tpp_credentials/:id`; flash key `alert` when failed, else `notice`. Messages (`app/services/enable_banking/operations/verify_credential.rb`): failure "Test failed: <provider error>" (credential status -> `error`) or "Configuration error: <error>"; success "Connection verified - metadata refreshed." optionally followed by " Local redirect_url updated to match EB: <url>" (when the provider has exactly one registered redirect URL and it differs) or by a warning "[U+26A0 WARNING SIGN] Local redirect_url (<url>) is NOT in EB list. Choose one of: <comma-separated urls>" (warning is still shown as notice). **[V]** [oracle](../oracle/http/POST_admin_tpp_credentials__id_test_connection.json) case `default -> 302`; `spec/requests/banking_spec.rb:111,126` (flash routing; `"Test failed: boom"` as alert).

<a id="route-post-admin-tpp-credentials-id-make-primary"></a>
#### `POST /admin/tpp_credentials/:id/make_primary`

- `#make_primary` (`:58-62`): in one transaction un-flags all other credentials of the user and flags this one (`app/models/tpp_credential.rb:105-110`); **302** `/admin/tpp_credentials/:id`, notice "<name> is now the primary credential.". **[V]** [oracle](../oracle/http/POST_admin_tpp_credentials__id_make_primary.json) case `default -> 302`; `spec/requests/banking_spec.rb:140`.

### A.17 Bank connections

Handler `Admin::BankConnectionsController` (`app/controllers/admin/bank_connections_controller.rb`), route `config/routes.rb:108-114`. Member
lookup `BankConnection.for_user(current_user).find(id)` (connection whose credential belongs to the user) -> 404 (`:111-113`). `new`/`create`
require a primary TPP credential, else **302** `/admin/tpp_credentials`, alert "Configure a primary TPP credential before connecting banks."
(`:103-109`) **[V]** `spec/requests/banking_spec.rb:172`. BR-001..199 (`EnableBanking::Operations::*`).

<a id="route-get-admin-bank-connections"></a>
#### `GET /admin/bank_connections`

- `#index` (`:8-10`): the user's connections, paginated, Ransack (`id, bank_slug, bank_country, bank_name, status, psu_type, valid_until, authorized_at, last_refreshed_at, last_synced_at, closed_at, access_balances, access_transactions, tpp_credential_id, replaces_id, created_at, updated_at`), default sort `valid_until asc`. 200, page "Bank Connections". **[V]** [oracle](../oracle/http/GET_admin_bank_connections.json) case `default -> 200`; `spec/requests/banking_spec.rb:153,518`.

<a id="route-get-admin-bank-connections-new"></a>
#### `GET /admin/bank_connections/new`

- `#new` (`:26-41`). Query params: `aspsp_name` (bank name, optional), `aspsp_country` (default `PL`), `psu_type` (default `personal`), `replaces` (id of a connection being re-authorised; kept only if it is one of the user's connections, else ignored, `:92-97`). Calls `EnableBanking::Api::ListAspsps(country)` with the primary credential; banks are listed sorted case-insensitively by name. Provider failure -> **302** `/admin/bank_connections`, alert "Couldn't load bank list: <error>". 200, page "Add bank connection"; the form posts with Turbo disabled (full page navigation, needed for the off-site redirect). **[V]** [oracle](../oracle/http/GET_admin_bank_connections_new.json) cases `default -> 200`, `with_aspsp -> 200`; `spec/requests/banking_spec.rb:182,199,212`.

<a id="route-post-admin-bank-connections"></a>
#### `POST /admin/bank_connections`

- `#create` (`:43-61`), CSRF. Params: `bank_connection_request_form[aspsp_name]` (required), `[aspsp_country]` (required, default `PL`), `[psu_type]` (`personal`/`business`), `[valid_days]` (integer 1..180, default 180) (`app/forms/bank_connection_request_form.rb`), and top-level `replaces_connection_id` (optional, sanitised as above).
- Success: `EnableBanking::Operations::StartAuth` obtains the bank authorisation URL (embedding the signed `state`, see `GET /callback`) and the action answers **303 See Other** with `Location` = the external bank URL (`allow_other_host: true`). **[V]** [oracle](../oracle/http/POST_admin_bank_connections.json) case `default -> 303` (Location `https://fake.enablebanking.test/auth?state=...`); `spec/requests/banking_spec.rb:227`.
- Provider failure (`StartAuth::Failed`, "Failed to start auth: <error>") -> **302** `/admin/bank_connections/new`, alert = message. **[V]** `spec/requests/banking_spec.rb:243`.
- Invalid form: the code sets flash.now alert to the joined errors (e.g. "Aspsp name can't be blank") and calls `new`, intending to re-render the form, but no template is rendered for `create`, so Rails answers **204 No Content** with an empty body; the browser stays on the form without feedback (see U-502, BUG?). **[V]** [oracle](../oracle/http/POST_admin_bank_connections.json) case `invalid_blank_aspsp -> 204`; `oracle/server.log.txt:15001` ("No template found for Admin::BankConnectionsController#create, rendering head :no_content").

<a id="route-get-admin-bank-connections-id"></a>
#### `GET /admin/bank_connections/:id`

- `#show` (`:12-13`). 200, page titled with the bank name (accounts, validity, status, actions refresh / re-authorise / close / auto-sync). **[V]** [oracle](../oracle/http/GET_admin_bank_connections__id.json) cases `default -> 200`, `other_tenant_id -> 404`; `spec/system/cross_user_isolation_spec.rb:28`.

<a id="route-get-admin-bank-connections-id-edit"></a>
#### `GET /admin/bank_connections/:id/edit`

- `#edit` (`:15-16`). 200, page "Edit connection" (fields `valid_until`, `status`). **[V]** [oracle](../oracle/http/GET_admin_bank_connections__id_edit.json) case `default -> 200`.

<a id="route-patch-admin-bank-connections-id"></a>
#### `PATCH /admin/bank_connections/:id`

<a id="route-put-admin-bank-connections-id"></a>
#### `PUT /admin/bank_connections/:id`

- `#update` (`:18-24`), CSRF. Strong params `params.expect(bank_connection: [valid_until, status])`. Manual override of the connection's validity and status; status must be one of the lower-case values `pending, authorized, expired, revoked, replaced, error, closed` ("Status is not included in the list"); upper-case `AUTHORIZED` is rejected. Success **302** `/admin/bank_connections/:id`, notice "Updated."; failure **422** edit form. **[V]** [oracle](../oracle/http/PATCH_admin_bank_connections__id.json) case `default -> 422` (`status=AUTHORIZED`); [oracle](../oracle/http/PUT_admin_bank_connections__id.json) case `invalid_status -> 422`. Intent of this manual override: see U-511.

<a id="route-delete-admin-bank-connections-id"></a>
#### `DELETE /admin/bank_connections/:id`

- `#destroy` (`:63-66`), CSRF. Does **not** delete the row: `EnableBanking::Operations::CloseConnection` closes the provider session and marks the connection closed. **302** `/admin/bank_connections`, notice "Connection closed.". **[V]** [oracle](../oracle/http/DELETE_admin_bank_connections__id.json) cases `other_tenant_id -> 404`, `own_connection -> 302`; `spec/requests/banking_spec.rb:262`.

<a id="route-post-admin-bank-connections-id-refresh"></a>
#### `POST /admin/bank_connections/:id/refresh`

- `#refresh` (`:68-75`): `EnableBanking::Operations::RefreshConnection` re-reads the session status from the provider. **302** `/admin/bank_connections/:id`, notice "Refreshed - status: <status>, valid until <YYYY-MM-DD or empty>."; on `RefreshConnection::Failed` alert "Refresh failed: <message>". **[V]** [oracle](../oracle/http/POST_admin_bank_connections__id_refresh.json) case `default -> 302`; `spec/requests/banking_spec.rb:275` (alert contains the provider error "HTTP 500").

<a id="route-post-admin-bank-connections-id-reauth"></a>
#### `POST /admin/bank_connections/:id/reauth`

- `#reauth` (`:77-84`): no provider call. **302** `/admin/bank_connections/new?aspsp_country=<bank_country>&aspsp_name=<bank_name>&psu_type=<psu_type>&replaces=<id>` (query keys sorted alphabetically, form-encoded), notice "Re-authorize via the bank - the old connection will be marked as replaced when the new one is approved.". **[V]** [oracle](../oracle/http/POST_admin_bank_connections__id_reauth.json) case `default -> 302`; `spec/requests/banking_spec.rb:288`; `spec/system/connection_expiry_reauth_spec.rb:40`.

### A.18 Bank accounts

Handler `Admin::BankAccountsController` (`app/controllers/admin/bank_accounts_controller.rb`), route `config/routes.rb:116-121`. Scoping:
accounts joined to a TPP credential of the user (`:31-36`); cash wallets (no credential) are therefore not listed here.

<a id="route-get-admin-bank-accounts"></a>
#### `GET /admin/bank_accounts`

- `#index` (`:7-10`): paginated, Ransack (`id, uid, iban, bban, currency, name, product, details, cash_account_type, usage, status, manual, details_fetched_at, balances_synced_at, transactions_synced_at, tpp_credential_id, manual_owner_id, current_bank_connection_id, created_at, updated_at`), default `created_at desc`. 200, page "Bank Accounts". **[V]** [oracle](../oracle/http/GET_admin_bank_accounts.json) case `default -> 200`; `spec/requests/banking_spec.rb:303`.

<a id="route-get-admin-bank-accounts-id"></a>
#### `GET /admin/bank_accounts/:id`

- `#show` (`:12-13`): 200, title "Bank account <uid>", h1 = account holder/name. Other tenant -> 404. **[V]** [oracle](../oracle/http/GET_admin_bank_accounts__id.json) case `default -> 200`; `spec/requests/banking_spec.rb:317`; `spec/system/cross_user_isolation_spec.rb:48`.

<a id="route-post-admin-bank-accounts-id-refresh-details"></a>
#### `POST /admin/bank_accounts/:id/refresh_details`

- `#refresh_details` (`:15-20`): `EnableBanking::Operations::RefreshAccountDetails`. **302** `/admin/bank_accounts/:id`, notice "Account details refreshed." or alert "Refresh failed: <message>". **[V]** [oracle](../oracle/http/POST_admin_bank_accounts__id_refresh_details.json) case `default -> 302`; `spec/requests/banking_spec.rb:328`.

<a id="route-post-admin-bank-accounts-id-refresh-balances"></a>
#### `POST /admin/bank_accounts/:id/refresh_balances`

- `#refresh_balances` (`:22-27`): `EnableBanking::Operations::RefreshAccountBalances`. **302** `/admin/bank_accounts/:id`, notice "Balances refreshed." or alert "Refresh failed: <message>". **[V]** [oracle](../oracle/http/POST_admin_bank_accounts__id_refresh_balances.json) case `default -> 302`; `spec/requests/banking_spec.rb:341`.

### A.19 Settings: preferences

Handler `Admin::Settings::PreferencesController` (`app/controllers/admin/settings/preferences_controller.rb`), routes `config/routes.rb:133-143`.
Every action operates on the signed-in user only (`@user = current_user`, `:6,87-89`); there are no ids in the paths. All preference pages share
the page title/h1 "Preferences" with a side navigation of the sections Profile, App, LLM, Data exchange, API tokens
(`Admin::BaseHelper#preferences_sections`). Failures re-render the section with **422** and a flash.now alert containing the joined full
error messages.

<a id="route-get-admin-settings-preferences-profile"></a>
#### `GET /admin/settings/preferences/profile`

- `#profile` (`:8`). Shows the profile form (name; email read-only) and the change-password form. 200. **[V]** [oracle](../oracle/http/GET_admin_settings_preferences_profile.json) case `default -> 200`; `spec/requests/settings_spec.rb:6,426`.

<a id="route-patch-admin-settings-preferences-profile"></a>
#### `PATCH /admin/settings/preferences/profile`

- `#update_profile` (`:10-17`), CSRF. Strong params `params.require(:user).permit(:name)` (`:100-102`) — only the display name can be changed here (email cannot be changed anywhere in the UI **[I]**).
- Success **302** `/admin/settings/preferences/profile`, notice "Profile saved.". Blank name -> **422**, alert "Name can't be blank". **[V]** [oracle](../oracle/http/PATCH_admin_settings_preferences_profile.json) cases `default -> 302`, `invalid_blank_name -> 422`; `spec/requests/settings_spec.rb:15,26`; alert text **[I]**.

<a id="route-patch-admin-settings-preferences-password"></a>
#### `PATCH /admin/settings/preferences/password`

- `#update_password` (`:19-29`), CSRF. Strong params `user: [current_password, password, password_confirmation]` (`:104-106`). Devise `update_with_password`: `current_password` must match ("Current password is invalid" / "Current password can't be blank"), new password 6..128 chars and confirmed.
- Success: the session is re-bound (`bypass_sign_in`) so the user stays signed in although remember-me tokens rotate; **302** `/admin/settings/preferences/profile`, notice "Password changed.". Failure: **422** profile page, alert = joined errors (e.g. "Current password is invalid", "Password is too short (minimum is 6 characters)"), user stays signed in. **[V]** [oracle](../oracle/http/PATCH_admin_settings_preferences_password.json) cases `wrong_current_password -> 422`, `too_short -> 422`; `spec/requests/settings_spec.rb:36,54`; texts **[I]**.

<a id="route-get-admin-settings-preferences-app"></a>
#### `GET /admin/settings/preferences/app`

- `#app` (`:31`). Form with `track_cash` (opt-in cash tracking, ADR 0006), `reveal_hidden_categories`, and a multi-select of hidden categories. 200. **[V]** [oracle](../oracle/http/GET_admin_settings_preferences_app.json) case `default -> 200`; `spec/requests/settings_spec.rb:70`.

<a id="route-patch-admin-settings-preferences-app"></a>
#### `PATCH /admin/settings/preferences/app`

- `#update_app` (`:33-47`), CSRF. Strong params `user: [track_cash, reveal_hidden_categories, hidden_category_ids: []]`; when `hidden_category_ids` is omitted (empty multi-select) it is forced to `[]`, i.e. **all hidden categories are cleared** (`:108-114`) **[V]** `spec/requests/settings_spec.rb:116`. Category ids are not filtered to the user's own categories by the controller (see U-524).
- Behaviour: saves the flags; if `track_cash` switched from false to true, calls `Cash::Tracking.enable!` (BR-300..399: creates/links a cash wallet and links historical ATM withdrawals). Turning it off does not remove anything **[I]**.
- Success **302** `/admin/settings/preferences/app`, notice "App settings saved." plus, when tracking was just enabled, " Created a <CURRENCY> wallet and linked <n> historical ATM withdrawal(s)." **[V]** [oracle](../oracle/http/PATCH_admin_settings_preferences_app.json) case `default -> 302`; `spec/requests/settings_spec.rb:79,90` (notice contains "PLN" and the count), `:106`. Failure **422** with alert.

<a id="route-get-admin-settings-preferences-llm"></a>
#### `GET /admin/settings/preferences/llm`

- `#llm` (`:49-51`). Loads the user's `LlmSetting` or builds an unsaved one with the first registered provider (`openai`), plus the latest `llm_connection_test` run. Providers (`app/services/llm/providers.rb`): `openai` ("OpenAI", default model `gpt-5-mini`) and `gemini` ("Google Gemini", default `gemini-2.5-flash`, models `gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash`). The API key is never echoed (placeholder only). ADR 0012 (per-user LLM credentials). 200. **[V]** [oracle](../oracle/http/GET_admin_settings_preferences_llm.json) case `default -> 200`; `spec/requests/settings_spec.rb:127`.

<a id="route-patch-admin-settings-preferences-llm"></a>
#### `PATCH /admin/settings/preferences/llm`

- `#update_llm` (`:53-68`), CSRF. Strong params `llm_setting: [provider, api_key, model]` (`:116-118`). A blank `api_key` on an already saved setting means "keep the current key" (`:60`) **[V]** `spec/requests/settings_spec.rb:149`; a non-blank key replaces it **[V]** `:164`; first save creates the setting **[V]** `:136`.
- Validation (LlmSetting): provider present and registered, api_key present, model supported by the provider ("Model is not supported by <provider label>") **[I]** texts.
- Success **302** `/admin/settings/preferences/llm`, notice "LLM settings saved.". Validation failure **422** with alert.
- An unknown provider value (not offered by the form) is not caught: re-rendering the page calls `Llm::Providers.fetch`, which raises `ArgumentError` "Unknown LLM provider: \"martian\"" -> **500** (see U-503, BUG?). **[V]** [oracle](../oracle/http/PATCH_admin_settings_preferences_llm.json) cases `default -> 302`, `invalid_provider -> 500`.

<a id="route-post-admin-settings-preferences-llm-test"></a>
#### `POST /admin/settings/preferences/llm/test`

- `#test_llm` (`:70-83`), CSRF, no parameters. Not configured (no API key) -> **302** `/admin/settings/preferences/llm`, alert "Save a provider and API key first." **[V]** `spec/requests/settings_spec.rb:176`.
- Otherwise `Llm::ConnectionTestRunner` (BR-200..299) creates an `OperationRun` (`kind = "llm_connection_test"`, status `running`), sends a structured-output probe (system prompt asking to echo a timestamp, user prompt `ping sent_at=<ISO8601>`) through the provider client, marks the run succeeded/failed and stores the last test result on the setting. Success -> 302 same page, notice "Connection OK - <provider label> (<effective model>)."; provider error -> 302, alert "Test failed: <error message>". **[V]** [oracle](../oracle/http/POST_admin_settings_preferences_llm_test.json) case `default -> 302` (run 14 failed with a real provider error "OpenAI API error: RubyLLM::UnauthorizedError: Incorrect API key provided ...", `oracle/operation_runs_after_capture.jsonl`); `spec/requests/settings_spec.rb:186,200`. The runner builds the client with `setting.build_client` directly instead of the `Llm::Client.for` seam, so test fakes injected at that seam are bypassed (see U-504).

### A.20 Settings: data exchange (encrypted export/import)

Handler `Admin::Settings::DataExchangeController` (`app/controllers/admin/settings/data_exchange_controller.rb`), routes `config/routes.rb:149-151`.
Exported resources = `DataExchange::Registry.all_keys` = `tpp_credentials`, `bank_connections`, `bank_accounts` of the current user
(`app/services/data_exchange/registry.rb:9-13`). Bundle format, cipher and import semantics are BR-001..199 (`DataExchange::Operations::Export` /
`Import`, `DataExchange::Bundle`).

<a id="route-get-admin-settings-preferences-data-exchange"></a>
#### `GET /admin/settings/preferences/data_exchange`

- `#show` (`:6-11`): per-resource record counts of what would be exported, plus export (passphrase) and import (file, passphrase, strategy) forms. 200. **[V]** [oracle](../oracle/http/GET_admin_settings_preferences_data_exchange.json) case `default -> 200`; `spec/requests/settings_spec.rb:213`; `spec/system/data_exchange_round_trip_spec.rb:22-25`.

<a id="route-post-admin-settings-preferences-data-exchange-export"></a>
#### `POST /admin/settings/preferences/data_exchange/export`

- `#export` (`:13-27`), CSRF. Param `passphrase` (form, string, required non-empty).
- Success: **200** with the encrypted bundle as the body: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="obr-export-<YYYYMMDD>-<HHMMSS>.obrbundle"; filename*=UTF-8''obr-export-<YYYYMMDD>-<HHMMSS>.obrbundle`, timestamp = current **UTC** time (`:53-55`). An `OperationRun` of kind `data_export` records the bundle id, size and counts. **[V]** [oracle](../oracle/http/POST_admin_settings_preferences_data_exchange_export.json) case `default -> 200` (binary 4878 bytes, filename `obr-export-20261021-125214.obrbundle`; run 15 `data_export` succeeded); `spec/requests/settings_spec.rb:222`.
- `Export::Failed` ("passphrase required", "no resources selected") -> **302** `/admin/settings/preferences/data_exchange`, alert "Export failed: <message>". **[V]** case `blank_passphrase -> 302`; `spec/requests/settings_spec.rb:238`.

<a id="route-post-admin-settings-preferences-data-exchange-import"></a>
#### `POST /admin/settings/preferences/data_exchange/import`

- `#import` (`:29-49`), CSRF, `multipart/form-data`. Params: `bundle` (file, required), `passphrase` (string), `strategy` (`skip_existing` (default when blank) \| `overwrite_existing` \| `fail_on_conflict`).
- No file -> **302** `/admin/settings/preferences/data_exchange`, alert "Bundle file is required." **[V]** case `missing_bundle -> 302`; `spec/requests/settings_spec.rb:250`.
- Success -> 302 same page, notice "Import done - <imported> imported, <updated> updated, <skipped> skipped." **[V]** `spec/requests/settings_spec.rb:260`.
- `Import::Failed` -> 302, alert "Import failed: <message>", messages include "passphrase required", "unknown strategy: <s>", "AR encryption keys not configured on this instance - cannot store sensitive fields", "bundle is empty", "bundle exceeds size limit" (> 2 × 10 MiB raw), "bundle malformed: <detail>", "bundle has <n> records (limit 50000)", "bundle references unknown resources: [...]", "<resource>: <error>" (`app/services/data_exchange/operations/import.rb:47-116`). **[V]** case `garbage_bundle -> 302`; `spec/requests/settings_spec.rb:284`; individual texts **[I]**. Ownership of imported rows is always the current user, never taken from the bundle (`import.rb:8-10`). A non-file `bundle` value (plain string field) would raise -> 500 **[I]** (see U-514).

### A.21 Settings: API tokens (personal access tokens for the JSON API and MCP)

Handler `Admin::Settings::ApiTokensController` (`app/controllers/admin/settings/api_tokens_controller.rb`), route `config/routes.rb:153`.
Tokens authenticate the Grape API and MCP endpoints (Part B).

<a id="route-get-admin-settings-preferences-api-tokens"></a>
#### `GET /admin/settings/preferences/api_tokens`

- `#index` (`:6-10`): the user's tokens ordered by `revoked_at DESC, created_at DESC` (PostgreSQL sorts NULLs first on DESC, so active tokens come first, newest first) showing name, last four characters, last use, revoked state. If the previous request just created a token, the raw token is read from the one-hop flash key `new_raw_token` and shown once. 200. **[V]** [oracle](../oracle/http/GET_admin_settings_preferences_api_tokens.json) case `default -> 200`; `spec/requests/settings_spec.rb:299,308`.

<a id="route-post-admin-settings-preferences-api-tokens"></a>
#### `POST /admin/settings/preferences/api_tokens`

- `#create` (`:12-30`), CSRF. Param `personal_access_token[name]` (string, stripped; required, 1..50 characters, unique per user case-insensitively; two users may use the same name **[V]** `spec/requests/settings_spec.rb:363`).
- Behaviour (`Auth::PersonalAccessTokenIssuer`): raw token = `"obrl_"` + URL-safe Base64 (no padding) of 32 random bytes; only its SHA-256 hex digest and its last 4 characters are stored (`app/services/auth/personal_access_token_issuer.rb:87-95`, `app/models/personal_access_token.rb:28-29,52-54`).
- Success **302** `/admin/settings/preferences/api_tokens`, notice `Token "<name>" generated. Copy it now - it won't be shown again.`; the raw token travels to the next GET only inside the encrypted session cookie flash. Failure **422** index page, alert = joined errors (e.g. "Name can't be blank") or "Could not generate the token.". **[V]** [oracle](../oracle/http/POST_admin_settings_preferences_api_tokens.json) cases `default -> 302`, `invalid_blank_name -> 422`; `spec/requests/settings_spec.rb:325,348`; `spec/system/personal_access_token_lifecycle_spec.rb`.

<a id="route-delete-admin-settings-preferences-api-tokens-id"></a>
#### `DELETE /admin/settings/preferences/api_tokens/:id`

- `#destroy` (`:32-44`), CSRF. Lookup `current_user.personal_access_tokens.find(id)` -> 404 for other tenants. Two-step: an active token is **revoked** (`revoked_at = now`, row kept), notice `Token "<name>" revoked.`; an already revoked token is **hard-deleted**, notice `Token "<name>" deleted.`. Both **302** `/admin/settings/preferences/api_tokens`. **[V]** [oracle](../oracle/http/DELETE_admin_settings_preferences_api_tokens__id.json) cases `first_delete_revokes -> 302`, `second_delete_destroys_revoked -> 302`; `spec/requests/settings_spec.rb:384,399`.

### A.22 Turbo Native historical-location routes (framework, turbo-rails 2.0.23)

Drawn automatically by the `turbo-rails` engine for Hotwire Native (iOS/Android) apps; handler `Turbo::Native::NavigationController`
(inherits `ActionController::Base`: no authentication, no first-run redirect, no browser gate). Each answers **200** `text/html; charset=utf-8`
with a fixed body; a native app intercepts these paths to pop / keep / reload its navigation stack. The application never redirects to them
(no `recede_or_redirect_to` / `resume_or_redirect_to` / `refresh_or_redirect_to` calls in `app/`). **The Kotlin service does not need them**
unless a Hotwire Native client is planned (see U-510).

<a id="route-get-recede-historical-location"></a>
#### `GET /recede_historical_location`

- `turbo/native/navigation#recede`, body "Going back…" (with U+2026 ellipsis). **[V]** [oracle](../oracle/http/GET_recede_historical_location.json) case `default -> 200`.

<a id="route-get-resume-historical-location"></a>
#### `GET /resume_historical_location`

- `turbo/native/navigation#resume`, body "Staying put…". **[V]** [oracle](../oracle/http/GET_resume_historical_location.json) case `default -> 200`.

<a id="route-get-refresh-historical-location"></a>
#### `GET /refresh_historical_location`

- `turbo/native/navigation#refresh`, body "Refreshing…". **[V]** [oracle](../oracle/http/GET_refresh_historical_location.json) case `default -> 200`.

### A.23 Framework default routes: ActionMailbox, Rails Conductor, ActiveStorage

`config/application.rb:8,11` loads the `active_storage` and `action_mailbox` engines (plus `action_text`), which draw these routes automatically.
The application does not use any of them: there are no mailboxes (`app/mailboxes` absent), no `has_one_attached` / `has_many_attached` /
`has_rich_text` declarations, and the backing tables `action_mailbox_inbound_emails`, `active_storage_blobs`, `active_storage_attachments`,
`active_storage_variant_records`, `action_text_rich_texts` **do not exist** in the schema (`inventory/models.json`: `table_exists: false`).
All of them inherit `ActionController::Base` (no Devise authentication, no first-run redirect). Observed behaviour below is from the development
capture. **Proposed default for Kotlin: do not implement any of these routes** (they would answer 404 in the new service); see U-509.

ActionMailbox ingresses (inbound e-mail webhooks; each ingress answers `404` unless `config.action_mailbox.ingress` names it, which is not
configured — `ActionMailbox::BaseController#ensure_configured` in the actionmailbox gem):

<a id="route-post-rails-action-mailbox-postmark-inbound-emails"></a>
- `POST /rails/action_mailbox/postmark/inbound_emails` — `action_mailbox/ingresses/postmark/inbound_emails#create`. **[V]** [oracle](../oracle/http/POST_rails_action_mailbox_postmark_inbound_emails.json) case `default -> 404`.

<a id="route-post-rails-action-mailbox-relay-inbound-emails"></a>
- `POST /rails/action_mailbox/relay/inbound_emails` — `action_mailbox/ingresses/relay/inbound_emails#create`. **[V]** [oracle](../oracle/http/POST_rails_action_mailbox_relay_inbound_emails.json) case `default -> 404`.

<a id="route-post-rails-action-mailbox-sendgrid-inbound-emails"></a>
- `POST /rails/action_mailbox/sendgrid/inbound_emails` — `action_mailbox/ingresses/sendgrid/inbound_emails#create`. **[V]** [oracle](../oracle/http/POST_rails_action_mailbox_sendgrid_inbound_emails.json) case `default -> 404`.

<a id="route-get-rails-action-mailbox-mandrill-inbound-emails"></a>
- `GET /rails/action_mailbox/mandrill/inbound_emails` — `action_mailbox/ingresses/mandrill/inbound_emails#health_check`. **[V]** [oracle](../oracle/http/GET_rails_action_mailbox_mandrill_inbound_emails.json) case `default -> 404`.

<a id="route-post-rails-action-mailbox-mandrill-inbound-emails"></a>
- `POST /rails/action_mailbox/mandrill/inbound_emails` — `action_mailbox/ingresses/mandrill/inbound_emails#create`. **[V]** [oracle](../oracle/http/POST_rails_action_mailbox_mandrill_inbound_emails.json) case `default -> 404`.

<a id="route-post-rails-action-mailbox-mailgun-inbound-emails-mime"></a>
- `POST /rails/action_mailbox/mailgun/inbound_emails/mime` — `action_mailbox/ingresses/mailgun/inbound_emails#create`. **[V]** [oracle](../oracle/http/POST_rails_action_mailbox_mailgun_inbound_emails_mime.json) case `default -> 404`.

Rails Conductor (developer UI for delivering test inbound e-mails; `Rails::Conductor::BaseController` answers **403** in every environment other
than development — `before_action :ensure_development_env` in the actionmailbox gem — **[I]** for non-development; in development there is no
authentication at all). In the development capture, pages that query the missing `action_mailbox_inbound_emails` table fail with 500
`ActiveRecord::StatementInvalid`, form pages render 200, and POSTs without CSRF token fail with 422:

<a id="route-get-rails-conductor-action-mailbox-inbound-emails"></a>
- `GET /rails/conductor/action_mailbox/inbound_emails` — `rails/conductor/action_mailbox/inbound_emails#index`. **[V]** [oracle](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails.json) case `default -> 500` (StatementInvalid, missing table).

<a id="route-post-rails-conductor-action-mailbox-inbound-emails"></a>
- `POST /rails/conductor/action_mailbox/inbound_emails` — `#create`. **[V]** [oracle](../oracle/http/POST_rails_conductor_action_mailbox_inbound_emails.json) case `no_csrf -> 422`.

<a id="route-get-rails-conductor-action-mailbox-inbound-emails-new"></a>
- `GET /rails/conductor/action_mailbox/inbound_emails/new` — `#new`, page "Rails Conductor: Deliver new inbound email". **[V]** [oracle](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails_new.json) case `default -> 200`.

<a id="route-get-rails-conductor-action-mailbox-inbound-emails-id"></a>
- `GET /rails/conductor/action_mailbox/inbound_emails/:id` — `#show`. **[V]** [oracle](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails__id.json) case `default -> 500` (missing table).

<a id="route-get-rails-conductor-action-mailbox-inbound-emails-sources-new"></a>
- `GET /rails/conductor/action_mailbox/inbound_emails/sources/new` — `rails/conductor/action_mailbox/inbound_emails/sources#new`, page "Rails Conductor: Deliver new inbound email by source". **[V]** [oracle](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails_sources_new.json) case `default -> 200`.

<a id="route-post-rails-conductor-action-mailbox-inbound-emails-sources"></a>
- `POST /rails/conductor/action_mailbox/inbound_emails/sources` — `.../inbound_emails/sources#create`. **[V]** [oracle](../oracle/http/POST_rails_conductor_action_mailbox_inbound_emails_sources.json) case `no_csrf -> 422`.

<a id="route-post-rails-conductor-action-mailbox-inbound-email-id-reroute"></a>
- `POST /rails/conductor/action_mailbox/:inbound_email_id/reroute` — `rails/conductor/action_mailbox/reroutes#create`. **[V]** [oracle](../oracle/http/POST_rails_conductor_action_mailbox__inbound_email_id_reroute.json) case `no_csrf -> 422`.

<a id="route-post-rails-conductor-action-mailbox-inbound-email-id-incinerate"></a>
- `POST /rails/conductor/action_mailbox/:inbound_email_id/incinerate` — `rails/conductor/action_mailbox/incinerates#create`. **[V]** [oracle](../oracle/http/POST_rails_conductor_action_mailbox__inbound_email_id_incinerate.json) case `no_csrf -> 422`.

ActiveStorage (file serving / direct upload; storage service `:local` disk `storage/` in development and production, `config/storage.yml`,
`config/environments/production.rb:25`). With signed ids/keys that do not verify, the controllers answer **404** without touching the database;
any valid use would fail because the tables are missing **[I]**:

<a id="route-get-rails-active-storage-blobs-redirect-signed-id-filename"></a>
- `GET /rails/active_storage/blobs/redirect/:signed_id/*filename` — `active_storage/blobs/redirect#show`. **[V]** [oracle](../oracle/http/GET_rails_active_storage_blobs_redirect__signed_id__filename.json) case `bogus_signed_id -> 404`.

<a id="route-get-rails-active-storage-blobs-proxy-signed-id-filename"></a>
- `GET /rails/active_storage/blobs/proxy/:signed_id/*filename` — `active_storage/blobs/proxy#show`. **[V]** [oracle](../oracle/http/GET_rails_active_storage_blobs_proxy__signed_id__filename.json) case `bogus_signed_id -> 404`.

<a id="route-get-rails-active-storage-blobs-signed-id-filename"></a>
- `GET /rails/active_storage/blobs/:signed_id/*filename` — `active_storage/blobs/redirect#show` (legacy alias). **[V]** [oracle](../oracle/http/GET_rails_active_storage_blobs__signed_id__filename.json) case `bogus_signed_id -> 404`.

<a id="route-get-rails-active-storage-representations-redirect-signed-blob-id-variation-key-filename"></a>
- `GET /rails/active_storage/representations/redirect/:signed_blob_id/:variation_key/*filename` — `active_storage/representations/redirect#show`. **[V]** [oracle](../oracle/http/GET_rails_active_storage_representations_redirect__signed_blob_id__variation_key__filename.json) case `bogus_signed_id -> 404`.

<a id="route-get-rails-active-storage-representations-proxy-signed-blob-id-variation-key-filename"></a>
- `GET /rails/active_storage/representations/proxy/:signed_blob_id/:variation_key/*filename` — `active_storage/representations/proxy#show`. **[V]** [oracle](../oracle/http/GET_rails_active_storage_representations_proxy__signed_blob_id__variation_key__filename.json) case `bogus_signed_id -> 404`.

<a id="route-get-rails-active-storage-representations-signed-blob-id-variation-key-filename"></a>
- `GET /rails/active_storage/representations/:signed_blob_id/:variation_key/*filename` — `active_storage/representations/redirect#show` (legacy alias). **[V]** [oracle](../oracle/http/GET_rails_active_storage_representations__signed_blob_id__variation_key__filename.json) case `bogus_signed_id -> 404`.

<a id="route-get-rails-active-storage-disk-encoded-key-filename"></a>
- `GET /rails/active_storage/disk/:encoded_key/*filename` — `active_storage/disk#show` (content-type of the 404 is derived from the filename extension, e.g. `image/png`). **[V]** [oracle](../oracle/http/GET_rails_active_storage_disk__encoded_key__filename.json) case `bogus_signed_id -> 404`.

<a id="route-put-rails-active-storage-disk-encoded-token"></a>
- `PUT /rails/active_storage/disk/:encoded_token` — `active_storage/disk#update` (direct-upload target; token-authenticated, no CSRF). **[V]** [oracle](../oracle/http/PUT_rails_active_storage_disk__encoded_token.json) case `bogus_token -> 404`.

<a id="route-post-rails-active-storage-direct-uploads"></a>
- `POST /rails/active_storage/direct_uploads` — `active_storage/direct_uploads#create` (CSRF-protected JSON endpoint creating a blob record). **[V]** [oracle](../oracle/http/POST_rails_active_storage_direct_uploads.json) case `no_csrf -> 422`.


## Part B — REST API v1 (Grape), OpenAPI docs and MCP server

This part specifies the machine-facing surface: the JSON REST API mounted under `/api/v1` (Grape), the
OpenAPI/Swagger documentation endpoints, and the Model Context Protocol (MCP) server at `/mcp`. Both the API and
MCP authenticate with the same Personal Access Token (PAT) and expose the same per-user (tenant) data, but they
differ in error envelopes, pagination and output shapes. These differences are part of the contract and are
listed explicitly below.

Certainty markers: **[V]** = observed in the oracle run (`oracle/http/*.json`) or asserted by a passing spec
(`spec/requests/api/**`, `spec/requests/mcp/**`; all 825 examples passed per `inventory/specs_run.json`);
**[I]** = inferred from reading code only.

Business rules: services are named here. Exact BR ids are cross-linked later. Ranges: BR-001..199 identity/banking/sync,
BR-200..299 classification/LLM, BR-300..399 cash/analytics.

---

### B.1 Common conventions (REST API)

<a id="route-mount-"></a>
#### B.1.1 Mounting, base path, format, versioning (`MOUNT /` (Grape Api))

- The Grape application `Api` is mounted at the application root: route key `MOUNT /` (Grape `Api`), `config/routes.rb:31`. [I]
- Grape is configured with `prefix :api`, `format :json`, `version "v1", using: :path`, so every endpoint lives under
  **`/api/v1/...`** (`lib/api/api.rb:4-6`). [V] (every oracle API case uses `/api/v1/…`)
- Each route also accepts an optional `.json` suffix, e.g. `/api/:version/merchants(.json)` (`inventory/api_routes.json`,
  oracle `route` fields). [I] (suffix form was not exercised)
- Only version `v1` exists. Requests to `/api/v2/...` do not match any Grape route and fall through to Rails, which
  returns a routing 404 that is **not** the JSON envelope (`spec/requests/api/v1/cross_cutting_spec.rb:77-84`). [V]
- Unmatched paths under `/api/v1` (e.g. `GET /api/v1/nope`) and path parameters that fail the route's Integer
  requirement (e.g. `GET /api/v1/categories/abc`) also fall through to Rails and return **404 with an HTML body**
  (in development the "Routing Error" exception page, `content-type: text/html`).
  [V] [oracle](../oracle/http/GET_api__version_merchants.json) case `unknown_api_path_404` → 404;
  [oracle](../oracle/http/GET_api__version_categories__id.json) case `non_integer_id` → 404 (HTML). (see U-609)
- Responses are JSON (`content-type: application/json`) except 204 responses (empty body) and the Rails 404 above. [V]
- Request bodies: the oracle and specs send JSON bodies with `Content-Type: application/json`
  (`spec/support/auth_helpers.rb:16-38`). Grape also accepts query-string / form parameters for the same declared
  params. [I]
- Parameter coercion is done by Grape: `Integer`, `Date` (ISO `YYYY-MM-DD`), `DateTime`, `Boolean`
  (`true`/`false`), `Array[Integer]`. A value that cannot be coerced, a missing `requires` param, or a value outside
  `values:` produces **400** (see B.1.5). [V] (oracle cases `invalid_params`, `invalid_enum`, `missing_*`)
- Only declared params are passed to services (`declared(params, include_missing: false)`); undeclared params are
  silently ignored. [I] (`lib/api/resources/*.rb`, e.g. `merchants.rb:45`)

#### B.1.2 Authentication

- Every Grape resource runs `before { authenticate! }` (e.g. `lib/api/resources/transactions.rb:5`) except the
  Swagger document endpoints (B.3). [V] (`GET /api/v1/swagger_doc` succeeds anonymously, oracle actor `anon`)
- Header: `Authorization: Bearer <token>`. The `Bearer` keyword is matched case-insensitively and followed by one or
  more whitespace characters; the rest is the raw token (`lib/api/helpers/auth_helper.rb:17-21`). [I]
- Token format: `obrl_` prefix followed by `urlsafe_base64(32 random bytes)` (`app/models/personal_access_token.rb:28-29`,
  `app/services/auth/personal_access_token_issuer.rb:25`). [I]
- Validation (`app/services/auth/personal_access_token_authenticator.rb:15-24`): the raw token must be a String starting
  with `obrl_`; its SHA-256 hex digest is looked up among **non-revoked** tokens (`revoked_at IS NULL`). On success
  `last_used_at` and `updated_at` are set to now via a direct column update (no callbacks / no audit version)
  (`app/models/personal_access_token.rb:47-50`). [V] (`spec/requests/api/v1/cross_cutting_spec.rb:100-108`; server log shows the UPDATE on every call)
- Every failure reason (no header, non-Bearer scheme, missing prefix, unknown digest, revoked) yields the same
  response — **401** with body exactly:
  ```json
  {"message": "Invalid or missing access token."}
  ```
  [V] [oracle](../oracle/http/GET_api__version_merchants.json) cases `no_token`, `invalid_token`, `revoked_token` → 401;
  `spec/support/auth_helpers.rb:57-81` (shared example used by `spec/requests/api/v1/cross_cutting_spec.rb:6`).
- The authenticated principal is the token's user. The token carries no scopes: any valid PAT has full read/write
  access to that user's data through the API and MCP. [I]
- Tokens are issued/revoked in the admin UI (Settings → API Tokens; documented elsewhere). README: "Get a token from
  **Settings → API Tokens** and point your client at `/api/v1/...` or `/mcp`" (`README.md:205-210`).

#### B.1.3 Tenant scoping and foreign ids

- All lookups are scoped to the current user (tenant). Ownership rules per resource [I unless noted]:

  | Resource | Ownership scope (source) |
  |---|---|
  | Ledger entries (`/transactions`) | `bank_account_id IN user.all_bank_account_ids` (`app/models/ledger_entry.rb:80`) |
  | Bank transactions | bank account → TPP credential → `user_id` (`app/models/bank_transaction.rb:82`) |
  | Manual (cash) transactions | bank account `manual = true AND manual_owner_id = user` (`app/models/manual_transaction.rb:86-88`) |
  | Bank accounts | synced accounts of the user's TPP credentials + the user's manual wallets (`app/models/user.rb:74-78`) |
  | Bank connections | TPP credential `user_id` (`app/models/bank_connection.rb:77`) |
  | Categories, merchants, TPP credentials | `user_id` association (`current_user.categories` etc.) |
  | Merchant rules | via the merchant (`current_user.merchants.find(merchant_id).merchant_rules`) |
  | Operation runs (syncs, LLM runs) | `kind = …` AND `triggered_by_user_id = user` |

- An id belonging to another tenant behaves exactly like a non-existent id: **404** with the RecordNotFound message
  (B.1.5). [V] oracle cases `other_tenant_id` on bank_connections, bank_transactions, cash_transactions, categories,
  merchants, tpp_credentials, transactions → 404; specs e.g. `spec/requests/api/v1/banking_spec.rb:48-57`,
  `spec/requests/api/v1/categorization_spec.rb:57-66`.
- Exceptions where a foreign id in a **body/query parameter** is not rejected (see the endpoint sections):
  `default_category_id` on merchant create/update is accepted unscoped (see U-604); `bank_connection_id` on
  `POST /api/v1/transaction_syncs` silently widens to "all connections" (see U-605); `merchant_id`/`category_id` on
  cash transactions and classification are looked up scoped and silently become "none" when foreign. [V]/[I] as noted.

#### B.1.4 Pagination

- Paginated list endpoints return:
  ```json
  {"data": [ ...entities... ], "pagination": {"page": 1, "limit": 10, "count": 66, "pages": 7}}
  ```
  (`lib/api/helpers/pagy_helper.rb:8-21`). `count` = total rows across all pages, `pages` = total pages. [V]
  [oracle](../oracle/http/GET_api__version_transactions.json) case `default` → 200; `spec/requests/api/v1/cross_cutting_spec.rb:86-98`.
- Query params `page` (default 1) and `limit` (default **10**, maximum **100**) (`config/initializers/pagy.rb:5-6`).
  Pagy reads them from the raw query/body (not from Grape's coerced params). [I]
  - `limit` above 100 is clamped to 100 (no error). [V] [oracle](../oracle/http/GET_api__version_transactions.json) case
    `limit_above_max` (`limit=1000`) → 200; the server log shows the query executed with `LIMIT 100 OFFSET 0`
    (`oracle/server.log.txt:2171`) and all 66 rows were returned (content-length 31555). The echoed `pagination.limit`
    in that response was truncated in the capture; by code it is 100. [I]
  - `limit=0` or a non-numeric value in Pagy's view falls back to the default 10; `page` below 1 becomes 1. [I] (pagy `Request#resolve_limit/resolve_page`)
  - `page` beyond the last page returns an empty `data` array (no error). [I]
  - Negative `limit` is not guarded (see U-610).
  - Explicit `page=2&limit=2` example: `{"page":2,"limit":2,"count":57,"pages":29}`. [V] case `filtered_paged`.
  - For an empty result: `{"page":1,"limit":10,"count":0,"pages":1}` (pages is 1, not 0). [V]
    [oracle](../oracle/http/GET_api__version_merchants.json) case `filtered`.
- Response headers added by Pagy: `link` (RFC 8288, absolute URLs with rel first/prev/next/last), `current-page`,
  `page-limit`, `total-count`, `total-pages` (`lib/api/helpers/pagy_helper.rb:10`). [I] (the oracle captured only selected headers)
- Paginated endpoints: `GET /transactions`, `/cash_transactions`, `/bank_transactions`, `/merchants`, `/bank_accounts`,
  `/bank_connections`, `/tpp_credentials`, `/transaction_syncs`, `/llm_enrichments`, and the `transactions` array
  inside `GET /analytics/merchants/:slug` (there with `pagination` next to it). [V]
- **Not paginated** (bare JSON arrays, all rows): `GET /api/v1/categories` and `GET /api/v1/merchants/:merchant_id/rules`. [V]
  [oracle](../oracle/http/GET_api__version_categories.json) case `default` (body starts with `[`);
  [oracle](../oracle/http/GET_api__version_merchants__merchant_id_rules.json).
- The other analytics endpoints return unpaginated objects. [V]

#### B.1.5 Error format per status

Global `rescue_from` mapping (`lib/api/api.rb:12-40`):

| Status | Trigger | Body | Evidence |
|---|---|---|---|
| 400 | Grape parameter validation/coercion (`Grape::Exceptions::ValidationErrors`) | `{"message":"Invalid parameters.","details":[<one string per problem>]}`; detail strings are Grape's English messages, e.g. `"from is invalid"`, `"direction does not have a valid value"`, `"amount is missing"`, `"field is missing"` | [V] [oracle](../oracle/http/GET_api__version_transactions.json) `invalid_params` → 400 with `["from is invalid","direction does not have a valid value"]`; `spec/requests/api/v1/cross_cutting_spec.rb:44-54` |
| 401 | Missing/invalid token | `{"message":"Invalid or missing access token."}` | [V] B.1.2 |
| 404 | `ActiveRecord::RecordNotFound` (unknown or foreign id/slug) | `{"message":"<ActiveRecord message>"}`, e.g. `"Couldn't find Category with 'id'=119 [WHERE \"categories\".\"user_id\" = $1]"` — the message includes model name, id and an SQL WHERE fragment (see U-606) | [V] oracle `other_tenant_id` cases; `spec/requests/api/v1/cross_cutting_spec.rb:22-31` |
| 404 (HTML) | No route matched (unknown path, non-integer id, other version) | Rails routing error page (HTML) | [V] B.1.1 |
| 405 | `Grape::Exceptions::MethodNotAllowed` (known path, unsupported verb) | Grape error with the exception message (string body wrapped by Grape's JSON formatter, expected `{"error":"405 Not Allowed"}`) plus an `Allow` header | [I] `lib/api/api.rb:28-30` (not exercised) |
| 409 | `ActiveRecord::StaleObjectError` | `{"message":"Resource was modified by another request, try again."}` | [I] `lib/api/api.rb:20-22`; no table has `lock_version`, so unreachable in practice (see U-615) |
| 422 | `ActiveRecord::RecordInvalid` raised by `save!`/`update!` | `{"message":"<full messages joined by \", \">","details":[<full messages>]}` | [V] [oracle](../oracle/http/PATCH_api__version_bank_connections__id.json) `invalid_status` → 422 `{"message":"Status is not included in the list","details":["Status is not included in the list"]}` |
| 422 | Service result failure (endpoint-local `error!`) | `{"message":"<result.error>","details":[...]}` or, for some endpoints, only `{"message":"..."}` (see each endpoint) | [V] per endpoint |
| 500 | Any other exception (`rescue_from :all`) | development/test: `{"message":"<ExceptionClass>: <message>"}`; production: `{"message":"Internal server error."}`. The exception is recorded on the current OpenTelemetry span and logged as `[API] <Class>: <message>` with 10 backtrace lines | [V] dev: [oracle](../oracle/http/GET_api__version_analytics_cash_flow.json) `from_after_to` → 500 `{"message":"ArgumentError: from must be <= to"}`; `spec/requests/api/v1/cross_cutting_spec.rb:56-66`; production text [I] `lib/api/api.rb:38` |

Grape default success statuses: `GET`/`PATCH`/`DELETE` → 200, **`POST` → 201** (including action endpoints such as
`/archive`, `/refresh`, `/make_primary`, `/test_connection`, `/classification` that create nothing); endpoints that
`status 204` return an empty body. [V] (oracle `default` cases of all POST action endpoints → 201) (see U-613)

#### B.1.6 Money, dates, times

- **Money in entities** is an object `{"cents": <integer minor units>, "currency": "<ISO-4217>"}`
  (`lib/api/entities/money.rb`). `amount` is always non-negative; `signed_amount` is negative for `direction = "debit"`
  and positive for `"credit"` (`lib/api/entities/bank_transaction.rb:11-13`, `manual_transaction.rb:10-12`,
  `ledger_entry.rb:11-13`). [V] e.g. bank transaction 1: `"amount":{"cents":1999,"currency":"PLN"},"signed_amount":{"cents":-1999,"currency":"PLN"}`.
- **Bank account balances** expose `amount_cents` (integer) + `currency` per balance, converted from the provider's
  decimal string with `Money.from_amount` (`lib/api/entities/bank_account.rb:20-33`). [V] `"amount_cents":1234567`.
- **Analytics** responses use bare integer fields with `_cents` suffix plus one top-level `currency`. [V]
- **Money input** (cash transactions): decimal string (`"25.50"`), comma accepted as decimal separator, converted to
  minor units of the target currency; half-way values round up (`"1.005"` EUR → 101 cents). [V]
  [oracle](../oracle/http/POST_api__version_cash_transactions.json) case `currency_eur_lowercase` → 201 `"cents":101`.
- **Dates** (`booking_date`, `value_date`, `transaction_date`, analytics `period.from/to`, series `date`): `"YYYY-MM-DD"`. [V]
- **Timestamps** (`*_at`, `valid_until`, `created_at`): ISO-8601 in UTC with milliseconds and `Z`, e.g.
  `"2026-10-21T12:49:32.000Z"`. [V] The application does not set `config.time_zone` (no occurrence in `config/`), so
  `Time.current`/`Date.current` are UTC; "today" and month-to-date defaults are UTC dates. [I]
- Free-form JSON (`OperationRun.params` / `summary`) is passed through as stored and may contain offset timestamps
  such as `"2026-10-21T14:49:35.987+02:00"`. [V] [oracle](../oracle/http/GET_api__version_transaction_syncs__id.json).
- `null` is emitted for absent values (fields are never omitted). [V]

#### B.1.7 CORS

- `rack-cors` is inserted first in the middleware stack and allows **any origin** (`*`) for **every path** with any
  request headers and methods GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD; credentials are not allowed
  (`config/initializers/cors.rb:1-6`). [V]
- Preflight: `OPTIONS /api/v1/merchants` with `Origin: https://evil.example`, `Access-Control-Request-Method: GET`,
  `Access-Control-Request-Headers: authorization` → **200**, empty body, headers
  `access-control-allow-origin: *`, `access-control-allow-methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD`.
  [V] [oracle](../oracle/http/OPTIONS_api__version_merchants.json) case `cors_preflight` → 200.
- Actual request with an `Origin` header gets the same two headers; `vary: Origin` is present on responses. [V]
  [oracle](../oracle/http/GET_api__version_merchants.json) case `cors_preflight_like_origin` → 200.
- Because the policy applies to all paths, `/mcp` and the HTML admin are also CORS-open; protection relies on the
  Bearer token (API/MCP) and on cookies not being shared cross-origin (no `allow-credentials`). [I]

#### B.1.8 Response entities (shared)

All fields are always present (null when empty). Types per `documentation:` in `lib/api/entities/*.rb`. [V] shapes observed in oracle samples.

**Category** (`lib/api/entities/category.rb`): `id` int, `name`, `slug`, `path` (ltree path as string, e.g.
`"food.cooking.supermarket"`), `kind` (`expense|income|transfer|savings|ignored`), `color`, `icon`, `essential` bool,
`position` int, `archived_at` (timestamp or null), `parent_path` (path without last segment; null for top level).

**Merchant** (`merchant.rb`): `id`, `name`, `slug`, `kind` (`company|person|unknown`), `source` (observed values
`system`, `user`; code comment says `user / llm / seed`, see U-607), `logo_url`, `notes`, `default_category_id`,
`confidence` (float), `model`, `approved_at`, `archived_at`, `default_category` (nested Category or null).

**MerchantRule** (`merchant_rule.rb`): `id`, `merchant_id`, `field` (`title|counterparty_name|counterparty_iban`),
`kind` (`contains|equals|regex|starts_with|ends_with`), `pattern`, `case_sensitive`, `priority` int, `enabled`,
`source`, `confidence`, `model`, `approved_at`.

**TransactionEnrichment** (`transaction_enrichment.rb`): `id`, `merchant_id`, `category_id`, `merchant_rule_id`,
`source` (observed `manual`, `system_rule`, `system_fallback`, `user_rule`), `category_overridden`, `confidence`,
`model`, `enriched_at`, `merchant` (Merchant|null), `category` (Category|null), `effective_category`
(= `category`, else the merchant's `default_category`, else null).

**BankTransaction** (`bank_transaction.rb`): `id`, `external_id`, `bank_account_id`, `amount` Money, `signed_amount` Money,
`direction` (`credit|debit`), `status`, `booking_date`, `value_date`, `transaction_date`, `title`, `counterparty_name`,
`counterparty_iban`, `counterparty_kind`, `payment_method`, `type_hint`, `bank_transaction_code`, `fetched_at`,
`enrichment` (TransactionEnrichment|null).

**ManualTransaction** (`manual_transaction.rb`): `id`, `bank_account_id` (the cash wallet), `amount`, `signed_amount`,
`direction`, `status`, `booking_date`, `transaction_date`, `title`, `note`, `counterparty_name`, `counterparty_kind`,
`payment_method`, `source` (`manual|atm_link`), `linked_bank_transaction_id`, `enrichment`, `created_at`, `updated_at`.

**LedgerEntry** (`ledger_entry.rb`; a row of the `ledger_entries` view combining bank + manual transactions):
`source_type` (`BankTransaction|ManualTransaction`), `source_id`, `bank_account_id`, `amount`, `signed_amount`,
`direction`, `status` (`booked|pending`), `payment_method`, `booking_date`, `transaction_date`, `title`,
`counterparty_name`, `counterparty_kind` (`self|external|unknown`), `essential`, `enrichment_source`, `merchant_id`,
`effective_category_id`, `category_path` (string; `""` when uncategorised).

**BankAccount** (`bank_account.rb`): `id`, `uid` (provider account id; cash wallets `cash_<userId>_<ccy>`), `name`,
`iban`, `bban`, `currency`, `status`, `manual` (true for cash wallets), `product`, `cash_account_type`, `details`,
`details_fetched_at`, `balances_synced_at`, `transactions_synced_at`, `balances[]` of
`{name, type (ITAV/ITBD/CLBD/OPBD…), amount_cents, currency, reference_date, last_change_at}`.

**BankConnection** (`bank_connection.rb`): `id`, `bank_name`, `bank_slug`, `bank_country`, `psu_type`
(`personal|business`), `status` (`pending|authorized|expired|revoked|replaced|error|closed`,
`app/models/bank_connection.rb:43`), `authorized_at`, `valid_until`, `last_refreshed_at`, `last_synced_at`,
`access_balances`, `access_transactions`, `replaces_id`, `tpp_credential_id`, `last_error`.

**TppCredential** (`tpp_credential.rb`): `id`, `name`, `provider` (`enable_banking`), `environment`
(`PRODUCTION|SANDBOX`), `status` (`pending|active|error`), `primary`, `redirect_url`, `cert_expires_at`,
`last_verified_at`, `last_verification_error`. Secrets (`application_id`, `private_key_pem`, `public_cert_pem`) are
write-only and never returned. [V]

**OperationRun** (`operation_run.rb`): `id`, `kind` (`transaction_sync|llm_enrichment`), `status`
(`queued|running|succeeded|partial|failed`), `trigger` (`manual|scheduled`), `params` (object), `summary` (object),
`error`, `scheduled_for`, `started_at`, `finished_at`, `subject_type`, `subject_id`, `created_at`.

#### B.1.9 Specs and coverage

Request specs: `spec/requests/api/v1/transactions_spec.rb`, `categorization_spec.rb`, `banking_spec.rb`,
`analytics_spec.rb`, `cross_cutting_spec.rb`; MCP: `spec/requests/mcp/protocol_spec.rb`, `tools_spec.rb`. All passed
(`inventory/specs_run.json`). Oracle index of route → case → status: `oracle/index.json`.

---

### B.2 Endpoints

Template per endpoint: source (Grape resource `file:line`), params, behaviour, success response, errors, oracle,
specs. "Paginated" means B.1.4 applies and the params `page`, `limit` (Integer, optional) are accepted.

#### B.2.1 Ledger (transactions)

<a id="route-get-api-v1-transactions"></a>
##### GET /api/v1/transactions

- **Source:** `lib/api/resources/transactions.rb:8-43` (params :11-25, handler :26-43). Paginated.
- **Params** [V for coercion/enum behaviour, I otherwise]:

  | Name | Type | Req | Allowed / default | Notes |
  |---|---|---|---|---|
  | `from` | Date | no | | `booking_date >= from` (inclusive) |
  | `to` | Date | no | | `booking_date <= to` (inclusive) |
  | `direction` | String | no | `credit`, `debit` | |
  | `status` | String | no | `booked`, `pending` | |
  | `account_id` | Integer | no | | exact `bank_account_id` |
  | `merchant_id` | Integer | no | | exact `merchant_id` |
  | `category_id` | Integer | no | | exact `effective_category_id` (no descendants) |
  | `category_path` | String | no | | ltree prefix; matches the path and all descendants (`LedgerEntry.under_path`) |
  | `payment_method` | String | no | | exact |
  | `currency` | String | no | | upper-cased before comparison |
  | `source_type` | String | no | `BankTransaction`, `ManualTransaction` | |
  | `page`, `limit` | Integer | no | 1 / 10 (max 100) | B.1.4 |

- **Behaviour:** reads the user's ledger entries (B.1.3), applies all given filters (AND), orders by
  `booking_date DESC, source_id DESC`. [I] Read-only; ledger semantics are in the analytics/ledger part (BR-300..399, `LedgerEntry`).
- **Success:** 200 `{data: LedgerEntry[], pagination}`. Example (oracle `default`, first row):
  ```json
  {"data":[{"source_type":"BankTransaction","source_id":54,"bank_account_id":3,"amount":{"cents":500,"currency":"EUR"},"signed_amount":{"cents":-500,"currency":"EUR"},"direction":"debit","status":"booked","payment_method":"card","booking_date":"2026-10-11","transaction_date":"2026-10-11","title":"OpenAI","counterparty_name":"Openai LLC","counterparty_kind":"external","essential":false,"enrichment_source":null,"merchant_id":null,"effective_category_id":null,"category_path":""}],
   "pagination":{"page":1,"limit":10,"count":66,"pages":7}}
  ```
- **Errors:** 400 for bad date/enum (`{"message":"Invalid parameters.","details":["from is invalid","direction does not have a valid value"]}`); 401.
- **Oracle:** [GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json): `default` → 200,
  `filtered_paged` → 200, `invalid_params` → 400, `limit_above_max` → 200. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:6-26` (tenant isolation, entity shape), `:28-41` (from/to). [V]

<a id="route-get-api-v1-transactions-source-type-source-id"></a>
##### GET /api/v1/transactions/:source_type/:source_id

- **Source:** `lib/api/resources/transactions.rb:45-60`.
- **Params:** `source_type` (path, String, required, `BankTransaction|ManualTransaction`), `source_id` (path, Integer, required).
- **Behaviour:** finds the user's ledger entry with that `(source_type, source_id)`. [I]
- **Success:** 200 LedgerEntry. Example (`manual`): `{"source_type":"ManualTransaction","source_id":1,"bank_account_id":5,"amount":{"cents":20000,"currency":"PLN"},"signed_amount":{"cents":20000,"currency":"PLN"},"direction":"credit","status":"booked","payment_method":"cash_atm_topup","booking_date":"2026-08-02","transaction_date":"2026-08-02","title":"ATM withdrawal (PKO BP)","counterparty_name":null,"counterparty_kind":"unknown","essential":false,"enrichment_source":"system_fallback","merchant_id":null,"effective_category_id":101,"category_path":"money.transfers.atm"}`. [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["source_type does not have a valid value"]}` for an unknown type; 404 for unknown/foreign (`"Couldn't find LedgerEntry with [WHERE \"ledger_entries\".\"bank_account_id\" IN ($1, …) AND …]"`). [V]
- **Oracle:** [GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json):
  `default` → 200, `manual` → 200, `other_tenant_id` → 404, `invalid_source_type` → 400. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:43-66`. [V]

#### B.2.2 Cash (manual) transactions

<a id="route-get-api-v1-cash-transactions"></a>
##### GET /api/v1/cash_transactions

- **Source:** `lib/api/resources/cash_transactions.rb:8-29`. Paginated.
- **Params:** `wallet_id` Integer (exact `bank_account_id`), `direction` String (`credit|debit`), `from` Date
  (`booking_date >=`), `to` Date (`booking_date <=`), `page`, `limit`.
- **Behaviour:** the user's manual transactions (including `source = "atm_link"` rows), ordered `booking_date DESC, id DESC`. [I]
- **Success:** 200 `{data: ManualTransaction[], pagination}`; example row: `{"id":6,"bank_account_id":5,"amount":{"cents":20000,"currency":"PLN"},"signed_amount":{"cents":20000,"currency":"PLN"},"direction":"credit","status":"booked","booking_date":"2026-10-01",…,"payment_method":"cash_atm_topup","source":"atm_link","linked_bank_transaction_id":36,"enrichment":{…},"created_at":"2026-10-21T12:49:37.517Z","updated_at":"2026-10-21T12:49:37.517Z"}`, `pagination {"page":1,"limit":10,"count":12,"pages":2}`. [V]
- **Errors:** 400 (enum/date), 401.
- **Oracle:** [GET_api__version_cash_transactions.json](../oracle/http/GET_api__version_cash_transactions.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:68-82`; `cross_cutting_spec.rb:6-20,86-98`. [V]

<a id="route-post-api-v1-cash-transactions"></a>
##### POST /api/v1/cash_transactions

- **Source:** `lib/api/resources/cash_transactions.rb:31-59`. Service: `Cash::TransactionCreator`
  (`app/services/cash/transaction_creator.rb`) (BR-300..399, cash), wallet via `Cash::WalletResolver`.
- **Params:**

  | Name | Type | Req | Allowed / default | Notes |
  |---|---|---|---|---|
  | `amount` | String | **yes** | | decimal string, e.g. `"12.50"`; comma accepted |
  | `currency` | String | no | default `PLN` | stripped + upper-cased |
  | `direction` | String | no | `credit|debit`, default `debit` | |
  | `booking_date` | Date | no | default today (UTC) | |
  | `transaction_date` | Date | no | null | |
  | `title`, `note`, `counterparty_name` | String | no | | blank → null |
  | `merchant_id`, `category_id` | Integer | no | | must be the user's **active** merchant/category, otherwise silently ignored [I] |
  | `payment_method` | String | no | default `cash` | |

- **Behaviour** [I unless noted]: resolves (find-or-create) the user's cash wallet for the currency
  (uid `cash_<userId>_<ccy lower>`, name `Cash wallet (<CCY>)`) — a new EUR wallet was created by the oracle call
  (`bank_account_id` 11) [V]; creates a `ManualTransaction` with `status "booked"`, `source "manual"`, computed
  `counterparty_kind`; creates its enrichment with `source "manual"` and `category_overridden = category given`.
  All in one DB transaction.
- **Success:** **201** ManualTransaction. Example (`default`, request `{"amount":"25.50","currency":"PLN","direction":"debit","title":"Oracle API cash","booking_date":"2026-01-10"}`):
  `{"id":26,"bank_account_id":5,"amount":{"cents":2550,"currency":"PLN"},"signed_amount":{"cents":-2550,"currency":"PLN"},"direction":"debit","status":"booked","booking_date":"2026-01-10","transaction_date":null,"title":"Oracle API cash","note":null,"counterparty_name":null,"counterparty_kind":"unknown","payment_method":"cash","source":"manual","linked_bank_transaction_id":null,"enrichment":{"id":65,"merchant_id":null,"category_id":null,"merchant_rule_id":null,"source":"manual","category_overridden":false,"confidence":null,"model":null,"enriched_at":"2026-10-21T12:50:49.895Z","merchant":null,"category":null,"effective_category":null},"created_at":"2026-10-21T12:50:49.867Z","updated_at":"2026-10-21T12:50:49.867Z"}`. [V]
- **Errors:**
  - 400 `{"message":"Invalid parameters.","details":["amount is missing"]}`. [V] case `missing_amount`.
  - 422 from the service: `{"message":"Amount cents is not a number, Amount is not a number, Amount cents can't be blank","details":["Amount cents is not a number","Amount is not a number","Amount cents can't be blank"]}` for `amount "12,3x"`. [V] case `invalid_amount`. Blank amount also → 422 with details (`spec/requests/api/v1/cross_cutting_spec.rb:33-42`). [V]
  - 500 if the service raises unexpectedly (`cross_cutting_spec.rb:56-66`). [V]
- **Oracle:** [POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json):
  `default` → 201, `invalid_amount` → 422, `missing_amount` → 400, `currency_eur_lowercase` → 201. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:84-112`. [V]

<a id="route-get-api-v1-cash-transactions-id"></a>
##### GET /api/v1/cash_transactions/:id

- **Source:** `lib/api/resources/cash_transactions.rb:70-75`. `id` Integer (path).
- **Behaviour:** returns any of the user's manual transactions, including auto-generated `atm_link` rows (no editability check on read). [V] (oracle id 1 is `atm_link`)
- **Success:** 200 ManualTransaction (example: oracle `default`, `"source":"atm_link","linked_bank_transaction_id":31`). [V]
- **Errors:** 404 unknown/foreign (`"Couldn't find ManualTransaction with 'id'=13 [WHERE \"bank_accounts\".\"manual_owner_id\" = $1 AND \"bank_accounts\".\"manual\" = $2]"`). [V]
- **Oracle:** [GET_api__version_cash_transactions__id.json](../oracle/http/GET_api__version_cash_transactions__id.json): `default` → 200, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:114-132`. [V]

<a id="route-patch-api-v1-cash-transactions-id"></a>
##### PATCH /api/v1/cash_transactions/:id

- **Source:** `lib/api/resources/cash_transactions.rb:77-103`; guard `load_manual!` :63-66. Service:
  `Cash::TransactionUpdater` (`app/services/cash/transaction_updater.rb`) (BR-300..399).
- **Params (all optional):** `amount` String, `direction` (`credit|debit`), `booking_date` Date, `transaction_date` Date,
  `title`, `note`, `counterparty_name`, `merchant_id` Integer, `category_id` Integer, `payment_method`. No `currency`
  (currency is fixed after creation). Only supplied keys are passed to the updater. [I]
- **Behaviour:** loads the user's manual transaction; if `source != "manual"` (e.g. ATM-linked) → 422
  `{"message":"This transaction was auto-generated and isn't editable here."}` [V] (`spec/requests/api/v1/transactions_spec.rb:147-159`);
  otherwise applies the update via the updater and returns the reloaded row.
- **Success:** 200 ManualTransaction; example (`{"title":"Oracle API cash edited","amount":"30"}`) → `"amount":{"cents":3000,"currency":"PLN"},"signed_amount":{"cents":-3000,…},"title":"Oracle API cash edited"`, `updated_at` changed. [V]
- **Errors:** 400 (`{"message":"Invalid parameters.","details":["direction does not have a valid value"]}` for `direction "up"`) [V]; 404; 422 auto-generated row; 422 `{"message": result.error, "details": [...]}` on validation failure. [I]
- **Oracle:** [PATCH_api__version_cash_transactions__id.json](../oracle/http/PATCH_api__version_cash_transactions__id.json): `default` → 200, `invalid_direction` → 400. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:134-159`. [V]

<a id="route-delete-api-v1-cash-transactions-id"></a>
##### DELETE /api/v1/cash_transactions/:id

- **Source:** `lib/api/resources/cash_transactions.rb:105-110`.
- **Behaviour:** same `load_manual!` guard (422 `"This transaction was auto-generated and isn't editable here."` for non-manual rows) [I]; then hard-deletes the row (`destroy!`, dependent enrichment handled by the model). [I]
- **Success:** **204**, empty body. [V]
- **Errors:** 404 unknown/foreign. [V]
- **Oracle:** [DELETE_api__version_cash_transactions__id.json](../oracle/http/DELETE_api__version_cash_transactions__id.json): `default` → 204, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:161-170`. [V]

#### B.2.3 Bank transactions and classification

<a id="route-get-api-v1-bank-transactions"></a>
##### GET /api/v1/bank_transactions

- **Source:** `lib/api/resources/bank_transactions.rb:8-38`. Paginated.
- **Params:** `account_id` Integer, `merchant_id` Integer, `category_id` Integer, `payment_method` String,
  `enrichment_source` String, `from` Date, `to` Date, `page`, `limit`.
- **Behaviour:** the user's bank-synced transactions; `from`/`to` inclusive on `booking_date`; `merchant_id`,
  `category_id`, `enrichment_source` filter on the enrichment row (inner join: transactions without an enrichment are
  excluded when any of these three is given; `category_id` matches the enrichment's **override** category only, not the
  merchant default). Ordered `booking_date DESC`. [I]
- **Success:** 200 `{data: BankTransaction[], pagination}`; example (`limit=3`): first row `{"id":54,"external_id":"fake-tx-54","bank_account_id":3,"amount":{"cents":500,"currency":"EUR"},…,"enrichment":null}`, `pagination {"page":1,"limit":3,"count":54,"pages":18}`. [V]
- **Oracle:** [GET_api__version_bank_transactions.json](../oracle/http/GET_api__version_bank_transactions.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:172-187`. [V]

<a id="route-get-api-v1-bank-transactions-id"></a>
##### GET /api/v1/bank_transactions/:id

- **Source:** `lib/api/resources/bank_transactions.rb:40-48`.
- **Success:** 200 BankTransaction with nested enrichment/merchant/category/effective_category (oracle `default`, id 1). [V]
- **Errors:** 404 `"Couldn't find BankTransaction with 'id'=55 [WHERE \"tpp_credentials\".\"user_id\" = $1]"`. [V]
- **Oracle:** [GET_api__version_bank_transactions__id.json](../oracle/http/GET_api__version_bank_transactions__id.json): `default` → 200, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:189-198`. [V]

<a id="route-post-api-v1-bank-transactions-bank-transaction-id-classification"></a>
##### POST /api/v1/bank_transactions/:bank_transaction_id/classification

- **Source:** `lib/api/resources/transaction_enrichments.rb:10-43`. Service: `Enrichment::ClassificationApplier`
  (`app/services/enrichment/classification_applier.rb`) (BR-200..299, classification).
- **Params:**

  | Name | Type | Req | Allowed | Notes |
  |---|---|---|---|---|
  | `mode` | String | **yes** | `only_this`, `all_for_merchant`, `create_rule` | propagation strategy |
  | `merchant_id` | Integer | no | | looked up among the user's merchants (any state); foreign/unknown → none |
  | `category_id` | Integer | no | | looked up among the user's categories; foreign/unknown → none |
  | `rule_field` | String | no | `title`, `counterparty_name`, `counterparty_iban` | default `title` |
  | `rule_kind` | String | no | `contains`, `equals`, `regex`, `starts_with`, `ends_with` | default `contains` |
  | `rule_pattern` | String | no | | required when `mode=create_rule` |

- **Behaviour** [I; messages V where cited]:
  - Validation order: unknown mode → `"Unknown propagation mode: <mode>"` (unreachable via API because of the enum);
    merchant missing and mode ≠ `only_this` → `"Pick a merchant"` [V] (`spec/requests/api/v1/transactions_spec.rb:212-224`);
    `create_rule` without pattern → `"Pick a pattern"` [V] (oracle).
  - `only_this`: sets the transaction's enrichment merchant + category (both may be null — a missing/foreign
    `category_id` clears the category), `category_overridden = category present`, `source "manual"`, clears rule/confidence/model.
  - `all_for_merchant`: sets merchant's `default_category` (if a category was given), enrichment merchant = merchant,
    category = null, `source "user_rule"`.
  - `create_rule`: creates a user-source merchant rule (priority 100, enabled, approved), updates merchant default
    category if a different category was given, then rebuilds all enrichments for the user.
  - Success message (not returned by the API, used by MCP): `"Applied: this transaction only"`, `"Applied: all transactions for this merchant"`, `"Applied: new rule + rebuild"`.
- **Success:** **201** TransactionEnrichment (reloaded). Example (`{"mode":"only_this","merchant_id":58,"category_id":238}`): `{"id":26,"merchant_id":58,"category_id":238,"merchant_rule_id":null,"source":"manual","category_overridden":true,"confidence":null,"model":null,"enriched_at":"2026-10-21T12:50:51.128Z","merchant":{…},"category":{…},"effective_category":{…}}`. [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["mode does not have a valid value"]}` [V]; 404 foreign transaction [V] (`transactions_spec.rb:226-235`); 422 **`{"message":"Pick a pattern"}`** — note: only `message`, no `details` [V].
- **Oracle:** [POST_api__version_bank_transactions__bank_transaction_id_classification.json](../oracle/http/POST_api__version_bank_transactions__bank_transaction_id_classification.json):
  `default` → 201, `create_rule_missing_pattern` → 422, `invalid_mode` → 400. [V]
- **Specs:** `spec/requests/api/v1/transactions_spec.rb:200-235`. [V]

#### B.2.4 Categories

<a id="route-get-api-v1-categories"></a>
##### GET /api/v1/categories

- **Source:** `lib/api/resources/categories.rb:8-18`. **Not paginated.**
- **Params:** `include_archived` Boolean, default `false`.
- **Behaviour:** the user's categories (active only unless `include_archived=true`), ordered by `path` text ascending
  (`app/models/category.rb:64`). [V] (oracle body ordered `education`, `education.books`, …)
- **Success:** 200 bare array of Category: `[{"id":6,"name":"Edukacja","slug":"education","path":"education","kind":"expense","color":"indigo","icon":"book-open","essential":false,"position":5,"archived_at":null,"parent_path":null}, …]`. [V]
- **Oracle:** [GET_api__version_categories.json](../oracle/http/GET_api__version_categories.json): `default` → 200, `include_archived` → 200. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:6-32`. [V]

<a id="route-post-api-v1-categories"></a>
##### POST /api/v1/categories

- **Source:** `lib/api/resources/categories.rb:20-47`. Service: `Categories::Creator` (`app/services/categories/creator.rb`) (BR-200..299, category model).
- **Params:** `name` String **required**; `slug` String; `kind` (`expense|income|transfer|savings|ignored`, default `expense`);
  `color` String; `icon` String; `position` Integer; `essential` Boolean; `parent_path` String (parent's ltree path; empty/absent = top level).
- **Behaviour:** slug defaults to a transliteration of the name (lower-case, combining marks removed, non `[a-z0-9]`
  runs → `_`, trimmed), made unique per user with suffix `_2`, `_3`…; `path = parent_path + "." + slug` or `slug`. [I]
  (`app/services/categories/creator.rb:19-52`); oracle `"Oracle API Category"` + parent `food` → slug `oracle_api_category`, path `food.oracle_api_category`. [V]
- **Success:** **201** Category. [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["name is missing"]}` [V]; 422 `{"message":"Slug has already been taken, Path has already been taken","details":["Slug has already been taken","Path has already been taken"]}` for an explicit duplicate slug [V].
- **Oracle:** [POST_api__version_categories.json](../oracle/http/POST_api__version_categories.json): `default` → 201, `missing_name` → 400, `duplicate_slug` → 422. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:34-55` (blank name → 400 or 422). [V]

<a id="route-get-api-v1-categories-id"></a>
##### GET /api/v1/categories/:id

- **Source:** `lib/api/resources/categories.rb:56-61`.
- **Success:** 200 Category (`{"id":1,"name":"Jedzenie","slug":"food","path":"food","kind":"expense","color":"emerald","icon":"utensils","essential":false,"position":0,"archived_at":null,"parent_path":null}`). [V]
- **Errors:** 404 foreign (`"Couldn't find Category with 'id'=119 [WHERE \"categories\".\"user_id\" = $1]"`); non-integer id → Rails HTML 404. [V]
- **Oracle:** [GET_api__version_categories__id.json](../oracle/http/GET_api__version_categories__id.json): `default` → 200, `other_tenant_id` → 404, `non_integer_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:57-66`. [V]

<a id="route-patch-api-v1-categories-id"></a>
##### PATCH /api/v1/categories/:id

- **Source:** `lib/api/resources/categories.rb:63-88`. Service: `Categories::Mover` (`app/services/categories/mover.rb`).
- **Params (optional):** `name`, `slug`, `kind` (enum as create, no default), `color`, `icon`, `position` Integer, `essential` Boolean, `parent_path` String.
- **Behaviour:** updates attributes; when `parent_path` is non-blank, recomputes `path = parent_path.slug` (only if the
  candidate is a valid ltree path) and, if the path changed, rewrites the paths of all descendants in the same
  transaction. A blank `parent_path` is ignored (cannot move a category back to top level via this endpoint; see U-616). [I]
- **Success:** 200 Category (`{"name":"Oracle API Category Renamed","color":"#ff0000",…}` → updated row). [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["kind does not have a valid value"]}` [V]; 404 foreign [V]; 422 `{message, details}` on validation failure [I].
- **Oracle:** [PATCH_api__version_categories__id.json](../oracle/http/PATCH_api__version_categories__id.json): `default` → 200, `invalid_kind` → 400, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:68-77`. [V]

<a id="route-delete-api-v1-categories-id"></a>
##### DELETE /api/v1/categories/:id

- **Source:** `lib/api/resources/categories.rb:90-99`.
- **Behaviour:** refuses when the category is in use — it has descendants, merchants (as default category) or
  transaction enrichments (`app/models/category.rb:112-114`) — with 422
  `{"message":"Can't delete - this category is in use or has sub-categories. Archive it instead."}`; otherwise hard-deletes. [V]
- **Success:** **204** empty. [V] (`spec/requests/api/v1/categorization_spec.rb:91-100`)
- **Oracle:** [DELETE_api__version_categories__id.json](../oracle/http/DELETE_api__version_categories__id.json): `default` → 422 (category 238 was a merchant default), `category_in_use_or_with_children` → 422. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:79-100`. [V]

<a id="route-post-api-v1-categories-id-archive"></a>
##### POST /api/v1/categories/:id/archive

- **Source:** `lib/api/resources/categories.rb:101-108`.
- **Behaviour:** sets `archived_at = now` unless already archived (idempotent; timestamp not refreshed) (`app/models/category.rb:79-81`). [I]
- **Success:** **201** Category with `archived_at` set (`"archived_at":"2026-10-21T12:50:42.173Z"`). [V]
- **Oracle:** [POST_api__version_categories__id_archive.json](../oracle/http/POST_api__version_categories__id_archive.json): `default` → 201. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:102-111`. [V]

<a id="route-post-api-v1-categories-id-unarchive"></a>
##### POST /api/v1/categories/:id/unarchive

- **Source:** `lib/api/resources/categories.rb:110-117`. Sets `archived_at = null` (`app/models/category.rb:77`). [I]
- **Success:** **201** Category with `"archived_at":null`. [V]
- **Oracle:** [POST_api__version_categories__id_unarchive.json](../oracle/http/POST_api__version_categories__id_unarchive.json): `default` → 201. [V]

#### B.2.5 Merchants and merchant rules

<a id="route-get-api-v1-merchants"></a>
##### GET /api/v1/merchants

- **Source:** `lib/api/resources/merchants.rb:8-29`. Paginated.
- **Params:** `q` String (case-insensitive substring on `name`, `ILIKE %q%`, ignored when blank); `source` String
  (`user|llm|seed`); `category_id` Integer (exact `default_category_id`); `include_archived` Boolean default `false`; `page`, `limit`.
- **Behaviour:** the user's merchants, active only unless `include_archived`, ordered by `name` ascending. [I]
  Note: seeded/system merchants have `source = "system"`, which is not an allowed filter value (see U-607). [V]
- **Success:** 200 `{data: Merchant[], pagination}`; first row `{"id":12,"name":"4F (OTCF)","slug":"otcf_4f","kind":"company","source":"system",…,"default_category":{…}}`, `pagination {"page":1,"limit":10,"count":29,"pages":3}`. [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["source does not have a valid value"]}` [V]; 401 (all auth cases documented on this route) [V].
- **Oracle:** [GET_api__version_merchants.json](../oracle/http/GET_api__version_merchants.json): `unknown_api_path_404` → 404, `no_token` → 401,
  `invalid_token` → 401, `revoked_token` → 401, `cors_preflight_like_origin` → 200, `default` → 200, `filtered` → 200, `invalid_enum` → 400. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:113-140`. [V]

<a id="route-post-api-v1-merchants"></a>
##### POST /api/v1/merchants

- **Source:** `lib/api/resources/merchants.rb:31-53`. Service: `Merchants::Creator` (`app/services/merchants/creator.rb`) (BR-200..299).
- **Params:** `name` String **required**; `slug` String; `kind` (`company|person|unknown`, default `company`);
  `default_category_id` Integer; `logo_url` String; `notes` String.
- **Behaviour:** creates a merchant with `source "user"`, `approved_at = now`, `approved_by = user`; slug generated from
  the name when blank (same algorithm as categories, unique per user). [I] `default_category_id` is **not** checked
  against the user's categories: another tenant's category id is accepted and that category is then exposed in
  `default_category` (BUG?, see U-604). [V] case `foreign_category` → 201 with `"default_category":{"id":119,…}`.
- **Success:** **201** Merchant (`{"id":58,"name":"Oracle API Merchant","slug":"oracle_api_merchant","kind":"company","source":"user",…,"approved_at":"2026-10-21T12:50:42.575Z"}`). [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["name is missing"]}` [V]; 422 `{message, details}` from the creator [I].
- **Oracle:** [POST_api__version_merchants.json](../oracle/http/POST_api__version_merchants.json): `default` → 201, `missing_name` → 400, `foreign_category` → 201. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:142-150`. [V]

<a id="route-get-api-v1-merchants-id"></a>
##### GET /api/v1/merchants/:id

- **Source:** `lib/api/resources/merchants.rb:62-67`.
- **Success:** 200 Merchant (`{"id":1,"name":"Biedronka","slug":"biedronka",…,"default_category":{"id":12,…}}`). [V]
- **Errors:** 404 foreign (`"Couldn't find Merchant with 'id'=29 [WHERE \"merchants\".\"user_id\" = $1]"`). [V]
- **Oracle:** [GET_api__version_merchants__id.json](../oracle/http/GET_api__version_merchants__id.json): `default` → 200, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:152-161`. [V]

<a id="route-patch-api-v1-merchants-id"></a>
##### PATCH /api/v1/merchants/:id

- **Source:** `lib/api/resources/merchants.rb:69-84`.
- **Params (optional):** `name`, `slug`, `kind` (`company|person|unknown`), `default_category_id` Integer, `logo_url`, `notes`.
- **Behaviour:** direct `update!` of the supplied fields (no service; `default_category_id` unscoped, see U-604). [I]
- **Success:** 200 Merchant (`{"notes":"edited"}` → `"notes":"edited"`). [V]
- **Errors:** 404; 422 `{message, details}` (RecordInvalid). [I]
- **Oracle:** [PATCH_api__version_merchants__id.json](../oracle/http/PATCH_api__version_merchants__id.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:163-172`. [V]

<a id="route-delete-api-v1-merchants-id"></a>
##### DELETE /api/v1/merchants/:id

- **Source:** `lib/api/resources/merchants.rb:86-95`.
- **Behaviour:** if any transaction enrichment references the merchant → 422
  `{"message":"Can't delete - this merchant has linked transactions. Archive it instead."}`; otherwise hard-deletes. [V]
- **Success:** **204** empty. [I]
- **Oracle:** [DELETE_api__version_merchants__id.json](../oracle/http/DELETE_api__version_merchants__id.json): `default` → 422. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:174-185`. [V]

<a id="route-post-api-v1-merchants-id-archive"></a>
##### POST /api/v1/merchants/:id/archive

- **Source:** `lib/api/resources/merchants.rb:97-104`. Sets `archived_at = now` (always overwrites, unlike categories). [I]
- **Success:** **201** Merchant with `archived_at` set. [V]
- **Oracle:** [POST_api__version_merchants__id_archive.json](../oracle/http/POST_api__version_merchants__id_archive.json): `default` → 201. [V]

<a id="route-post-api-v1-merchants-id-unarchive"></a>
##### POST /api/v1/merchants/:id/unarchive

- **Source:** `lib/api/resources/merchants.rb:106-113`. Sets `archived_at = null`. [I]
- **Success:** **201** Merchant with `"archived_at":null`. [V]
- **Oracle:** [POST_api__version_merchants__id_unarchive.json](../oracle/http/POST_api__version_merchants__id_unarchive.json): `default` → 201. [V]

<a id="route-post-api-v1-merchants-id-approve"></a>
##### POST /api/v1/merchants/:id/approve

- **Source:** `lib/api/resources/merchants.rb:115-122`. Service: `Merchants::Approver` (`app/services/merchants/approver.rb`) (BR-200..299, LLM approval).
- **Behaviour:** in one transaction sets `approved_at = now`, `approved_by = user` and enables every disabled
  `source "llm"` rule of the merchant (setting their `approved_at/approved_by`); afterwards rebuilds all enrichments of
  the merchant's owner (`Enrichment::TransactionEnricher.rebuild!`). Works for any merchant (also already approved / user-source). [I]
- **Success:** **201** Merchant (reloaded; `approved_at` updated). [V]
- **Oracle:** [POST_api__version_merchants__id_approve.json](../oracle/http/POST_api__version_merchants__id_approve.json): `default` → 201. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:187-197`. [V]

<a id="route-get-api-v1-merchants-merchant-id-rules"></a>
##### GET /api/v1/merchants/:merchant_id/rules

- **Source:** `lib/api/resources/merchant_rules.rb:16-22`. **Not paginated.**
- **Behaviour:** the merchant's rules ordered by `source` ascending, then `priority` descending; 404 if the merchant is not the user's. [I]
- **Success:** 200 bare array: `[{"id":1,"merchant_id":1,"field":"title","kind":"contains","pattern":"BIEDRONKA","case_sensitive":false,"priority":0,"enabled":true,"source":"system","confidence":null,"model":null,"approved_at":null}]`. [V]
- **Oracle:** [GET_api__version_merchants__merchant_id_rules.json](../oracle/http/GET_api__version_merchants__merchant_id_rules.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:199-210`. [V]

<a id="route-post-api-v1-merchants-merchant-id-rules"></a>
##### POST /api/v1/merchants/:merchant_id/rules

- **Source:** `lib/api/resources/merchant_rules.rb:24-47`. Service: `MerchantRules::Creator` (`app/services/merchant_rules/creator.rb`) (BR-200..299).
- **Params:** `kind` **required** (`contains|equals|regex|starts_with|ends_with`); `field` **required**
  (`title|counterparty_name|counterparty_iban`); `pattern` String **required**; `case_sensitive` Boolean default `false`;
  `priority` Integer default `0`; `enabled` Boolean default `true`.
- **Behaviour:** builds the rule with `user = current user`, `source "user"`, `approved_at = now`, `approved_by = user`;
  on save rebuilds all enrichments of the user. [I]
- **Success:** **201** MerchantRule (`{"id":67,"merchant_id":58,"field":"title","kind":"contains","pattern":"ORACLE SHOP","case_sensitive":false,"priority":0,"enabled":true,"source":"user",…}`). [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["field is missing","field does not have a valid value","pattern is missing"]}` [V];
  422 `{"message":"Pattern is not a valid regex: premature end of char-class: /([/","details":["Pattern is not a valid regex: premature end of char-class: /([/"]}` [V] (regex syntax/message is Ruby's; see the merchant-rule model doc).
- **Oracle:** [POST_api__version_merchants__merchant_id_rules.json](../oracle/http/POST_api__version_merchants__merchant_id_rules.json): `default` → 201, `invalid_regex` → 422, `missing_required` → 400. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:212-226`. [V]

<a id="route-patch-api-v1-merchants-merchant-id-rules-id"></a>
##### PATCH /api/v1/merchants/:merchant_id/rules/:id

- **Source:** `lib/api/resources/merchant_rules.rb:56-78`. Service: `MerchantRules::Updater`.
- **Params (optional):** `kind`, `field` (enums as above), `pattern`, `case_sensitive`, `priority`, `enabled`.
- **Behaviour:** updates the rule and rebuilds the user's enrichments on success. [I]
- **Success:** 200 MerchantRule (`{"priority":5,"enabled":false}` applied). [V]
- **Errors:** 400 enum; 404 (merchant or rule not the user's); 422 `{message, details}`. [I]
- **Oracle:** [PATCH_api__version_merchants__merchant_id_rules__id.json](../oracle/http/PATCH_api__version_merchants__merchant_id_rules__id.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:228-239`. [V]

<a id="route-delete-api-v1-merchants-merchant-id-rules-id"></a>
##### DELETE /api/v1/merchants/:merchant_id/rules/:id

- **Source:** `lib/api/resources/merchant_rules.rb:80-85`. Service: `MerchantRules::Destroyer` (destroys, then rebuilds enrichments). [I]
- **Success:** **204** empty. [V]
- **Oracle:** [DELETE_api__version_merchants__merchant_id_rules__id.json](../oracle/http/DELETE_api__version_merchants__merchant_id_rules__id.json): `default` → 204. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:241-252`. [V]

#### B.2.6 Bank accounts

<a id="route-get-api-v1-bank-accounts"></a>
##### GET /api/v1/bank_accounts

- **Source:** `lib/api/resources/bank_accounts.rb:8-23`. Paginated.
- **Params:** `manual` Boolean (true → only cash wallets, false → only synced; absent → both), `page`, `limit`.
- **Behaviour:** all accounts in `user.all_bank_account_ids`, ordered by `created_at` ascending. [I]
- **Success:** 200 `{data: BankAccount[], pagination}`; e.g. `manual=true` → `[{"id":5,"uid":"cash_1_pln","name":"Cash wallet (PLN)","iban":null,…,"manual":true,"cash_account_type":"CASH",…,"balances":[]}]`. [V]
- **Oracle:** [GET_api__version_bank_accounts.json](../oracle/http/GET_api__version_bank_accounts.json): `default` → 200, `manual_only` → 200. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:6-34`. [V]

<a id="route-get-api-v1-bank-accounts-id"></a>
##### GET /api/v1/bank_accounts/:id

- **Source:** `lib/api/resources/bank_accounts.rb:32-37`.
- **Success:** 200 BankAccount, e.g. `{"id":1,"uid":"fake-account-fake-session-1-1","name":"MACIEJ TEST","iban":"PL61109010140000071219812874","bban":null,"currency":"PLN","status":"active","manual":false,"product":"Konto Osobiste","cash_account_type":"CACC","details":"Konto Osobiste","details_fetched_at":"2026-10-21T12:50:30.324Z","balances_synced_at":"2026-10-21T12:50:30.042Z","transactions_synced_at":"2026-10-21T12:50:32.239Z","balances":[{"name":null,"type":"ITAV","amount_cents":1234567,"currency":"PLN","reference_date":"2026-10-21","last_change_at":null}]}`. [V]
- **Errors:** 404 foreign. [V] (`spec/requests/api/v1/banking_spec.rb:48-57`)
- **Oracle:** [GET_api__version_bank_accounts__id.json](../oracle/http/GET_api__version_bank_accounts__id.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:36-57`. [V]

<a id="route-post-api-v1-bank-accounts-id-refresh-details"></a>
##### POST /api/v1/bank_accounts/:id/refresh_details

- **Source:** `lib/api/resources/bank_accounts.rb:39-49`. Service: `EnableBanking::Operations::RefreshAccountDetails`
  (BR-001..199, banking; live AISP call).
- **Behaviour:** calls the provider for account details, then returns the reloaded account. Provider failure
  (`RefreshAccountDetails::Failed`) → 422 `{"message":"Refresh failed: <error>"}` (no `details`). For a manual cash
  wallet the outcome depends on the operation (not exercised). [I]
- **Success:** **201** BankAccount with `details_fetched_at` updated. [V]
- **Oracle:** [POST_api__version_bank_accounts__id_refresh_details.json](../oracle/http/POST_api__version_bank_accounts__id_refresh_details.json): `default` → 201. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:72-82`. [V]

<a id="route-post-api-v1-bank-accounts-id-refresh-balances"></a>
##### POST /api/v1/bank_accounts/:id/refresh_balances

- **Source:** `lib/api/resources/bank_accounts.rb:51-61`. Service: `EnableBanking::Operations::RefreshAccountBalances` (BR-001..199; live AISP call).
- **Behaviour:** as above for balances; failure → 422 `{"message":"Refresh failed: <error>"}`. [V] (`spec/requests/api/v1/banking_spec.rb:59-70`, message matches `/network down/`)
- **Success:** **201** BankAccount with `balances_synced_at` updated. [V]
- **Oracle:** [POST_api__version_bank_accounts__id_refresh_balances.json](../oracle/http/POST_api__version_bank_accounts__id_refresh_balances.json): `default` → 201. [V]

#### B.2.7 Bank connections

<a id="route-get-api-v1-bank-connections"></a>
##### GET /api/v1/bank_connections

- **Source:** `lib/api/resources/bank_connections.rb:8-23`. Paginated.
- **Params:** `status` String (free text, exact match; no enum validation), `page`, `limit`.
- **Behaviour:** the user's connections ordered by `valid_until` ascending. [I]
- **Success:** 200 `{data: BankConnection[], pagination}`; row: `{"id":1,"bank_name":"PKO BP","bank_slug":"pko_bp","bank_country":"PL","psu_type":"personal","status":"authorized","authorized_at":"2026-10-21T12:49:32.000Z","valid_until":"2026-11-20T12:50:04.000Z",…,"tpp_credential_id":1,"last_error":null}`. [V]
- **Oracle:** [GET_api__version_bank_connections.json](../oracle/http/GET_api__version_bank_connections.json): `default` → 200, `status_filter_authorized` → 200. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:84-96`. [V]

<a id="route-get-api-v1-bank-connections-id"></a>
##### GET /api/v1/bank_connections/:id

- **Source:** `lib/api/resources/bank_connections.rb:32-37`.
- **Success:** 200 BankConnection. **Errors:** 404 `"Couldn't find BankConnection with 'id'=3 [WHERE \"tpp_credentials\".\"user_id\" = $1]"`. [V]
- **Oracle:** [GET_api__version_bank_connections__id.json](../oracle/http/GET_api__version_bank_connections__id.json): `default` → 200, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:98-107`. [V]

<a id="route-patch-api-v1-bank-connections-id"></a>
##### PATCH /api/v1/bank_connections/:id

- **Source:** `lib/api/resources/bank_connections.rb:39-50`.
- **Params (optional):** `valid_until` DateTime, `status` String (validated by the model against
  `pending|authorized|expired|revoked|replaced|error|closed`).
- **Behaviour:** direct `update!` of the supplied fields; no provider call. [I]
- **Success:** 200 BankConnection. [V] (`spec/requests/api/v1/banking_spec.rb:109-119`)
- **Errors:** 422 `{"message":"Status is not included in the list","details":["Status is not included in the list"]}`. [V]
- **Oracle:** [PATCH_api__version_bank_connections__id.json](../oracle/http/PATCH_api__version_bank_connections__id.json): `invalid_status` → 422. [V]

<a id="route-post-api-v1-bank-connections-id-refresh"></a>
##### POST /api/v1/bank_connections/:id/refresh

- **Source:** `lib/api/resources/bank_connections.rb:52-62`. Service: `EnableBanking::Operations::RefreshConnection` (BR-001..199; live call).
- **Behaviour:** pulls current status/validity from the provider; failure → 422 `{"message":"Refresh failed: <error>"}`. [I]
- **Success:** **201** BankConnection with `last_refreshed_at` updated. [V]
- **Oracle:** [POST_api__version_bank_connections__id_refresh.json](../oracle/http/POST_api__version_bank_connections__id_refresh.json): `default` → 201. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:121-130`. [V]

<a id="route-delete-api-v1-bank-connections-id"></a>
##### DELETE /api/v1/bank_connections/:id

- **Source:** `lib/api/resources/bank_connections.rb:64-71`. Service: `EnableBanking::Operations::CloseConnection` (BR-001..199).
- **Behaviour:** closes the session at the provider; the record is **kept** with `status "closed"` and returned.
  Errors raised by the operation are not mapped locally (→ 500 via the global handler). [V]/[I]
- **Success:** **200** BankConnection with `"status":"closed"`. [V]
- **Errors:** 404 foreign. [V]
- **Oracle:** [DELETE_api__version_bank_connections__id.json](../oracle/http/DELETE_api__version_bank_connections__id.json): `default` → 200, `other_tenant_id` → 404. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:132-141`. [V]

#### B.2.8 TPP credentials

<a id="route-get-api-v1-tpp-credentials"></a>
##### GET /api/v1/tpp_credentials

- **Source:** `lib/api/resources/tpp_credentials.rb:8-19`. Paginated; ordered `created_at DESC`. [I]
- **Success:** 200 `{data: TppCredential[], pagination}`; row `{"id":2,"name":"Revolut (Showcase)","provider":"enable_banking","environment":"SANDBOX","status":"active","primary":false,"redirect_url":"http://localhost:3000/admin/oauth/enable_banking/callback","cert_expires_at":null,"last_verified_at":"2026-10-21T12:49:32.292Z","last_verification_error":null}`. [V]
- **Oracle:** [GET_api__version_tpp_credentials.json](../oracle/http/GET_api__version_tpp_credentials.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:143-157`. [V]

<a id="route-post-api-v1-tpp-credentials"></a>
##### POST /api/v1/tpp_credentials

- **Source:** `lib/api/resources/tpp_credentials.rb:21-40`.
- **Params:** `name` String **required**; `provider` default `enable_banking`; `environment` default `PRODUCTION`;
  `redirect_url`, `application_id`, `private_key_pem`, `public_cert_pem` (Strings). No Grape enum — validated by the model. [I]
- **Behaviour:** builds the credential for the user; it becomes `primary` if the user has no credentials yet; `save!`.
  Status starts as `pending`. No provider verification on create. [V] (oracle `"status":"pending","primary":false`)
- **Success:** **201** TppCredential. [V]
- **Errors:** 422 `{"message":"Environment is not included in the list, Application can't be blank, Private key pem can't be blank, Redirect url can't be blank","details":[…4 items…]}`. [V]
- **Oracle:** [POST_api__version_tpp_credentials.json](../oracle/http/POST_api__version_tpp_credentials.json): `default` → 201, `invalid_environment` → 422. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:159-172`. [V]

<a id="route-get-api-v1-tpp-credentials-id"></a>
##### GET /api/v1/tpp_credentials/:id

- **Source:** `lib/api/resources/tpp_credentials.rb:49-54`.
- **Success:** 200 TppCredential. **Errors:** 404 foreign. [V]
- **Oracle:** [GET_api__version_tpp_credentials__id.json](../oracle/http/GET_api__version_tpp_credentials__id.json): `default` → 200, `other_tenant_id` → 404. [V]

<a id="route-patch-api-v1-tpp-credentials-id"></a>
##### PATCH /api/v1/tpp_credentials/:id

- **Source:** `lib/api/resources/tpp_credentials.rb:56-72`.
- **Params (optional):** `name`, `provider`, `environment`, `redirect_url`, `application_id`, `private_key_pem`, `public_cert_pem`.
- **Behaviour:** direct `update!`; 422 `{message, details}` on validation failure. [I]
- **Success:** 200 TppCredential (`{"name":"Oracle TPP renamed"}`). [V]
- **Oracle:** [PATCH_api__version_tpp_credentials__id.json](../oracle/http/PATCH_api__version_tpp_credentials__id.json): `default` → 200. [V]

<a id="route-delete-api-v1-tpp-credentials-id"></a>
##### DELETE /api/v1/tpp_credentials/:id

- **Source:** `lib/api/resources/tpp_credentials.rb:74-83`.
- **Behaviour:** refuses with 422 `{"message":"Cannot delete - credential has bank connections. Remove them first."}`
  if any bank connection references it [V] (`spec/requests/api/v1/banking_spec.rb:174-184`); otherwise hard-deletes. Deleting the primary credential does not promote another one. [I]
- **Success:** **204** empty. [V]
- **Oracle:** [DELETE_api__version_tpp_credentials__id.json](../oracle/http/DELETE_api__version_tpp_credentials__id.json): `default` → 204. [V]

<a id="route-post-api-v1-tpp-credentials-id-test-connection"></a>
##### POST /api/v1/tpp_credentials/:id/test_connection

- **Source:** `lib/api/resources/tpp_credentials.rb:85-96`. Service: `EnableBanking::Operations::VerifyCredential`
  (`app/services/enable_banking/operations/verify_credential.rb`) (BR-001..199).
- **Behaviour:** calls the provider's "get application"; on failure sets credential `status "error"` and
  `last_verification_error`, and the endpoint returns 422 `{"message":"Test failed: <provider error>"}` or
  `{"message":"Configuration error: <message>"}` [I; 422 with message `"Bad cert"` V in `spec/requests/api/v1/banking_spec.rb:186-197`].
  On success sets `status "active"`, `last_verified_at = now`, clears the error, stores provider metadata and may sync
  `redirect_url` when the provider has exactly one registered URL that differs (both `ok` and `warning` outcomes → success). [I]
- **Success:** **201** TppCredential (reloaded). [V] Oracle note: with the in-memory fake provider even the incomplete
  credential verified successfully (status → `active`, redirect_url synced to the fake's URL). [V]
- **Oracle:** [POST_api__version_tpp_credentials__id_test_connection.json](../oracle/http/POST_api__version_tpp_credentials__id_test_connection.json): `default` → 201, `incomplete_credential` → 201. [V]

<a id="route-post-api-v1-tpp-credentials-id-make-primary"></a>
##### POST /api/v1/tpp_credentials/:id/make_primary

- **Source:** `lib/api/resources/tpp_credentials.rb:98-105`; `TppCredential#make_primary!` (`app/models/tpp_credential.rb:105-110`).
- **Behaviour:** in one transaction sets `primary = false` on all the user's other credentials (bulk update) and `primary = true` on this one. [V] (`spec/requests/api/v1/banking_spec.rb:199-210`)
- **Success:** **201** TppCredential with `"primary":true`. [V]
- **Oracle:** [POST_api__version_tpp_credentials__id_make_primary.json](../oracle/http/POST_api__version_tpp_credentials__id_make_primary.json): `default` → 201, `restore_primary` → 201. [V]

#### B.2.9 Background operations (transaction syncs, LLM enrichment runs)

<a id="route-get-api-v1-transaction-syncs"></a>
##### GET /api/v1/transaction_syncs

- **Source:** `lib/api/resources/transaction_syncs.rb:10-25`. Paginated.
- **Params:** `status` String (exact, free text), `page`, `limit`.
- **Behaviour:** `OperationRun` rows with `kind "transaction_sync"` and `triggered_by_user_id = user`, newest first.
  Scheduled runs not triggered by the user are therefore not listed. [I]
- **Success:** 200 `{data: OperationRun[], pagination}`; example `summary.accounts[]` items `{"bank":"PKO BP","iban":"…","status":"succeeded","date_to":"2026-10-21","skipped":0,"updated":0,"inserted":0,"date_from":"2026-10-14","truncated":false,"pages_fetched":1,"bank_account_id":1}`. [V]
- **Oracle:** [GET_api__version_transaction_syncs.json](../oracle/http/GET_api__version_transaction_syncs.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:212-225`. [V]

<a id="route-post-api-v1-transaction-syncs"></a>
##### POST /api/v1/transaction_syncs

- **Source:** `lib/api/resources/transaction_syncs.rb:27-50`. Service: `TransactionSyncs::Queuer`
  (`app/services/transaction_syncs/queuer.rb`) (BR-001..199, sync); job `TransactionSyncJob`.
- **Params:** `bank_connection_id` Integer (omit for all connections), `date_from` Date, `date_to` Date.
- **Behaviour:** creates an `OperationRun` (`kind "transaction_sync"`, `status "queued"`, `trigger "manual"`,
  `triggered_by_user = user`, `summary {}`, `params` = `{date_from, date_to}` as ISO strings with absent keys removed)
  and enqueues the job. Subject = the user's **active** connection with that id, otherwise the **user** (= all
  connections). A foreign/unknown/inactive id therefore silently becomes an all-connections sync, and
  `date_to < date_from` is accepted (BUG?, see U-605). [V]
- **Success:** **201** OperationRun, e.g. `{"id":7,"kind":"transaction_sync","status":"queued","trigger":"manual","params":{"date_from":"2026-07-13","date_to":"2026-10-21"},"summary":{},"error":null,"scheduled_for":null,"started_at":null,"finished_at":null,"subject_type":"BankConnection","subject_id":1,"created_at":"2026-10-21T12:50:54.687Z"}`. [V]
- **Errors:** 400 for invalid dates [I]; 422 `{message, details}` if the run fails validation [I].
- **Oracle:** [POST_api__version_transaction_syncs.json](../oracle/http/POST_api__version_transaction_syncs.json): `default` → 201,
  `date_to_before_from` → 201, `other_tenant_connection` → 201 (`"subject_type":"User","subject_id":1`). [V]
- **Specs:** `spec/requests/api/v1/banking_spec.rb:227-239`. [V]

<a id="route-get-api-v1-transaction-syncs-id"></a>
##### GET /api/v1/transaction_syncs/:id

- **Source:** `lib/api/resources/transaction_syncs.rb:52-61`.
- **Success:** 200 OperationRun (example `{"id":1,…,"status":"succeeded","params":{"connection_id":1},"summary":{"synced_at":"2026-10-21T14:49:35.987+02:00"},…}`). [V]
- **Errors:** 404 for another user's or another kind's run. [V] (`spec/requests/api/v1/banking_spec.rb:241-250`)
- **Oracle:** [GET_api__version_transaction_syncs__id.json](../oracle/http/GET_api__version_transaction_syncs__id.json): `default` → 200. [V]

<a id="route-get-api-v1-llm-enrichments"></a>
##### GET /api/v1/llm_enrichments

- **Source:** `lib/api/resources/llm_enrichments.rb:10-25`. Paginated. `status` filter as above; `kind "llm_enrichment"`, triggered by the user, newest first. [I]
- **Success:** 200; row `{"id":6,"kind":"llm_enrichment","status":"succeeded","trigger":"manual","params":{"limit":5},"summary":{"batches":[],"skipped":0,"auto_applied":0,"total_groups":0,"pending_review":0},…,"subject_type":"User","subject_id":1,…}`. [V]
- **Oracle:** [GET_api__version_llm_enrichments.json](../oracle/http/GET_api__version_llm_enrichments.json): `default` → 200. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:254-267`. [V]

<a id="route-post-api-v1-llm-enrichments"></a>
##### POST /api/v1/llm_enrichments

- **Source:** `lib/api/resources/llm_enrichments.rb:27-45`. Service: `LlmEnrichments::Queuer`
  (`app/services/llm_enrichments/queuer.rb`) (BR-200..299, LLM); job `LlmEnrichmentJob`.
- **Params:** `limit` Integer, optional — max distinct title groups sent to the LLM; default 50
  (`Llm::EnrichmentRunner::DEFAULT_LIMIT`, `app/services/llm/enrichment_runner.rb:10`). Note: this `limit` is not a pagination limit. [I]
- **Behaviour:** if the user has no configured LLM setting → 422
  `{"message":"Configure an LLM provider in Preferences before running enrichment.","details":["Configure an LLM provider in Preferences before running enrichment."]}`
  — the mapping of a queuer failure to 422 `{message: result.error, details: [...]}` is [V]
  (`spec/requests/api/v1/categorization_spec.rb:269-279`, which stubs the queuer with the message "LLM not configured"),
  the exact production text comes from `app/services/llm_enrichments/queuer.rb:28-30` [I];
  otherwise creates an `OperationRun` (`kind "llm_enrichment"`, `queued`, `manual`, subject = user, `params {"limit": n}`, `summary {}`) and enqueues the job. [V]
- **Success:** **201** OperationRun (`{"id":10,"kind":"llm_enrichment","status":"queued","trigger":"manual","params":{"limit":5},"summary":{},…,"subject_type":"User","subject_id":1,…}`). [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["limit is invalid"]}` for `limit:"many"`. [V]
- **Oracle:** [POST_api__version_llm_enrichments.json](../oracle/http/POST_api__version_llm_enrichments.json): `default` → 201, `invalid_limit` → 400. [V]
- **Specs:** `spec/requests/api/v1/categorization_spec.rb:269-297`. [V]

<a id="route-get-api-v1-llm-enrichments-id"></a>
##### GET /api/v1/llm_enrichments/:id

- **Source:** `lib/api/resources/llm_enrichments.rb:47-55`.
- **Success:** 200 OperationRun. **Errors:** 404 `"Couldn't find OperationRun with 'id'=999999 [WHERE \"operation_runs\".\"kind\" = $1 AND \"operation_runs\".\"triggered_by_user_id\" = $2]"`. [V]
- **Oracle:** [GET_api__version_llm_enrichments__id.json](../oracle/http/GET_api__version_llm_enrichments__id.json): `default` → 200, `not_found` → 404. [V]

#### B.2.10 Analytics

Common analytics filter (`app/services/analytics/filter.rb`, BR-300..399 analytics) [I unless noted]:

- **Accounts:** `account_ids` (array of integers; query form `account_ids[]=1&account_ids[]=2`, also a single value)
  is intersected with the user's accounts; empty/absent/all-foreign → all of the user's accounts.
- **Period:** `from` and `to` are used **only when both are present**; otherwise the period is month-to-date
  (`first day of current month .. today`, UTC) (`filter.rb:176-190`, see U-612). `from > to` raises
  `ArgumentError "from must be <= to"` → **500** (BUG?, see U-603). [V] cash_flow case `from_after_to`.
- **Bucket:** `day|week|month` (Grape enum → 400 otherwise [V]); default by period length in days (inclusive):
  1–31 → `day`, 32–180 → `week`, >180 → `month` (`filter.rb:193-200`). [V] default MTD 21 days → `day`; 101 days → `week`.
  Week buckets start on Monday (`beginning_of_week`), month buckets on the 1st; buckets are gap-filled with zeros. [I]
- **Currency:** single-currency aggregates. Requested `currency` (case-insensitive) is honoured only if the user has
  ledger rows in it; otherwise the user's dominant currency (most rows), fallback `PLN`. [V] override honoured
  (`spec/requests/api/v1/analytics_spec.rb:117-127`); silent fallback [I].
- **Scope:** booked entries only, in the accounts + currency + period (inclusive bounds); optional `under_path` ltree prefix.
- Spend/income classification of ledger rows (`LedgerEntry.spend` / `.income`) is defined in the analytics part.

<a id="route-get-api-v1-analytics-cash-flow"></a>
##### GET /api/v1/analytics/cash_flow

- **Source:** `lib/api/resources/analytics/cash_flow.rb:9-35`. Service: `Analytics::CashFlow` (`app/services/analytics/cash_flow.rb`).
- **Params:** `from` Date, `to` Date, `bucket` (`day|week|month`), `currency` String, `account_ids` Array[Integer], `under_path` String.
- **Behaviour:** totals = sums of `amount_cents` of spend rows and income rows; `net = income − spend`; series per bucket. [I]
- **Success:** 200
  ```json
  {"currency":"PLN","period":{"from":"2026-07-13","to":"2026-10-21","bucket":"month"},
   "totals":{"spend_cents":231240,"income_cents":1950000,"net_cents":1718760},
   "series":[{"date":"2026-07-01","spend_cents":0,"income_cents":0,"net_cents":0}]}
  ```
  (oracle `explicit_range`; series shortened — the first bucket date is the bucket start, `2026-07-01`, which precedes `from`). [V]
- **Errors:** 400 `{"message":"Invalid parameters.","details":["bucket does not have a valid value"]}` [V]; 400 for an invalid date (`spec/requests/api/v1/analytics_spec.rb:129-136`) [V]; 500 `{"message":"ArgumentError: from must be <= to"}` [V].
- **Oracle:** [GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json): `default` → 200, `explicit_range` → 200, `invalid_bucket` → 400, `from_after_to` → 500. [V]
- **Specs:** `spec/requests/api/v1/analytics_spec.rb:6-18,117-136`. [V]

<a id="route-get-api-v1-analytics-spend"></a>
##### GET /api/v1/analytics/spend

- **Source:** `lib/api/resources/analytics/spend.rb:9-45`. Service: `Analytics::SpendBreakdown.by_category` (`app/services/analytics/spend_breakdown.rb:22-32`).
- **Params:** as cash_flow plus `depth` Integer (absent → one row per full category path; 1 → top level; 2 → second level).
- **Behaviour** [I]: groups spend rows by `category_path` (or its first `depth` segments; rows with shorter paths are
  excluded when depth is given; uncategorised rows are excluded); `name` = the user's category name for that path, else
  the title-cased last segment; `prev_amount_cents` = same grouping over the previous period (calendar-month aware:
  full month → previous full month; month-to-date → same days of previous month capped at its end; otherwise the
  equally long preceding window); `delta_pct = round((amount − prev) / prev × 100)`, null when prev is 0;
  `slug` = path with `.` → `_`; sorted by amount descending; `total_cents` = sum of rows.
- **Success:** 200 `{"currency":"PLN","period":{"from":"2026-07-13","to":"2026-10-21","bucket":"week"},"total_cents":229241,"rows":[{"path":"health.body","slug":"health_body","name":"Ciało","amount_cents":110000,"prev_amount_cents":0,"count":5,"delta_pct":null}]}` (rows shortened). [V]
- **Oracle:** [GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json): `default` (`depth=2`) → 200. [V]
- **Specs:** `spec/requests/api/v1/analytics_spec.rb:20-30`. [V]

<a id="route-get-api-v1-analytics-top-merchants"></a>
##### GET /api/v1/analytics/top_merchants

- **Source:** `lib/api/resources/analytics/top_merchants.rb:9-41`. Service: `Analytics::TopMerchants` (`app/services/analytics/top_merchants.rb`).
- **Params:** `from`, `to`, `currency`, `account_ids`, `under_path`, `limit` Integer default **10** (not clamped; see U-611). No `bucket`.
- **Behaviour:** spend rows with a merchant, grouped by merchant, ordered by sum descending, limited; merchants not owned by the user are dropped. [I]
- **Success:** 200 `{"currency":"PLN","period":{"from":"2026-07-13","to":"2026-10-21"},"rows":[{"merchant":{"id":11,"name":"Decathlon","slug":"decathlon","default_category_id":51},"amount_cents":110000,"count":5}]}` (rows shortened). [V]
- **Oracle:** [GET_api__version_analytics_top_merchants.json](../oracle/http/GET_api__version_analytics_top_merchants.json): `default` (`limit=5`) → 200. [V]
- **Specs:** `spec/requests/api/v1/analytics_spec.rb:32-42`. [V]

<a id="route-get-api-v1-analytics-categories-slug"></a>
##### GET /api/v1/analytics/categories/:slug

- **Source:** `lib/api/resources/analytics/categories.rb:10-56`. Service: `Analytics::SpendBreakdown.by_merchant_in_category` / `.by_subpath`.
- **Params:** `slug` (path, required), `from`, `to`, `currency`, `account_ids`. (No `bucket`/`under_path`.)
- **Behaviour** [I]: finds the user's category by slug (404 otherwise); merchants = spend in the category subtree
  grouped by merchant (`merchant` null for rows without a merchant), sorted by amount desc; `subtree` = spend grouped
  by the next path level below the category (empty array when the category has no descendants); `total_cents` = sum of merchant rows.
- **Success:** 200 `{"category":{"id":1,"name":"Jedzenie","slug":"food","path":"food","kind":"expense"},"currency":"PLN","period":{"from":"2026-07-13","to":"2026-10-21"},"total_cents":38745,"merchants":[{"merchant":{"id":6,"name":"Żabka","slug":"zabka"},"amount_cents":22500,"count":5}],"subtree":[{"path":"food.cooking","slug":"food_cooking","name":"W domu","amount_cents":30496,"count":9}]}` (arrays shortened). [V]
- **Errors:** 404 `"Couldn't find Category with [WHERE \"categories\".\"user_id\" = $1 AND \"categories\".\"slug\" = $2]"` (unknown or foreign slug). [V]
- **Oracle:** [GET_api__version_analytics_categories__slug.json](../oracle/http/GET_api__version_analytics_categories__slug.json): `default` → 200, `unknown_slug` → 404. [V]
- **Specs:** `spec/requests/api/v1/analytics_spec.rb:44-75`. [V]

<a id="route-get-api-v1-analytics-merchants-slug"></a>
##### GET /api/v1/analytics/merchants/:slug

- **Source:** `lib/api/resources/analytics/merchants.rb:10-53`. Service: `Analytics::SpendBreakdown.merchant_monthly_trend`.
- **Params:** `slug` (path), `from`, `to`, `currency`, `account_ids`, `page`, `limit` (pagination of `transactions`).
- **Behaviour** [I]: merchant by slug (404 otherwise); `total_cents`/`count` = spend rows of that merchant in the filter
  scope; `transactions` = those rows as LedgerEntry, newest booking date first, paginated (B.1.4); `monthly_trend` =
  always the last 12 calendar months ending today (independent of `from`/`to`), zero-filled, `period` = month start date.
- **Success:** 200 `{"merchant":{"id":1,"name":"Biedronka","slug":"biedronka","default_category_id":12},"currency":"PLN","period":{"from":"2026-07-13","to":"2026-10-21"},"total_cents":9995,"count":5,"monthly_trend":[{"period":"2025-11-01","amount_cents":0}],"transactions":[{…LedgerEntry…}],"pagination":{"page":1,"limit":10,"count":5,"pages":1}}` (arrays shortened). [V]
- **Errors:** 404 (unknown/foreign slug). [V]
- **Oracle:** [GET_api__version_analytics_merchants__slug.json](../oracle/http/GET_api__version_analytics_merchants__slug.json): `default` → 200, `unknown_slug` → 404. [V]
- **Specs:** `spec/requests/api/v1/analytics_spec.rb:77-115`. [V]

---

### B.3 OpenAPI documentation

<a id="route-get-api-v1-swagger-doc"></a>
#### GET /api/v1/swagger_doc

- **Source:** `lib/api/api.rb:60-70` (`add_swagger_documentation`, grape-swagger 2.1.4).
- **Auth:** none (public). [V] oracle actor `anon` → 200.
- **Response:** 200 Swagger **2.0** JSON generated from the Grape route/param/entity declarations: `info.title`
  `"Open Banking Rails API"`, `info.description` `"Personal-finance JSON API. All endpoints require a Personal Access Token in the Authorization header."`,
  `info.version` observed **`"0.0.1"`** (the configured `"1.0.0"` is not applied, see U-608), `produces ["application/json"]`,
  `host` = request host, `basePath "/"`, one tag per resource ("Operations about <resource>"), `paths` keyed like
  `/api/v1/merchants/{id}`, `operationId` like `getApiV1MerchantsId`, `definitions` from entities. The documentation
  path itself is hidden. [V] [oracle](../oracle/http/GET_api__version_swagger_doc.json) `default` → 200; `spec/requests/api/v1/cross_cutting_spec.rb:68-75`.
- **Kotlin note:** an equivalent OpenAPI document must be produced; byte-identity is not required. [I]

<a id="route-get-api-v1-swagger-doc-name"></a>
#### GET /api/v1/swagger_doc/:name

- **Source:** same (grape-swagger per-resource document).
- **Behaviour:** document restricted to one top-level resource name (e.g. `merchants`). Unknown name → **400**
  `{"error":"named resource not exist"}` (note the `error` key, not `message`). [V]
- **Oracle:** [GET_api__version_swagger_doc__name.json](../oracle/http/GET_api__version_swagger_doc__name.json): `default` → 200, `unknown_name` → 400. [V]

<a id="route-get-api-version-docs"></a>
#### GET /api/:version/docs (Swagger UI page)

- **Source:** route `config/routes.rb:27` (`constraints: { version: /v\d+/ }`, name `api_docs`); `app/controllers/swagger_controller.rb:1-9`; view `app/views/swagger/index.html.erb`.
- **Auth:** **admin session** (Devise `authenticate_user!`), not PAT. Anonymous → 302 to `/admin/sign_in`. [V]
- **Behaviour:** renders a standalone HTML page (no layout), title "Open Banking Rails API", loading
  `swagger-ui-dist@5` CSS/JS from `https://unpkg.com` and pointing Swagger UI at `/api/<version>/swagger_doc`
  (`deepLinking: true`, `BaseLayout`). Any `v<digits>` matches the route (e.g. `v9`), but only `v1` has a document. [I]
  Linked from the API-tokens settings page (`app/views/admin/settings/api_tokens/index.html.erb:13`). README: "Swagger docs live at `/api/v1/docs`" (`README.md:209`).
- **Oracle:** [GET_api__version_docs.json](../oracle/http/GET_api__version_docs.json): `default` → 302, `unknown_version` → 302 (both anonymous). The signed-in render was not captured. [V]/[I]

---

### B.4 MCP server (`/mcp`)

<a id="route-post-mcp"></a>
#### B.4.1 Transport, routing, auth (POST /mcp)

Routes `POST /mcp`, `GET /mcp`, `DELETE /mcp` all map to `McpController#handle` (`config/routes.rb:29`,
`app/controllers/mcp_controller.rb:6-15`). README: "The MCP endpoint plugs into Claude Desktop and any other MCP client" (`README.md:209-211`).

- **Auth** (`app/controllers/mcp_controller.rb:19-26`): same PAT rules as the API (B.1.2, same authenticator, updates
  `last_used_at`). Failure → **401** with a **different body** from the API:
  ```json
  {"error": "Invalid or missing access token."}
  ```
  (`content-type: application/json; charset=utf-8`). [V] [oracle](../oracle/http/POST_mcp.json) cases `no_token`, `revoked_token` → 401;
  `spec/requests/mcp/protocol_spec.rb:6-28`. Auth is checked before the HTTP method/body is examined. [I]
- **Transport:** MCP Ruby SDK `mcp` 0.15.0, `StreamableHTTPTransport` with `stateless: true`,
  `enable_json_response: true`. A **new server instance is built per request** (`Mcp::ServerBuilder.call(user:)`,
  `lib/mcp/server_builder.rb:11-18`) with `server_context = {current_user: <user>}`; no session state, no
  `Mcp-Session-Id` handling, no SSE. [I]
- **POST /mcp:** JSON-RPC 2.0 request in the body; response is a single JSON object (`content-type: application/json`)
  with HTTP 200 for both results and JSON-RPC errors. [V] Requirements enforced by the transport [I] (gem
  `streamable_http_transport.rb`): `Accept` must include `application/json` (or `*/*`) else 406
  `{"error":"Not Acceptable: Accept header must include application/json"}`; `Content-Type` must be
  `application/json` else 415 `{"error":"Unsupported Media Type: Content-Type must be application/json"}`;
  notifications (no `id`) return 202 with no body.
- **Malformed JSON body** (`{not json`) → **500**, HTML exception page "NoMethodError in McpController#handle"
  (`undefined method 'each' for nil` at `app/controllers/mcp_controller.rb:12`) — the SDK's own 400 `{"error":"Invalid JSON"}` is not reached/returned (BUG?, see U-602). [V]
  [oracle](../oracle/http/POST_mcp.json) case `malformed_json` → 500; `oracle/server.log.txt:1151`.
- **Oracle** [POST_mcp.json](../oracle/http/POST_mcp.json): `no_token` → 401, `revoked_token` → 401, `initialize` → 200,
  `tools_list` → 200, `resources_list` → 200, `unknown_method` → 200, `malformed_json` → 500, and one case
  `tools_call:<tool name>` → 200 for each of the 27 tools, plus `tools_call:transactions.get:other_tenant`,
  `tools_call:analytics.cash_flow:invalid_enum`, `tools_call:categories.create:invalid`,
  `tools_call:cash.create_transaction:invalid_amount` → 200 (tool errors are HTTP 200). [V]
- Response headers on MCP responses include `x-frame-options: SAMEORIGIN`, `x-content-type-options: nosniff`, plus CORS (B.1.7). [V]

<a id="route-get-mcp"></a>
#### B.4.1a GET /mcp

- **405** `{"error":"Method not allowed"}` (stateless mode has no SSE stream). [V]
  [oracle](../oracle/http/GET_mcp.json) `default` → 405; `spec/requests/mcp/protocol_spec.rb:83-90`.

<a id="route-delete-mcp"></a>
#### B.4.1b DELETE /mcp

- **200** `{"success":true}` (no session to terminate). [V]
  [oracle](../oracle/http/DELETE_mcp.json) `default` → 200; `spec/requests/mcp/protocol_spec.rb:92-99`.

#### B.4.2 JSON-RPC methods

| Method | Behaviour | Evidence |
|---|---|---|
| `initialize` | Result `{"protocolVersion": <negotiated>, "capabilities": {"tools":{"listChanged":true},"prompts":{"listChanged":true},"resources":{"listChanged":true},"logging":{}}, "serverInfo": {"name":"open-banking-rails","version":"1.0.0"}}`. Negotiation: client version echoed if in `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, else `2025-11-25`. No `instructions`. | [V] case `initialize` (client `2025-06-18` → `2025-06-18`); negotiation [I] gem `server.rb:510-514`, `configuration.rb:5-7` |
| `tools/list` | `{"tools":[…27 tools…]}` each `{name, description, inputSchema}`; `inputSchema` = declared schema with `"type":"object"` added. Order = registration order in `lib/mcp/server_builder.rb:22-52`. Full list: `oracle/mcp_tools_list.json`. | [V] case `tools_list`; `spec/requests/mcp/protocol_spec.rb:30-40` (27 tools) |
| `tools/call` | `params {name, arguments}` → `{"content":[{"type":"text","text":…}],"isError":false|true}` (B.4.3) | [V] cases `tools_call:*` |
| `resources/list` | `{"resources":[]}` (no resources registered; `lib/mcp/application_resource.rb` is an empty base class) | [V] case `resources_list` |
| `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`, `ping`, `completion/complete`, `logging/setLevel`, subscribe/unsubscribe | SDK defaults: empty lists / empty results; no prompts are registered | [I] gem `server.rb:119-134` |
| unknown method | JSON-RPC error `{"code":-32601,"message":"Method not found","data":"<method>"}` with HTTP 200 | [V] case `unknown_method` |
| `tools/call` unknown tool | JSON-RPC error (invalid params, "Tool not found: <name>") with HTTP 200 | [V] `spec/requests/mcp/protocol_spec.rb:73-81` (error or isError); exact code [I] gem `server.rb:564` |

#### B.4.3 Tool call result and error conventions

- Success: one text content block. "JSON" tools put a JSON-serialised object in `text`
  (`lib/mcp/application_tool.rb:14-16`); "text" tools return a plain sentence (`:10-12`). `isError: false`. [V]
- Tool-level error: `{"content":[{"type":"text","text":"Error: <message>"}],"isError":true}` (`lib/mcp/application_tool.rb:18-20`);
  service failures use `result.error` (messages joined with `", "`) (`:22-28`). HTTP status stays 200. [V] e.g. case
  `tools_call:transactions.get:other_tenant` → `"Error: Transaction not found."`; `spec/requests/mcp/protocol_spec.rb:61-71`.
- Argument validation by the SDK before the tool runs (`isError: true`, **no** `"Error: "` prefix) [V/I]:
  - missing required → `"Missing required arguments: <names>"` [I] (gem `server.rb:570-575`);
  - schema violation → `"Invalid arguments: The property '#/bucket' value \"year\" did not match one of the following values: day, week, month in schema <uuid>"` [V] case `tools_call:analytics.cash_flow:invalid_enum`.
- Unexpected exceptions inside a tool (e.g. unknown argument keys passed to a Struct/model) become a JSON-RPC error
  "Internal error calling tool <name>: <message>" (internal error code) rather than an `isError` result (see U-614). [I] gem `server.rb:596-601`.
- Tenant isolation: every tool resolves records through the same user scopes as the API (B.1.3); foreign ids produce
  `"Error: <Thing> #<id> not found."` and never leak data. [V] `spec/requests/mcp/protocol_spec.rb:101-116`.
- Money in MCP outputs: `amount_cents` integer + `currency` ISO code (not the `{cents,currency}` object). Dates `YYYY-MM-DD`, timestamps ISO-8601 UTC. [V]
- The examples below are the decoded `text` of the oracle's `tools_call:<name>` cases in
  [POST_mcp.json](../oracle/http/POST_mcp.json) (all HTTP 200).

#### B.4.4 Tools

Input schemas below are exactly those published by `tools/list` (`oracle/mcp_tools_list.json`, `inventory/mcp_tools.json`). "Req" = in `required`.

<a id="mcp-cash-create-transaction"></a>
##### Tool `cash.create_transaction`

- **File:** `lib/mcp/tools/cash/create_transaction.rb:7-37`. **Description (verbatim):** "Record a manual cash transaction (income or expense) for the current user."
- **Input:** `amount` string **Req** ("Decimal amount, e.g. '12.50'"); `currency` string ("ISO-4217, defaults to PLN"); `direction` enum `debit|credit` ("Defaults to debit (expense)"); `booking_date` string/date; `transaction_date` string/date; `title`, `note`, `counterparty_name` strings; `merchant_id`, `category_id` integers; `payment_method` string ("cash / card / blik_p2p / transfer / other").
- **Behaviour:** same service and rules as `POST /api/v1/cash_transactions` (`Cash::TransactionCreator`, BR-300..399). Dates are strings parsed by the service; an unparsable date silently becomes today / null (no 400 equivalent). [I] [V] service wiring `spec/requests/mcp/tools_spec.rb:6-23`.
- **Output:** `{"id","amount_cents","currency","direction","booking_date","title"}`. Example: `{"id":25,"amount_cents":1234,"currency":"PLN","direction":"debit","booking_date":"2026-10-21","title":"MCP oracle cash"}`. [V]
- **Errors:** `"Error: Amount cents is not a number, Amount is not a number, Amount cents can't be blank"` (amount `"abc"`). [V] case `tools_call:cash.create_transaction:invalid_amount`; `spec/requests/mcp/protocol_spec.rb:42-71`.

<a id="mcp-cash-update-transaction"></a>
##### Tool `cash.update_transaction`

- **File:** `lib/mcp/tools/cash/update_transaction.rb:7-41`. **Description:** "Update fields on an existing manual cash transaction. Currency is locked - delete and recreate to change it."
- **Input:** `id` integer **Req**; `amount` string ("Decimal, e.g. '12.50'. Omit to keep"); `direction` enum `debit|credit`; `booking_date`, `transaction_date` date strings; `title`, `note`, `counterparty_name` strings ("Empty string clears"); `merchant_id`, `category_id` integers; `payment_method` string.
- **Behaviour:** finds the user's manual transaction; non-`manual` source → `"Error: This transaction was auto-generated and isn't editable."`; unknown → `"Error: Manual transaction #<id> not found."`; else `Cash::TransactionUpdater`. [I]
- **Output:** same shape as create. Example: `{"id":25,"amount_cents":1234,"currency":"PLN","direction":"debit","booking_date":"2026-10-21","title":"MCP oracle cash (edited)"}`. [V]

<a id="mcp-cash-delete-transaction"></a>
##### Tool `cash.delete_transaction`

- **File:** `lib/mcp/tools/cash/delete_transaction.rb:7-23`. **Description:** "Delete a manual cash transaction. Auto-generated rows (e.g. ATM linker) cannot be deleted here."
- **Input:** `id` integer **Req**.
- **Behaviour:** not found → `"Error: Manual transaction #<id> not found."`; non-manual → `"Error: This transaction was auto-generated and isn't deletable."`; else hard delete. [I]
- **Output (text):** `"Deleted manual transaction #25."` [V]

<a id="mcp-transactions-list"></a>
##### Tool `transactions.list`

- **File:** `lib/mcp/tools/transactions/list.rb:7-57`. **Description:** "List ledger entries (bank + manual) with filters. Returns at most `limit` rows (default 25, max 200)."
- **Input:** `from`, `to` date ("Booking date >=" / "Booking date <="); `direction` enum `credit|debit`; `status` enum `booked|pending`; `account_id`, `merchant_id`, `category_id` integers; `category_path` string ("ltree prefix; matches descendants"); `payment_method`, `currency` strings; `source_type` enum `BankTransaction|ManualTransaction`; `limit` integer ("1-200, default 25").
- **Behaviour:** same filters/ordering as `GET /api/v1/transactions`, no pagination. Limit computed as
  `min(max(limit.to_i, 1), 200)`, then "25 if zero" — the zero check can never fire, so **omitting `limit` returns 1 row** (BUG?, see U-600). [V] case `tools_call:transactions.list` (no args) → `count: 1`; SQL `LIMIT 1` at `oracle/server.log.txt` (mcp handle).
- **Output:** `{"count": n, "transactions": [{source_type, source_id, booking_date, direction, amount_cents, currency, title, counterparty_name, merchant_id, category_path, payment_method}]}`. Example: `{"count":1,"transactions":[{"source_type":"BankTransaction","source_id":54,"booking_date":"2026-10-11","direction":"debit","amount_cents":500,"currency":"EUR","title":"OpenAI","counterparty_name":"Openai LLC","merchant_id":null,"category_path":"","payment_method":"card"}]}`. [V]
- **Specs:** `spec/requests/mcp/tools_spec.rb:25-41`. [V]

<a id="mcp-transactions-get"></a>
##### Tool `transactions.get`

- **File:** `lib/mcp/tools/transactions/get.rb:7-37`. **Description:** "Fetch a single ledger entry by source type + id."
- **Input:** `source_type` enum `BankTransaction|ManualTransaction` **Req**; `source_id` integer **Req**.
- **Output:** `{source_type, source_id, booking_date, transaction_date, direction, status, amount_cents, currency, title, counterparty_name, counterparty_kind, payment_method, merchant_id, effective_category_id, category_path, essential, enrichment_source}`. Example: `{"source_type":"BankTransaction","source_id":1,"booking_date":"2026-08-02","transaction_date":"2026-08-02","direction":"debit","status":"booked","amount_cents":1999,"currency":"PLN","title":"BIEDRONKA WARSZAWA","counterparty_name":null,"counterparty_kind":"unknown","payment_method":"card","merchant_id":null,"effective_category_id":null,"category_path":"","essential":false,"enrichment_source":null}`. [V]
- **Errors:** `"Error: Transaction not found."` (unknown or foreign). [V] case `tools_call:transactions.get:other_tenant`; `spec/requests/mcp/protocol_spec.rb:101-116`.

<a id="mcp-transactions-classify"></a>
##### Tool `transactions.classify`

- **File:** `lib/mcp/tools/transactions/classify.rb:7-48`. **Description (verbatim, 4 lines):**
  "Apply a merchant + category to a bank transaction.
  mode=only_this writes the override on this row only.
  mode=all_for_merchant sets merchant.default_category - all rows for the merchant inherit.
  mode=create_rule creates a user-source MerchantRule (rule_field/rule_kind/rule_pattern required) and rebuilds enrichment."
- **Input:** `bank_transaction_id` integer **Req**; `mode` enum `only_this|all_for_merchant|create_rule` **Req**; `merchant_id`, `category_id` integers; `rule_field` enum `title|counterparty_name|counterparty_iban`; `rule_kind` enum `contains|equals|regex|starts_with|ends_with`; `rule_pattern` string.
- **Behaviour:** as `POST /api/v1/bank_transactions/:id/classification` (`Enrichment::ClassificationApplier`, BR-200..299). Unknown/foreign transaction → `"Error: Bank transaction #<id> not found."`. [I]
- **Output (text):** the applier's message, e.g. `"Applied: this transaction only"`; failures `"Error: Pick a merchant"` / `"Error: Pick a pattern"`. [V] (success) / [I] (errors)

<a id="mcp-categories-list"></a>
##### Tool `categories.list`

- **File:** `lib/mcp/tools/categories/list.rb:7-25`. **Description:** "List the user's categories. Hierarchy is encoded in `path` (ltree dot-separated)."
- **Input:** `include_archived` boolean ("Default false").
- **Output:** `{"count": n, "categories": [{id, name, slug, path, kind, essential, archived_at}]}` ordered by path; all rows (no limit). Example: `{"count":118,"categories":[{"id":6,"name":"Edukacja","slug":"education","path":"education","kind":"expense","essential":false,"archived_at":null}, …]}`. [V]

<a id="mcp-categories-create"></a>
##### Tool `categories.create`

- **File:** `lib/mcp/tools/categories/create.rb:7-36`. **Description:** "Create a new category. parent_path is the ltree path of the parent ('food.cooking' etc.); omit for top-level."
- **Input:** `name` string **Req**; `slug` string ("Auto-generated when omitted"); `kind` enum `expense|income|transfer|savings|ignored`; `color`, `icon` strings; `position` integer; `essential` boolean; `parent_path` string.
- **Behaviour:** `Categories::Creator` as the API (kind defaults to the model default — `expense` observed). [V]
- **Output:** `{id, name, slug, path, kind}`. Example: `{"id":237,"name":"Oracle MCP Category","slug":"oracle_mcp_category","path":"oracle_mcp_category","kind":"expense"}`. [V]
- **Errors:** name `""` → `"Error: Name can't be blank, Slug can't be blank, Slug must be lowercase letters, digits, underscores, dashes, Path can't be blank, Path must be lowercase letters, digits, underscores, dot-separated"`. [V] case `tools_call:categories.create:invalid`; `spec/requests/mcp/tools_spec.rb:43-60`.

<a id="mcp-categories-update"></a>
##### Tool `categories.update`

- **File:** `lib/mcp/tools/categories/update.rb:7-39`. **Description:** "Update / move a category. Changing parent_path rewrites paths of all descendants atomically."
- **Input:** `id` integer **Req**; `name`, `slug` strings; `kind` enum; `color`, `icon`; `position` integer; `essential` boolean; `parent_path` string.
- **Behaviour:** `Categories::Mover` (as API PATCH); unknown → `"Error: Category #<id> not found."`. [I]
- **Output:** `{id, name, path}`. Example: `{"id":237,"name":"Oracle MCP Category 2","path":"oracle_mcp_category"}`. [V]

<a id="mcp-categories-archive"></a>
##### Tool `categories.archive`

- **File:** `lib/mcp/tools/categories/archive.rb:7-19`. **Description:** "Archive a category - kept in storage but hidden from active lists."
- **Input:** `id` integer **Req**. Unknown → `"Error: Category #<id> not found."`. [I]
- **Output (text):** `"Archived category 'Oracle MCP Category 2'."` [V]

<a id="mcp-categories-unarchive"></a>
##### Tool `categories.unarchive`

- **File:** `lib/mcp/tools/categories/unarchive.rb:7-19`. **Description:** "Restore a previously archived category."
- **Input:** `id` integer **Req**.
- **Output (text):** `"Restored category 'Oracle MCP Category 2'."` [V]

<a id="mcp-merchants-list"></a>
##### Tool `merchants.list`

- **File:** `lib/mcp/tools/merchants/list.rb:7-38`. **Description:** "List the user's merchants. Default: active only, name ASC, max 100 rows."
- **Input:** `q` string ("Name ILIKE %q%"); `source` enum `user|llm|seed|system`; `category_id` integer; `include_archived` boolean; `limit` integer ("1-200, default 50").
- **Behaviour:** filters as the API. Same limit defect as `transactions.list`: omitted `limit` → 1 row (description also claims "max 100", code max is 200) (BUG?, see U-601). [V] case `tools_call:merchants.list` → `count: 1`.
- **Output:** `{"count": n, "merchants": [{id, name, slug, kind, source, default_category_id, default_category_path, archived_at, approved_at}]}`. Example: `{"count":1,"merchants":[{"id":12,"name":"4F (OTCF)","slug":"otcf_4f","kind":"company","source":"system","default_category_id":58,"default_category_path":"lifestyle.shopping.clothing","archived_at":null,"approved_at":"2026-10-21T12:49:14.412Z"}]}`. [V]

<a id="mcp-merchants-create"></a>
##### Tool `merchants.create`

- **File:** `lib/mcp/tools/merchants/create.rb:7-29`. **Description:** "Create a user-source merchant. Slug auto-generated when omitted."
- **Input:** `name` string **Req**; `slug`; `kind` enum `company|person|unknown`; `default_category_id` integer; `logo_url`; `notes`.
- **Behaviour:** `Merchants::Creator` (as API; `default_category_id` unscoped, see U-604). [I]
- **Output:** `{id, name, slug, default_category_id}`. Example: `{"id":57,"name":"Oracle MCP Merchant","slug":"oracle_mcp_merchant","default_category_id":null}`. [V]

<a id="mcp-merchants-update"></a>
##### Tool `merchants.update`

- **File:** `lib/mcp/tools/merchants/update.rb:7-33`. **Description:** "Update editable fields of a merchant."
- **Input:** `id` integer **Req**; `name`, `slug`, `kind` enum, `default_category_id`, `logo_url`, `notes`.
- **Behaviour:** direct update; validation failure → `"Error: <full messages joined>"`; unknown → `"Error: Merchant #<id> not found."`. [I]
- **Output:** `{id, name, default_category_id}`. Example: `{"id":57,"name":"Oracle MCP Merchant","default_category_id":null}`. [V]

<a id="mcp-merchants-archive"></a>
##### Tool `merchants.archive`

- **File:** `lib/mcp/tools/merchants/archive.rb:7-19`. **Description:** "Archive a merchant - keeps history visible, hides from active selectors."
- **Input:** `id` integer **Req**. **Output (text):** `"Archived merchant 'Oracle MCP Merchant'."` [V]

<a id="mcp-merchants-unarchive"></a>
##### Tool `merchants.unarchive`

- **File:** `lib/mcp/tools/merchants/unarchive.rb:7-19`. **Description:** "Restore a previously archived merchant."
- **Input:** `id` integer **Req**. **Output (text):** `"Restored merchant 'Oracle MCP Merchant'."` [V]

<a id="mcp-merchants-approve"></a>
##### Tool `merchants.approve`

- **File:** `lib/mcp/tools/merchants/approve.rb:7-19`. **Description:** "Approve an LLM-suggested merchant. Enables its disabled rules and rebuilds enrichment for the user."
- **Input:** `id` integer **Req**.
- **Behaviour:** `Merchants::Approver` (as API approve, BR-200..299). Unknown → `"Error: Merchant #<id> not found."`. [V] (`spec/requests/mcp/tools_spec.rb:62-84`)
- **Output (text):** `"Approved 'Oracle MCP Merchant' and re-classified historical transactions."` [V]

<a id="mcp-bank-accounts-list"></a>
##### Tool `bank_accounts.list`

- **File:** `lib/mcp/tools/bank_accounts/list.rb:7-39`. **Description:** "List the user's bank accounts (synced from AISP) and cash wallets (manual=true)."
- **Input:** `manual` boolean ("true → only cash wallets, false → only synced. Omit for both.").
- **Output:** `{"count": n, "accounts": [{id, name, iban, currency, status, manual, product, balances_synced_at, transactions_synced_at, balances: [{name, type, amount_cents, currency, reference_date}]}]}` (no `last_change_at`, no `uid`/`bban`). Example first item: `{"id":1,"name":"MACIEJ TEST","iban":"PL61109010140000071219812874","currency":"PLN","status":"active","manual":false,"product":"Konto Osobiste","balances_synced_at":null,"transactions_synced_at":"2026-10-21T12:49:35.788Z","balances":[]}` (count 5). [V]

<a id="mcp-bank-accounts-refresh-details"></a>
##### Tool `bank_accounts.refresh_details`

- **File:** `lib/mcp/tools/bank_accounts/refresh_details.rb:7-21`. **Description:** "Pull fresh account-info from the AISP provider (name, holder, product). Live API call."
- **Input:** `id` integer **Req**.
- **Behaviour:** `EnableBanking::Operations::RefreshAccountDetails`; unknown → `"Error: Bank account #<id> not found."`; provider failure → `"Error: Refresh failed: <message>"`. [I]
- **Output (text):** `"Account details refreshed for #1."` [V]

<a id="mcp-bank-accounts-refresh-balances"></a>
##### Tool `bank_accounts.refresh_balances`

- **File:** `lib/mcp/tools/bank_accounts/refresh_balances.rb:7-21`. **Description:** "Pull fresh balances from the AISP provider. Live API call."
- **Input:** `id` integer **Req**. Errors as refresh_details. [I]
- **Output (text):** `"Balances refreshed for #1."` [V] (`spec/requests/mcp/tools_spec.rb:86-97`)

<a id="mcp-bank-connections-list"></a>
##### Tool `bank_connections.list`

- **File:** `lib/mcp/tools/bank_connections/list.rb:7-24`. **Description:** "List the user's bank connections with status + validity."
- **Input:** `status` string.
- **Output:** `{"count": n, "connections": [{id, bank_name, bank_country, status, authorized_at, valid_until, last_synced_at, last_error}]}` ordered by `valid_until` asc. Example first item: `{"id":1,"bank_name":"PKO BP","bank_country":"PL","status":"authorized","authorized_at":"2026-10-21T12:49:32.000Z","valid_until":"2026-11-20T13:49:32.000Z","last_synced_at":"2026-10-21T12:49:35.853Z","last_error":null}`. [V]

<a id="mcp-bank-connections-refresh"></a>
##### Tool `bank_connections.refresh`

- **File:** `lib/mcp/tools/bank_connections/refresh.rb:7-21`. **Description:** "Pull current status + validity for a bank connection from the provider."
- **Input:** `id` integer **Req**.
- **Behaviour:** `EnableBanking::Operations::RefreshConnection`; unknown → `"Error: Bank connection #<id> not found."`; failure → `"Error: Refresh failed: <message>"`. [I]
- **Output (text):** `"Refreshed: status=<status>, valid_until=<YYYY-MM-DD or empty>."`, e.g. `"Refreshed: status=authorized, valid_until=2026-11-20."` [V] (`spec/requests/mcp/tools_spec.rb:99-110`)

<a id="mcp-analytics-cash-flow"></a>
##### Tool `analytics.cash_flow`

- **File:** `lib/mcp/tools/analytics/cash_flow.rb:7-36`. **Description:** "Spend + income totals and a date-bucketed series for the requested period. Defaults to month-to-date."
- **Input:** `from`, `to` date strings; `bucket` enum `day|week|month`; `currency` string; `account_ids` array of integer; `under_path` string ("ltree prefix").
- **Behaviour:** same `Analytics::Filter` and `Analytics::CashFlow` as the API. Differences: invalid date strings fall back to today (no error) (`filter.rb:202-206`); `from > to` raises inside the tool → JSON-RPC internal error (see U-603). [I]
- **Output:** `{"currency","period":{"from","to","bucket"},"totals":{"spend_cents","income_cents","net_cents"},"series":[{"date","spend_cents","income_cents","net_cents"}]}`. Example: `{"currency":"PLN","period":{"from":"2026-10-01","to":"2026-10-21","bucket":"day"},"totals":{"spend_cents":0,"income_cents":0,"net_cents":0},"series":[{"date":"2026-10-01","spend_cents":0,"income_cents":0,"net_cents":0}, …]}`. [V] (`spec/requests/mcp/tools_spec.rb:112-121`)
- **Errors:** invalid enum → `"Invalid arguments: …"` (isError). [V]

<a id="mcp-analytics-spend"></a>
##### Tool `analytics.spend`

- **File:** `lib/mcp/tools/analytics/spend.rb:7-42`. **Description:** "Spend breakdown by category path with previous-period delta. depth=1 → top-level, depth=2 → mid-level, omit for leaf rows."
- **Input:** `from`, `to`, `currency`, `account_ids`, `under_path`, `depth` integer. (No `bucket` in the schema.)
- **Output:** `{"currency","period":{"from","to"},"total_cents","rows":[{path, name, amount_cents, prev_amount_cents, count, delta_pct}]}` — unlike the API: no `bucket` in `period`, no `slug` in rows. Example: `{"currency":"PLN","period":{"from":"2026-10-01","to":"2026-10-21"},"total_cents":0,"rows":[]}`. [V]

<a id="mcp-analytics-top-merchants"></a>
##### Tool `analytics.top_merchants`

- **File:** `lib/mcp/tools/analytics/top_merchants.rb:7-36`. **Description:** "Top spend merchants for the period."
- **Input:** `from`, `to`, `currency`, `account_ids`, `under_path`, `limit` integer ("Default 10, max 50").
- **Behaviour:** limit = `min(max((limit or 10), 1), 50)` (correctly defaults to 10 here). [I]
- **Output:** `{"currency","period":{"from","to"},"rows":[{merchant_id, merchant_name, merchant_slug, amount_cents, count}]}` (flat, unlike the API's nested `merchant`). Example: `{"currency":"PLN","period":{"from":"2026-10-01","to":"2026-10-21"},"rows":[]}`. [V]

<a id="mcp-transaction-syncs-create"></a>
##### Tool `transaction_syncs.create`

- **File:** `lib/mcp/tools/operations/queue_transaction_sync.rb:7-27`. **Description:** "Queue a background transaction sync. Subject = a single bank connection (when bank_connection_id is given) or all of the user's active connections."
- **Input:** `bank_connection_id` integer; `date_from`, `date_to` date strings.
- **Behaviour:** `TransactionSyncs::Queuer` (as API; same silent widening, see U-605). [V] (`spec/requests/mcp/tools_spec.rb:123-138`)
- **Output:** `{run_id, status, subject_type, subject_id}`. Example: `{"run_id":5,"status":"queued","subject_type":"BankConnection","subject_id":1}`. [V]

<a id="mcp-llm-enrichments-create"></a>
##### Tool `llm_enrichments.create`

- **File:** `lib/mcp/tools/operations/queue_llm_enrichment.rb:7-23`. **Description:** "Queue an LLM enrichment run. The user must have an LLM provider configured in Preferences."
- **Input:** `limit` integer ("Max distinct title groups to send to the LLM").
- **Behaviour:** `LlmEnrichments::Queuer` (as API). Not configured → `"Error: Configure an LLM provider in Preferences before running enrichment."`. [I]
- **Output:** `{run_id, status}`. Example: `{"run_id":6,"status":"queued"}`. [V]
