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
