# 80 — Test suite, coverage maps and Kotlin parity test strategy

> Scope: the RSpec suite of open-banking-rails at commit `cd3bf6054b54e7eb84fd4405919c70e41dfa2794` (`../inventory/SOURCE.txt`), what it
> proves, how it maps onto the business rules ([20](20-business-rules.md)), routes ([30](30-http-api.md)) and pages ([40](40-ui.md)),
> where the gaps are, and how the Kotlin rebuild should reuse the suite and the runtime oracle.
> Certainty marks: **[V]** = taken from the real run (`../inventory/specs_run.json`, `../inventory/coverage_by_file.json`,
> `src/coverage/.resultset.json`) or from a spec source file that passed in that run; **[I]** = inferred from reading code or from a
> static match (not executed as such).
> All tables in sections 2–6 were computed with `python3 -I` scripts over `../inventory/specs.json` (dry run, 825 examples), the
> "Covered by" lines of [20-business-rules.md](20-business-rules.md), `../inventory/coverage_keys.json`,
> `../inventory/routes_development.txt` (Prefix column → route helper names) and the spec sources under `src/spec/**`.

## Summary

| Measure | Value | Evidence |
|---|---|---|
| Examples (dry run = real run) | 825 in 99 spec files (12 of them instantiated from the 2 shared-example groups in `spec/support/**`) | `../inventory/specs.json`, `../inventory/specs_run.json` **[V]** |
| Result of the real run | **825 examples, 0 failures, 0 pending**, 1185.5 s (≈ 19.8 min), random seed 4274, RSpec 3.13.6 | `../inventory/specs_run.json` `summary` **[V]** |
| Second real run (2026-10-22, Docker `postgres:17` + `redis:7`) | **825 examples, 0 failures, 0 pending**, 650.0 s, random seed 47797, line coverage 92.05 %; same 825 example ids and descriptions as the dry run | `../inventory/specs_run_docker.json` **[V]** |
| First run without CSS build | 825 examples, **174 failures**, all `The asset 'tailwind.css' was not found in the load path.` (environmental) | `../inventory/specs_run_without_tailwind_build.json` **[V]** |
| Line coverage (SimpleCov) | **92.05 %** = 5023/5457 = 92.047% over 212 files (SimpleCov's own `coverage/.last_run.json` reports `92.04`) | `../inventory/coverage_by_file.json`, `../inventory/coverage_last_run.json` **[V]** |
| Business rules with ≥ 1 spec | 190 of 225 covered, 4 partial, **31 untested** | section 3 **[V]** (inverted "Covered by" lines) |
| Spec examples cited by ≥ 1 rule | 685 of 825 (798 references, all resolved to an example id) | section 2 **[V]** |
| Routes (204 keys) | 148 exercised by a request/system spec, 1 indirect, 6 PUT aliases of a tested PATCH, **16 in-scope gaps**, 33 out of scope (D-006) | section 4 **[V]/[I]** |
| MCP tools (27) | 9 invoked through `tools/call` in a spec, **18 never invoked** (all 27 exercised by the oracle) | section 4.2 **[V]** |
| Pages (48 view templates) | 37 rendered by a request/system spec, 6 only by the smoke crawler, **2 not rendered**, 1 out of scope, 2 not routed | section 5 **[V]/[I]** |
| Files below 80 % line coverage | 27 | section 6 **[V]** |

---

## 1. Suite overview

### 1.1 Philosophy (from `spec/AGENTS.md`)

The suite follows the repo's own testing guide `spec/AGENTS.md` (950 lines) **[V]** (file read):

- Eight non-negotiables (`spec/AGENTS.md:21-49`): test units behind facades, not classes; use the in-memory fakes (`fake_eb`, `fake_llm`)
  and reserve WebMock for one wire-format spec per adapter; build state through production services (`Seeders::Showcase`,
  `Seeders::Categories`, `Cash::TransactionCreator`, `EnableBanking::Operations::*`); request specs test five things (status,
  redirect/render target, flash, cross-user 404, the right service was called); system specs tell multi-step stories ending with
  `SystemInvariants`; flat structure (one `RSpec.describe` per file, bare `it`, no `context`/nested `describe`); services return a
  `Result` (`success?`, `error_messages`); system tests must survive refactoring.
- Flat structure is enforced by convention (`spec/AGENTS.md:116-148`); a grep for nested `context`/`describe` in `*_spec.rb` finds no
  nesting (only two local variables named `context` in `spec/services/llm/clients/openai_spec.rb:20,43`) **[V]**.
  Consequence used below: every example id is `[1:N]` (N-th child of the single top-level group) or `[1:N:M]` for shared examples.
- Four system invariants (`spec/AGENTS.md:584-606`, implemented in `spec/support/system_invariants.rb:7,12,38,45`):
  `assert_no_running_operation_runs!`, `assert_ledger_sums_match!(user)`, `assert_user_isolation!(a, b)`,
  `assert_no_orphaned_enrichments!(user)`.
- Known deviations listed by the guide itself (`spec/AGENTS.md:839-916`): `truncate_db` duplicated in 16 system specs; some
  internal-class specs exist (`TransactionNormalizer`, `JwtSigner`, `PaymentMethodInferer`); domain specs use factory_bot instead of
  the showcase; `allow_any_instance_of(LlmSetting)` in `connection_test_runner_spec.rb`; `instance_exec(&build_record)` in the shared example.
- Statements in the guide that do **not** match the checkout **[V]**: "19 minimal factory_bot files" (`spec/AGENTS.md:59`) — there
  are 16; "14 user-journey specs" (`spec/AGENTS.md:86`) — there are 16 journeys + 2 smoke files; "Full suite — ~2.5 minutes"
  (`spec/AGENTS.md:789`) — the measured run took 1185.5 s; the smoke crawler "emits pending" (`spec/AGENTS.md:808-814`) — the run
  had 0 pending (every enumerated route resolved to a showcase id).

### 1.2 Layers and counts

Computed from `../inventory/specs.json` (examples from shared groups are counted in the host file that includes them) **[V]**:

| Layer | Spec files | Examples |
|---|---:|---:|
| model | 18 | 143 |
| service | 47 | 283 |
| request (admin/public) | 8 | 181 |
| request (API) | 5 | 83 |
| request (MCP) | 2 | 19 |
| system journey | 16 | 67 |
| system (smoke) | 2 | 48 |
| factory lint | 1 | 1 |
| **Total** | **99** | **825** |

Per directory **[V]**:

| Directory | Spec files | Examples |
|---|---:|---:|
| `spec/` | 1 | 1 |
| `spec/models/` | 17 | 135 |
| `spec/models/concerns/` | 1 | 8 |
| `spec/requests/` | 8 | 181 |
| `spec/requests/api/v1/` | 5 | 83 |
| `spec/requests/mcp/` | 2 | 19 |
| `spec/services/` | 2 | 15 |
| `spec/services/analytics/` | 4 | 18 |
| `spec/services/auth/` | 2 | 9 |
| `spec/services/auto_sync/` | 4 | 25 |
| `spec/services/cash/` | 4 | 25 |
| `spec/services/categories/` | 2 | 10 |
| `spec/services/data_exchange/` | 1 | 5 |
| `spec/services/enable_banking/` | 6 | 54 |
| `spec/services/enable_banking/api/` | 1 | 4 |
| `spec/services/enable_banking/operations/` | 8 | 36 |
| `spec/services/enrichment/` | 3 | 23 |
| `spec/services/llm/` | 1 | 14 |
| `spec/services/llm/clients/` | 1 | 2 |
| `spec/services/mcp/` | 2 | 20 |
| `spec/services/merchant_rules/` | 2 | 6 |
| `spec/services/merchants/` | 1 | 4 |
| `spec/services/seeders/` | 3 | 13 |
| `spec/system/` | 16 | 67 |
| `spec/system/smoke/` | 2 | 48 |

What each layer covers:

- **Models** (`spec/models/**`, one file per model + `concerns/ledger_entry_concern_spec.rb`): validations, scopes, enums, callbacks,
  encryption at rest (`expect_encrypted_at_rest`, `spec/support/encryption_helpers.rb:18-22`; used in
  `spec/models/bank_account_spec.rb:165`, `bank_connection_spec.rb:105`, `bank_transaction_spec.rb:109`, `llm_setting_spec.rb:67`,
  `tpp_credential_spec.rb:126`), and the `ledger_entries` view invariants (`spec/models/ledger_entry_spec.rb`, `spec/AGENTS.md:516-547`) **[V]**.
- **Services** (`spec/services/**`): domain units by facade — analytics, auth (PAT issuer/authenticator), auto-sync (dispatcher,
  circuit breaker, next-run calculator, schedule upserter), cash, categories, data exchange round trip, Enable Banking operations
  plus the single WebMock wire-format spec `spec/services/enable_banking/adapter_spec.rb`, enrichment, LLM, MCP base classes, merchant
  rules, merchants, seeders, `OperationRunFinalizer` **[V]**.
- **Requests**: eight admin/public files (`spec/requests/*.rb`), the Grape JSON API (`spec/requests/api/v1/*.rb`, Bearer PAT) and the
  MCP JSON-RPC endpoint (`spec/requests/mcp/protocol_spec.rb`, `tools_spec.rb`) **[V]**.
- **System journeys** (`spec/system/*.rb`, Capybara): 16 multi-step stories (setup, OAuth callback success/error, re-auth, manual sync,
  auto-sync tick and circuit breaker, cash + ATM link, categorisation, LLM enrichment, settings, data-exchange round trip, PAT
  lifecycle, cross-user isolation, daily analytics login) **[V]**.
- **Smoke** (`spec/system/smoke/`): `admin_spec.rb` enumerates every `GET /admin…` route of the test-env router (minus `/sidekiq`,
  `/debug`, sign-in/password pages, `/admin/versions*`, `/admin/llm_enrichments/:id`), substitutes ids from the showcase and accepts
  status 200, 301 or 302 (`spec/system/smoke/admin_spec.rb:49-76`) — 41 generated examples; `auth_spec.rb` has 7 unauthenticated /
  first-run checks **[V]**.
- **Factory lint**: `spec/factories_spec.rb:6-7` runs `FactoryBot.lint(traits: true)` **[V]**.

### 1.3 Test infrastructure

| Element | Behaviour | Evidence |
|---|---|---|
| FactoryBot factories (16 files) | `bank_accounts`, `bank_connections`, `bank_transactions`, `categories`, `llm_settings`, `manual_transactions`, `merchant_rules`, `merchants`, `operation_runs`, `personal_access_tokens`, `styleguide_demos`, `sync_schedules`, `tpp_credentials`, `transaction_enrichments`, `user_hidden_categories`, `users`; `FactoryBot::Syntax::Methods` included globally | `spec/factories/*.rb`; `spec/rails_helper.rb:38` **[V]** |
| `Fakes::EnableBankingClient` (358 lines) | In-memory Enable Banking: real adapter interface `get(path, params)` / `post(path, body)` / `delete(path)` returning `EnableBanking::Result` for `/application`, `/aspsps`, `/sessions/:id`, `/accounts/:uid/balances`, `/accounts/:uid/details`, `/accounts/:uid/transactions` (GET), `/auth`, `/sessions` (POST), `/sessions/:id` (DELETE); UI fakers `add_aspsp`, `add_session`, `add_account`, `add_transaction`, `set_balance`, `expire_session`, `revoke_session`; test helpers `simulate_failure`, `simulate_429`, `simulate_500`, `reset!`, `recorded_calls`; unknown resources → `Result(success: false, status: 404)` | `spec/support/fakes/enable_banking_client.rb:54-116,118-229,235-242`; `spec/AGENTS.md:416-468` **[V]** |
| `Fakes::LlmClient` (86 lines) | Real interface `structured(system_prompt:, user_prompt:, schema:)`; first canned response whose matcher (Regexp/substring/callable) matches `system_prompt + user_prompt` wins, else a schema-aware default; `respond_with`, `respond_with_schema`, `respond_for_merchant_suggester`, `set_failure` (raises `Llm::Client::Error`), `recorded_prompts`, `recorded_models` | `spec/support/fakes/llm_client.rb:9-53`; `spec/AGENTS.md:470-503` **[V]** |
| Fake injection | Before **every** example a fresh pair is created and `EnableBanking::Client.new` / `Llm::Client.for` are stubbed to return them (`allow(...).to receive`); exposed as `fake_eb` / `fake_llm`; reset after each example. The smoke crawler re-stubs them with the showcase fakes | `spec/support/fakes_helpers.rb:10-38` (stubs at `:31-32`); `spec/system/smoke/admin_spec.rb:17-21` **[V]** |
| WebMock policy | `WebMock.disable_net_connect!(allow_localhost: true)` for the whole suite; URL matchers `eb_url`, `gemini_url`, `openai_url`; `stub_request` is used only in `spec/services/enable_banking/adapter_spec.rb` (which calls the real client via `and_call_original`) | `spec/rails_helper.rb:7-8`; `spec/support/webmock_config.rb:7-22`; `spec/services/enable_banking/adapter_spec.rb:6-8` **[V]** |
| Sidekiq | `Sidekiq::Testing.fake!` globally, queues cleared before each example; tag `:sidekiq_inline` switches to inline for one example (used 3× in `spec/system/llm_enrichment_spec.rb`); helpers `with_inline_sidekiq`, `drain_all_jobs`, `clear_jobs!` (used by the auto-sync, manual-sync and first-time-setup journeys) | `spec/rails_helper.rb:13-14,51-61`; `spec/support/sidekiq_helpers.rb:4-22` **[V]** |
| PaperTrail | Disabled globally, enabled per example with tag `:papertrail` | `spec/rails_helper.rb:19,63-69` **[V]** |
| DB cleaning | Transactional fixtures for model/service/request specs; system specs turn them off and use `DatabaseCleaner` truncation (except `ar_internal_metadata`, `schema_migrations`) via `truncate_db` in `before`/`after` hooks, because Capybara's server thread does not share the transaction | `spec/rails_helper.rb:34`; `spec/support/showcase_helper.rb:13-37` **[V]** |
| `Seeders::Showcase` | `setup_showcase` creates a user and runs `Seeders::Showcase.call(user:, fake_eb:, fake_llm:)` (full demo state through production services); used by the smoke crawler (once per file, `before(:all)`) and by `spec/services/seeders/showcase_spec.rb` | `spec/support/showcase_helper.rb:13-18`; `spec/system/smoke/admin_spec.rb:8-11` **[V]** |
| Time helpers | `ActiveSupport::Testing::TimeHelpers` (`travel_to`, `freeze_time`) included globally and used in 13 spec files; wrappers `freeze_at`, `advance`, `in_business_tz` (zone `Europe/Warsaw`) exist but no spec calls them | `spec/rails_helper.rb:39,47`; `spec/support/time_helpers.rb:7-20` **[V]** |
| Sign-in | Request specs: Devise `sign_in user` (session stuffing) or `sign_in_request` (real POST `/admin/sign_in`); system specs: `sign_in_as` → Warden `login_as` | `spec/support/sign_in_helpers.rb:8-22`; `spec/AGENTS.md:549-582` **[V]** |
| API/MCP helpers | `issue_pat` (real `Auth::PersonalAccessTokenIssuer`), `bearer_headers`, `api_get/post/patch/delete`, `mcp_call`, `mcp_tool_call`; shared example "a bearer-authenticated endpoint" (4 cases: no header, non-Bearer, no `obrl_` prefix, revoked PAT → 401 `{"message":"Invalid or missing access token."}`) | `spec/support/auth_helpers.rb:6-81` **[V]** |
| Shared examples | "a cross-user isolated resource" (404 for the foreign record and the record survives; owner gets 200–399); Result-shape examples ("a service returning a Result", "a service that wraps RecordInvalid", "an idempotent service") | `spec/support/shared_examples/cross_user_isolation.rb:10-32`; `spec/support/shared_examples/result_struct.rb` **[V]** |
| System drivers | `driven_by :rack_test` for every system spec; `js: true` would switch to `:selenium, using: :headless_chrome, screen_size: [1400, 900]`; Capybara server Puma (silent), `default_max_wait_time = 5`. **No spec is tagged `js: true`**, so the whole suite runs without a browser and never executes Stimulus/Turbo JavaScript | `spec/support/system_spec_helper.rb:10-20`; `spec/rails_helper.rb:71-73`; grep for `js: true` in `spec/**` **[V]** |
| OpenTelemetry | Exporters forced to `none` and `OTEL_SDK_DISABLED=true` in `spec_helper.rb` | `spec/spec_helper.rb:10-13`; `spec/AGENTS.md:824-829` **[V]** |
| SimpleCov | Started first in `spec_helper.rb` with the `rails` profile; filters `app/controllers/swagger_controller.rb`, `app/controllers/admin/debug_controller.rb`, `app/jobs/failing_job.rb` (so these are not in the 92.05 %) | `spec/spec_helper.rb:1-8` **[V]** |
| Ordering | Random order (`config.order = :random`), seed printed; `.rspec_status` persistence | `spec/spec_helper.rb:34-35`; `spec/rails_helper.rb:49` **[V]** |

### 1.4 How to run

1. Services: PostgreSQL and Redis must be reachable (`spec/AGENTS.md:774-784`); the test DB is `open_banking_rails_test` on
   `POSTGRES_HOST`/`POSTGRES_PORT`/`POSTGRES_USER`/`POSTGRES_PASSWORD` (defaults `localhost`/`5432`/`postgres`/`postgres`,
   `config/database.yml:22-28`) **[V]** (run used local Postgres 17 / Redis 7 per `../tools/README.md`).
2. Environment used for the measured run (`../tools/env.sh`) **[V]**: `RAILS_ENV=test`, `POSTGRES_HOST=127.0.0.1`, `POSTGRES_PORT=5432`,
   `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`, `REDIS_URL=redis://127.0.0.1:6379/0`, `OTEL_SDK_DISABLED=true`, and three
   throw-away keys `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY`, `ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY`,
   `ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT` (`openssl rand -hex 32` each) — the encryption initializer only configures
   ActiveRecord encryption when all three are present (`config/initializers/active_record_encryption.rb:15-24`), and the encrypted-at-rest
   model specs need it.
3. **Build the CSS first: `bin/rails tailwindcss:build`.** Without it every example that renders a layout fails with
   `The asset 'tailwind.css' was not found in the load path.` — 174 failures (62 admin/public request, 62 system-journey, 48 smoke, 2 shared-example instances; no API/MCP/model/service example failed) in the
   first run **[V]** (`../inventory/specs_run_without_tailwind_build.json`). In development the CSS is produced by
   `bin/rails tailwindcss:watch` (`Procfile.dev:2`).
4. `bundle exec rspec` (full suite), or a file / `file:line` / `--seed N` / `--profile 10` (`spec/AGENTS.md:786-806`).
5. Duration: **1185.5 s** for the full run **[V]**; system specs account for ≈ 817 s of example time, `spec/system/cross_user_isolation_spec.rb`
   alone ≈ 142 s (8 examples of ≈ 17–18 s each, each seeding data via production services) **[V]** (`run_time` per example in `specs_run.json`).

### 1.5 Result of the real run

- `825 examples, 0 failures` (`summary_line`), `pending_count 0`, `errors_outside_of_examples_count 0`, seed 4274 **[V]**.
- Line coverage 92.05 % (5023 of 5457 relevant lines, 212 files) **[V]**. Per-file numbers in `../inventory/coverage_by_file.json`;
  line-level hits in `src/coverage/.resultset.json` (used for section 6).

---

## 2. Spec → rule mapping

Method **[V]**: every "Covered by" line of [20-business-rules.md](20-business-rules.md) (both the `- **Covered by:**` and the
`**Covered by.**` forms) was parsed; `spec/…:LINE` tokens and the following `:LINE` shorthands were resolved against
`(file_path, line_number)` in `../inventory/specs.json`. All 798 references resolve to at least one example (references into
`spec/support/**` resolve to the shared-example instances in every host file). The table is per spec file (the suite has one
top-level `describe` per file, so a file is a describe group). Rule links point to the `br-###` anchors of 20-business-rules.md.

| Spec file | Layer | Examples | Examples cited by a rule | Business rules covered |
|---|---|---:|---:|---|
| `spec/factories_spec.rb` | factory lint | 1 | 0 | — |
| `spec/models/bank_account_spec.rb` | model | 12 | 12 | [BR-027](20-business-rules.md#br-027), [BR-077](20-business-rules.md#br-077), [BR-090](20-business-rules.md#br-090), [BR-091](20-business-rules.md#br-091), [BR-092](20-business-rules.md#br-092), [BR-093](20-business-rules.md#br-093), [BR-180](20-business-rules.md#br-180) |
| `spec/models/bank_connection_spec.rb` | model | 7 | 7 | [BR-013](20-business-rules.md#br-013), [BR-085](20-business-rules.md#br-085), [BR-180](20-business-rules.md#br-180) |
| `spec/models/bank_transaction_spec.rb` | model | 7 | 5 | [BR-013](20-business-rules.md#br-013), [BR-103](20-business-rules.md#br-103), [BR-106](20-business-rules.md#br-106), [BR-111](20-business-rules.md#br-111), [BR-180](20-business-rules.md#br-180) |
| `spec/models/category_spec.rb` | model | 8 | 8 | [BR-201](20-business-rules.md#br-201), [BR-202](20-business-rules.md#br-202), [BR-203](20-business-rules.md#br-203), [BR-204](20-business-rules.md#br-204), [BR-207](20-business-rules.md#br-207), [BR-208](20-business-rules.md#br-208) |
| `spec/models/concerns/ledger_entry_concern_spec.rb` | model | 8 | 8 | [BR-218](20-business-rules.md#br-218), [BR-231](20-business-rules.md#br-231), [BR-232](20-business-rules.md#br-232), [BR-302](20-business-rules.md#br-302) |
| `spec/models/ledger_entry_spec.rb` | model | 19 | 17 | [BR-200](20-business-rules.md#br-200), [BR-201](20-business-rules.md#br-201), [BR-232](20-business-rules.md#br-232), [BR-300](20-business-rules.md#br-300), [BR-301](20-business-rules.md#br-301), [BR-302](20-business-rules.md#br-302), [BR-303](20-business-rules.md#br-303), [BR-304](20-business-rules.md#br-304), [BR-305](20-business-rules.md#br-305), [BR-307](20-business-rules.md#br-307) |
| `spec/models/llm_setting_spec.rb` | model | 6 | 6 | [BR-244](20-business-rules.md#br-244), [BR-245](20-business-rules.md#br-245) |
| `spec/models/manual_transaction_spec.rb` | model | 8 | 6 | [BR-301](20-business-rules.md#br-301), [BR-344](20-business-rules.md#br-344) |
| `spec/models/merchant_rule_spec.rb` | model | 7 | 7 | [BR-224](20-business-rules.md#br-224), [BR-225](20-business-rules.md#br-225), [BR-226](20-business-rules.md#br-226) |
| `spec/models/merchant_spec.rb` | model | 7 | 7 | [BR-215](20-business-rules.md#br-215), [BR-216](20-business-rules.md#br-216) |
| `spec/models/operation_run_spec.rb` | model | 11 | 11 | [BR-128](20-business-rules.md#br-128), [BR-140](20-business-rules.md#br-140), [BR-142](20-business-rules.md#br-142), [BR-144](20-business-rules.md#br-144) |
| `spec/models/personal_access_token_spec.rb` | model | 9 | 7 | [BR-017](20-business-rules.md#br-017), [BR-018](20-business-rules.md#br-018), [BR-020](20-business-rules.md#br-020), [BR-022](20-business-rules.md#br-022) |
| `spec/models/styleguide_demo_spec.rb` | model | 2 | 0 | — |
| `spec/models/sync_schedule_spec.rb` | model | 7 | 7 | [BR-125](20-business-rules.md#br-125), [BR-126](20-business-rules.md#br-126) |
| `spec/models/tpp_credential_spec.rb` | model | 10 | 10 | [BR-050](20-business-rules.md#br-050), [BR-052](20-business-rules.md#br-052), [BR-053](20-business-rules.md#br-053), [BR-180](20-business-rules.md#br-180) |
| `spec/models/transaction_enrichment_spec.rb` | model | 6 | 6 | [BR-231](20-business-rules.md#br-231), [BR-232](20-business-rules.md#br-232) |
| `spec/models/user_hidden_category_spec.rb` | model | 2 | 2 | [BR-211](20-business-rules.md#br-211) |
| `spec/models/user_spec.rb` | model | 7 | 7 | [BR-006](20-business-rules.md#br-006), [BR-013](20-business-rules.md#br-013), [BR-026](20-business-rules.md#br-026), [BR-027](20-business-rules.md#br-027), [BR-211](20-business-rules.md#br-211) |
| `spec/requests/analytics_spec.rb` | request (admin/public) | 14 | 13 | [BR-306](20-business-rules.md#br-306), [BR-307](20-business-rules.md#br-307), [BR-321](20-business-rules.md#br-321), [BR-323](20-business-rules.md#br-323), [BR-330](20-business-rules.md#br-330), [BR-331](20-business-rules.md#br-331), [BR-333](20-business-rules.md#br-333) |
| `spec/requests/api/v1/analytics_spec.rb` | request (API) | 11 | 11 | [BR-305](20-business-rules.md#br-305), [BR-311](20-business-rules.md#br-311), [BR-320](20-business-rules.md#br-320), [BR-325](20-business-rules.md#br-325), [BR-327](20-business-rules.md#br-327), [BR-330](20-business-rules.md#br-330), [BR-331](20-business-rules.md#br-331) |
| `spec/requests/api/v1/banking_spec.rb` | request (API) | 19 | 11 | [BR-014](20-business-rules.md#br-014), [BR-052](20-business-rules.md#br-052), [BR-054](20-business-rules.md#br-054), [BR-055](20-business-rules.md#br-055), [BR-085](20-business-rules.md#br-085), [BR-086](20-business-rules.md#br-086), [BR-087](20-business-rules.md#br-087), [BR-115](20-business-rules.md#br-115), [BR-143](20-business-rules.md#br-143) |
| `spec/requests/api/v1/categorization_spec.rb` | request (API) | 23 | 12 | [BR-205](20-business-rules.md#br-205), [BR-206](20-business-rules.md#br-206), [BR-208](20-business-rules.md#br-208), [BR-209](20-business-rules.md#br-209), [BR-210](20-business-rules.md#br-210), [BR-217](20-business-rules.md#br-217), [BR-220](20-business-rules.md#br-220), [BR-221](20-business-rules.md#br-221), [BR-252](20-business-rules.md#br-252) |
| `spec/requests/api/v1/cross_cutting_spec.rb` | request (API) | 13 | 5 | [BR-019](20-business-rules.md#br-019) |
| `spec/requests/api/v1/transactions_spec.rb` | request (API) | 17 | 11 | [BR-343](20-business-rules.md#br-343), [BR-347](20-business-rules.md#br-347), [BR-348](20-business-rules.md#br-348), [BR-367](20-business-rules.md#br-367), [BR-369](20-business-rules.md#br-369) |
| `spec/requests/banking_spec.rb` | request (admin/public) | 41 | 39 | [BR-012](20-business-rules.md#br-012), [BR-013](20-business-rules.md#br-013), [BR-014](20-business-rules.md#br-014), [BR-050](20-business-rules.md#br-050), [BR-051](20-business-rules.md#br-051), [BR-052](20-business-rules.md#br-052), [BR-054](20-business-rules.md#br-054), [BR-055](20-business-rules.md#br-055), [BR-065](20-business-rules.md#br-065), [BR-066](20-business-rules.md#br-066), [BR-067](20-business-rules.md#br-067), [BR-079](20-business-rules.md#br-079), [BR-086](20-business-rules.md#br-086), [BR-087](20-business-rules.md#br-087), [BR-090](20-business-rules.md#br-090), [BR-091](20-business-rules.md#br-091), [BR-092](20-business-rules.md#br-092), [BR-115](20-business-rules.md#br-115), [BR-132](20-business-rules.md#br-132), [BR-143](20-business-rules.md#br-143) |
| `spec/requests/cash_spec.rb` | request (admin/public) | 21 | 20 | [BR-014](20-business-rules.md#br-014), [BR-343](20-business-rules.md#br-343), [BR-347](20-business-rules.md#br-347), [BR-348](20-business-rules.md#br-348), [BR-352](20-business-rules.md#br-352) |
| `spec/requests/categorization_spec.rb` | request (admin/public) | 40 | 33 | [BR-202](20-business-rules.md#br-202), [BR-208](20-business-rules.md#br-208), [BR-209](20-business-rules.md#br-209), [BR-210](20-business-rules.md#br-210), [BR-212](20-business-rules.md#br-212), [BR-217](20-business-rules.md#br-217), [BR-218](20-business-rules.md#br-218), [BR-219](20-business-rules.md#br-219), [BR-220](20-business-rules.md#br-220), [BR-221](20-business-rules.md#br-221), [BR-222](20-business-rules.md#br-222), [BR-223](20-business-rules.md#br-223), [BR-228](20-business-rules.md#br-228), [BR-241](20-business-rules.md#br-241), [BR-243](20-business-rules.md#br-243), [BR-252](20-business-rules.md#br-252) |
| `spec/requests/mcp/protocol_spec.rb` | request (MCP) | 10 | 4 | [BR-014](20-business-rules.md#br-014), [BR-019](20-business-rules.md#br-019) |
| `spec/requests/mcp/tools_spec.rb` | request (MCP) | 9 | 3 | [BR-205](20-business-rules.md#br-205), [BR-221](20-business-rules.md#br-221) |
| `spec/requests/meta_spec.rb` | request (admin/public) | 6 | 0 | — |
| `spec/requests/onboarding_spec.rb` | request (admin/public) | 4 | 4 | [BR-004](20-business-rules.md#br-004), [BR-214](20-business-rules.md#br-214) |
| `spec/requests/public_spec.rb` | request (admin/public) | 22 | 21 | [BR-002](20-business-rules.md#br-002), [BR-003](20-business-rules.md#br-003), [BR-007](20-business-rules.md#br-007), [BR-008](20-business-rules.md#br-008), [BR-010](20-business-rules.md#br-010), [BR-011](20-business-rules.md#br-011), [BR-012](20-business-rules.md#br-012), [BR-069](20-business-rules.md#br-069), [BR-070](20-business-rules.md#br-070) |
| `spec/requests/settings_spec.rb` | request (admin/public) | 33 | 32 | [BR-006](20-business-rules.md#br-006), [BR-014](20-business-rules.md#br-014), [BR-017](20-business-rules.md#br-017), [BR-018](20-business-rules.md#br-018), [BR-020](20-business-rules.md#br-020), [BR-021](20-business-rules.md#br-021), [BR-023](20-business-rules.md#br-023), [BR-024](20-business-rules.md#br-024), [BR-025](20-business-rules.md#br-025), [BR-028](20-business-rules.md#br-028), [BR-150](20-business-rules.md#br-150), [BR-153](20-business-rules.md#br-153), [BR-154](20-business-rules.md#br-154), [BR-156](20-business-rules.md#br-156), [BR-211](20-business-rules.md#br-211), [BR-246](20-business-rules.md#br-246), [BR-249](20-business-rules.md#br-249) |
| `spec/services/analytics/cash_flow_spec.rb` | service | 3 | 3 | [BR-303](20-business-rules.md#br-303), [BR-313](20-business-rules.md#br-313), [BR-320](20-business-rules.md#br-320) |
| `spec/services/analytics/filter_spec.rb` | service | 6 | 6 | [BR-305](20-business-rules.md#br-305), [BR-306](20-business-rules.md#br-306), [BR-311](20-business-rules.md#br-311), [BR-312](20-business-rules.md#br-312), [BR-316](20-business-rules.md#br-316) |
| `spec/services/analytics/period_spec.rb` | service | 6 | 5 | [BR-310](20-business-rules.md#br-310), [BR-311](20-business-rules.md#br-311), [BR-313](20-business-rules.md#br-313), [BR-314](20-business-rules.md#br-314) |
| `spec/services/analytics/top_merchants_spec.rb` | service | 3 | 3 | [BR-327](20-business-rules.md#br-327), [BR-360](20-business-rules.md#br-360) |
| `spec/services/auth/personal_access_token_authenticator_spec.rb` | service | 4 | 4 | [BR-019](20-business-rules.md#br-019) |
| `spec/services/auth/personal_access_token_issuer_spec.rb` | service | 5 | 5 | [BR-016](20-business-rules.md#br-016), [BR-017](20-business-rules.md#br-017), [BR-018](20-business-rules.md#br-018) |
| `spec/services/auto_sync/circuit_breaker_spec.rb` | service | 6 | 6 | [BR-133](20-business-rules.md#br-133), [BR-134](20-business-rules.md#br-134) |
| `spec/services/auto_sync/dispatcher_spec.rb` | service | 5 | 5 | [BR-126](20-business-rules.md#br-126), [BR-127](20-business-rules.md#br-127), [BR-128](20-business-rules.md#br-128), [BR-129](20-business-rules.md#br-129) |
| `spec/services/auto_sync/next_run_calculator_spec.rb` | service | 8 | 8 | [BR-130](20-business-rules.md#br-130), [BR-131](20-business-rules.md#br-131) |
| `spec/services/auto_sync/schedule_upserter_spec.rb` | service | 6 | 6 | [BR-132](20-business-rules.md#br-132) |
| `spec/services/banking_spec.rb` | service | 10 | 10 | [BR-106](20-business-rules.md#br-106), [BR-236](20-business-rules.md#br-236) |
| `spec/services/cash/atm_withdrawal_linker_spec.rb` | service | 6 | 6 | [BR-349](20-business-rules.md#br-349) |
| `spec/services/cash/tracking_spec.rb` | service | 5 | 5 | [BR-340](20-business-rules.md#br-340), [BR-350](20-business-rules.md#br-350) |
| `spec/services/cash/transaction_creator_spec.rb` | service | 7 | 7 | [BR-341](20-business-rules.md#br-341), [BR-342](20-business-rules.md#br-342), [BR-343](20-business-rules.md#br-343), [BR-345](20-business-rules.md#br-345) |
| `spec/services/cash/transaction_updater_spec.rb` | service | 7 | 7 | [BR-342](20-business-rules.md#br-342), [BR-345](20-business-rules.md#br-345), [BR-347](20-business-rules.md#br-347) |
| `spec/services/categories/creator_spec.rb` | service | 5 | 5 | [BR-203](20-business-rules.md#br-203), [BR-205](20-business-rules.md#br-205) |
| `spec/services/categories/mover_spec.rb` | service | 5 | 5 | [BR-206](20-business-rules.md#br-206) |
| `spec/services/data_exchange/round_trip_spec.rb` | service | 5 | 5 | [BR-150](20-business-rules.md#br-150), [BR-151](20-business-rules.md#br-151), [BR-152](20-business-rules.md#br-152), [BR-153](20-business-rules.md#br-153), [BR-154](20-business-rules.md#br-154), [BR-155](20-business-rules.md#br-155), [BR-156](20-business-rules.md#br-156) |
| `spec/services/enable_banking/adapter_spec.rb` | service | 9 | 9 | [BR-060](20-business-rules.md#br-060), [BR-061](20-business-rules.md#br-061), [BR-062](20-business-rules.md#br-062) |
| `spec/services/enable_banking/api/get_account_transactions_spec.rb` | service | 4 | 4 | [BR-101](20-business-rules.md#br-101) |
| `spec/services/enable_banking/backfill_window_spec.rb` | service | 4 | 4 | [BR-100](20-business-rules.md#br-100) |
| `spec/services/enable_banking/jwt_signer_spec.rb` | service | 5 | 5 | [BR-060](20-business-rules.md#br-060) |
| `spec/services/enable_banking/operations/close_connection_spec.rb` | service | 4 | 4 | [BR-087](20-business-rules.md#br-087) |
| `spec/services/enable_banking/operations/create_connection_spec.rb` | service | 3 | 3 | [BR-075](20-business-rules.md#br-075), [BR-076](20-business-rules.md#br-076), [BR-077](20-business-rules.md#br-077), [BR-079](20-business-rules.md#br-079) |
| `spec/services/enable_banking/operations/refresh_account_balances_spec.rb` | service | 2 | 2 | [BR-092](20-business-rules.md#br-092) |
| `spec/services/enable_banking/operations/refresh_account_details_spec.rb` | service | 4 | 4 | [BR-078](20-business-rules.md#br-078), [BR-091](20-business-rules.md#br-091) |
| `spec/services/enable_banking/operations/refresh_connection_spec.rb` | service | 5 | 5 | [BR-086](20-business-rules.md#br-086) |
| `spec/services/enable_banking/operations/start_auth_spec.rb` | service | 3 | 3 | [BR-067](20-business-rules.md#br-067) |
| `spec/services/enable_banking/operations/sync_account_transactions_spec.rb` | service | 9 | 9 | [BR-100](20-business-rules.md#br-100), [BR-103](20-business-rules.md#br-103), [BR-107](20-business-rules.md#br-107), [BR-236](20-business-rules.md#br-236) |
| `spec/services/enable_banking/operations/verify_credential_spec.rb` | service | 6 | 6 | [BR-055](20-business-rules.md#br-055), [BR-063](20-business-rules.md#br-063) |
| `spec/services/enable_banking/payment_method_inferer_spec.rb` | service | 16 | 16 | [BR-105](20-business-rules.md#br-105) |
| `spec/services/enable_banking/state_spec.rb` | service | 6 | 6 | [BR-068](20-business-rules.md#br-068) |
| `spec/services/enable_banking/transaction_normalizer_spec.rb` | service | 14 | 14 | [BR-104](20-business-rules.md#br-104), [BR-111](20-business-rules.md#br-111) |
| `spec/services/enrichment/classification_applier_spec.rb` | service | 7 | 7 | [BR-237](20-business-rules.md#br-237), [BR-238](20-business-rules.md#br-238), [BR-239](20-business-rules.md#br-239), [BR-240](20-business-rules.md#br-240) |
| `spec/services/enrichment/title_normalizer_spec.rb` | service | 5 | 5 | [BR-264](20-business-rules.md#br-264) |
| `spec/services/enrichment/transaction_enricher_spec.rb` | service | 11 | 11 | [BR-225](20-business-rules.md#br-225), [BR-226](20-business-rules.md#br-226), [BR-233](20-business-rules.md#br-233), [BR-234](20-business-rules.md#br-234), [BR-235](20-business-rules.md#br-235) |
| `spec/services/llm/clients/openai_spec.rb` | service | 2 | 2 | [BR-248](20-business-rules.md#br-248) |
| `spec/services/llm/connection_test_runner_spec.rb` | service | 14 | 14 | [BR-247](20-business-rules.md#br-247), [BR-249](20-business-rules.md#br-249) |
| `spec/services/mcp/application_tool_spec.rb` | service | 17 | 0 | — |
| `spec/services/mcp/server_builder_spec.rb` | service | 3 | 0 | — |
| `spec/services/merchant_rules/destroyer_spec.rb` | service | 2 | 2 | [BR-228](20-business-rules.md#br-228) |
| `spec/services/merchant_rules/updater_spec.rb` | service | 4 | 4 | [BR-228](20-business-rules.md#br-228) |
| `spec/services/merchants/approver_spec.rb` | service | 4 | 4 | [BR-221](20-business-rules.md#br-221), [BR-262](20-business-rules.md#br-262) |
| `spec/services/operation_run_finalizer_spec.rb` | service | 5 | 5 | [BR-141](20-business-rules.md#br-141) |
| `spec/services/seeders/categories_spec.rb` | service | 3 | 3 | [BR-004](20-business-rules.md#br-004), [BR-213](20-business-rules.md#br-213) |
| `spec/services/seeders/merchant_rules_spec.rb` | service | 3 | 3 | [BR-004](20-business-rules.md#br-004), [BR-227](20-business-rules.md#br-227), [BR-229](20-business-rules.md#br-229) |
| `spec/services/seeders/showcase_spec.rb` | service | 7 | 7 | [BR-230](20-business-rules.md#br-230), [BR-266](20-business-rules.md#br-266) |
| `spec/system/auto_sync_circuit_breaker_spec.rb` | system journey | 3 | 3 | [BR-133](20-business-rules.md#br-133), [BR-134](20-business-rules.md#br-134) |
| `spec/system/auto_sync_tick_spec.rb` | system journey | 3 | 3 | [BR-116](20-business-rules.md#br-116), [BR-127](20-business-rules.md#br-127) |
| `spec/system/cash_with_atm_link_spec.rb` | system journey | 3 | 3 | [BR-340](20-business-rules.md#br-340), [BR-349](20-business-rules.md#br-349), [BR-351](20-business-rules.md#br-351) |
| `spec/system/categorization_workflow_spec.rb` | system journey | 3 | 3 | [BR-226](20-business-rules.md#br-226), [BR-228](20-business-rules.md#br-228), [BR-233](20-business-rules.md#br-233) |
| `spec/system/connection_expiry_reauth_spec.rb` | system journey | 3 | 3 | [BR-069](20-business-rules.md#br-069), [BR-079](20-business-rules.md#br-079) |
| `spec/system/cross_user_isolation_spec.rb` | system journey | 8 | 6 | [BR-013](20-business-rules.md#br-013), [BR-014](20-business-rules.md#br-014), [BR-252](20-business-rules.md#br-252) |
| `spec/system/daily_login_analytics_spec.rb` | system journey | 4 | 4 | [BR-330](20-business-rules.md#br-330), [BR-332](20-business-rules.md#br-332), [BR-334](20-business-rules.md#br-334) |
| `spec/system/data_exchange_round_trip_spec.rb` | system journey | 5 | 5 | [BR-150](20-business-rules.md#br-150), [BR-152](20-business-rules.md#br-152), [BR-153](20-business-rules.md#br-153), [BR-154](20-business-rules.md#br-154), [BR-155](20-business-rules.md#br-155) |
| `spec/system/first_run_setup_spec.rb` | system journey | 7 | 7 | [BR-001](20-business-rules.md#br-001), [BR-002](20-business-rules.md#br-002), [BR-003](20-business-rules.md#br-003) |
| `spec/system/first_time_setup_spec.rb` | system journey | 3 | 3 | [BR-003](20-business-rules.md#br-003), [BR-070](20-business-rules.md#br-070), [BR-109](20-business-rules.md#br-109) |
| `spec/system/llm_enrichment_spec.rb` | system journey | 4 | 4 | [BR-216](20-business-rules.md#br-216), [BR-250](20-business-rules.md#br-250), [BR-251](20-business-rules.md#br-251), [BR-252](20-business-rules.md#br-252), [BR-253](20-business-rules.md#br-253), [BR-254](20-business-rules.md#br-254), [BR-255](20-business-rules.md#br-255), [BR-256](20-business-rules.md#br-256), [BR-257](20-business-rules.md#br-257), [BR-258](20-business-rules.md#br-258), [BR-259](20-business-rules.md#br-259), [BR-260](20-business-rules.md#br-260), [BR-261](20-business-rules.md#br-261), [BR-262](20-business-rules.md#br-262), [BR-263](20-business-rules.md#br-263) |
| `spec/system/manual_sync_flow_spec.rb` | system journey | 3 | 3 | [BR-108](20-business-rules.md#br-108), [BR-115](20-business-rules.md#br-115), [BR-116](20-business-rules.md#br-116), [BR-117](20-business-rules.md#br-117), [BR-118](20-business-rules.md#br-118), [BR-141](20-business-rules.md#br-141) |
| `spec/system/oauth_callback_error_spec.rb` | system journey | 6 | 6 | [BR-012](20-business-rules.md#br-012), [BR-069](20-business-rules.md#br-069) |
| `spec/system/oauth_callback_success_spec.rb` | system journey | 4 | 4 | [BR-069](20-business-rules.md#br-069), [BR-070](20-business-rules.md#br-070), [BR-075](20-business-rules.md#br-075) |
| `spec/system/personal_access_token_lifecycle_spec.rb` | system journey | 4 | 4 | [BR-017](20-business-rules.md#br-017), [BR-019](20-business-rules.md#br-019) |
| `spec/system/settings_change_spec.rb` | system journey | 4 | 3 | [BR-202](20-business-rules.md#br-202), [BR-203](20-business-rules.md#br-203), [BR-208](20-business-rules.md#br-208) |
| `spec/system/smoke/admin_spec.rb` | system (smoke) | 41 | 0 | — |
| `spec/system/smoke/auth_spec.rb` | system (smoke) | 7 | 7 | [BR-002](20-business-rules.md#br-002), [BR-007](20-business-rules.md#br-007), [BR-010](20-business-rules.md#br-010), [BR-012](20-business-rules.md#br-012) |

### 2.1 Shared-example references

| Shared-example reference | Host examples (rspec ids) | Rules |
|---|---|---|
| `spec/support/auth_helpers.rb:58` | `spec/requests/api/v1/cross_cutting_spec.rb[1:1:1]` | [BR-019](20-business-rules.md#br-019) |
| `spec/support/auth_helpers.rb:64` | `spec/requests/api/v1/cross_cutting_spec.rb[1:1:2]` | [BR-019](20-business-rules.md#br-019) |
| `spec/support/auth_helpers.rb:69` | `spec/requests/api/v1/cross_cutting_spec.rb[1:1:3]` | [BR-019](20-business-rules.md#br-019) |
| `spec/support/auth_helpers.rb:74` | `spec/requests/api/v1/cross_cutting_spec.rb[1:1:4]` | [BR-019](20-business-rules.md#br-019) |
| `spec/support/shared_examples/cross_user_isolation.rb:11` | `spec/requests/banking_spec.rb[1:13:1]`, `spec/requests/banking_spec.rb[1:2:1]`, `spec/requests/cash_spec.rb[1:8:1]`, `spec/requests/settings_spec.rb[1:31:1]` | [BR-014](20-business-rules.md#br-014) |
| `spec/support/shared_examples/cross_user_isolation.rb:23` | `spec/requests/banking_spec.rb[1:13:2]`, `spec/requests/banking_spec.rb[1:2:2]`, `spec/requests/cash_spec.rb[1:8:2]`, `spec/requests/settings_spec.rb[1:31:2]` | [BR-014](20-business-rules.md#br-014) |

### 2.2 Spec files referenced by no rule

6 files contain no example cited by any business rule:

- `spec/factories_spec.rb` (factory lint, 1 examples) [V]
- `spec/models/styleguide_demo_spec.rb` (model, 2 examples) [V]
- `spec/requests/meta_spec.rb` (request (admin/public), 6 examples) [V]
- `spec/services/mcp/application_tool_spec.rb` (service, 17 examples) [V]
- `spec/services/mcp/server_builder_spec.rb` (service, 3 examples) [V]
- `spec/system/smoke/admin_spec.rb` (system (smoke), 41 examples) [V]

Overall 140 of 825 examples are not cited by any rule (for example most of the 41 smoke-crawler examples, MCP base-class
unit specs, Enable Banking wire/normaliser specs). They still passed in the run and remain useful as Kotlin unit-test inspiration, but
no rule depends on them.

---

## 3. Rule → spec matrix

Classification **[V]** (from the parsed "Covered by" lines): **covered** = cites ≥ 1 passing example; **partial** = the line starts with
"untested" but cites an indirect example; **untested** = no spec reference.

| State | Rules |
|---|---:|
| covered | 190 |
| partial | 4 |
| untested | 31 |
| **total** | **225** |

### 3.1 Untested rules (gaps)

Every one of these needs a new Kotlin test written from the rule text (no Ruby spec to port) **[V]**:

| Rule | Title | Note from 20-business-rules.md |
|---|---|---|
| [BR-005](20-business-rules.md#br-005) | No public registration; further users are created out-of-band | untested (absence of route). |
| [BR-009](20-business-rules.md#br-009) | Remember-me | untested. |
| [BR-015](20-business-rules.md#br-015) | Known tenancy gaps (do not replicate without a decision) | untested. |
| [BR-080](20-business-rules.md#br-080) | Side effects that replacement does NOT perform | untested. |
| [BR-102](20-business-rules.md#br-102) | No transaction-status filter is sent | untested. |
| [BR-110](20-business-rules.md#br-110) | Errors that escape per-account isolation | untested. |
| [BR-119](20-business-rules.md#br-119) | Job retry policy | untested. |
| [BR-157](20-business-rules.md#br-157) | Source fingerprint | untested. |
| [BR-170](20-business-rules.md#br-170) | Rake `banking:backfill_counterparty_kind` | untested. |
| [BR-171](20-business-rules.md#br-171) | Rake `banking:backfill_payment_methods` (`DRY_RUN=1` supported) | untested. |
| [BR-172](20-business-rules.md#br-172) | Rake `banking:diagnose_duplicate_accounts` | untested. |
| [BR-173](20-business-rules.md#br-173) | Rake `banking:merge_duplicate_accounts CANONICAL_ID= DUP_ID= [CONFIRM=1]` | untested. |
| [BR-174](20-business-rules.md#br-174) | Rake `banking:start_auth` | untested. |
| [BR-175](20-business-rules.md#br-175) | Rake `banking:finish_auth CODE= STATE=` | untested. |
| [BR-176](20-business-rules.md#br-176) | Rake `cash:backfill_atm_links` | untested. |
| [BR-242](20-business-rules.md#br-242) | Classify modal defaults | untested (UI only). |
| [BR-265](20-business-rules.md#br-265) | "Facts-only" AI narration boundary | untested (not implemented). |
| [BR-315](20-business-rules.md#br-315) | Period presets (dashboard filter strip) | untested. |
| [BR-322](20-business-rules.md#br-322) | Savings rate | untested. |
| [BR-324](20-business-rules.md#br-324) | Unmatched-debit warning | untested. |
| [BR-326](20-business-rules.md#br-326) | Top movers | untested. |
| [BR-328](20-business-rules.md#br-328) | Account share of spend | untested. |
| [BR-329](20-business-rules.md#br-329) | Essentials vs discretionary | untested. |
| [BR-346](20-business-rules.md#br-346) | Counterparty kind on manual rows | untested for manual rows specifically. |
| [BR-361](20-business-rules.md#br-361) | Money display format | untested. |
| [BR-362](20-business-rules.md#br-362) | Percentages | untested. |
| [BR-363](20-business-rules.md#br-363) | Privacy mode and sensitive-value kinds | untested. |
| [BR-364](20-business-rules.md#br-364) | Server-side hiding of private category values | untested. |
| [BR-365](20-business-rules.md#br-365) | Sortable column headers | untested. |
| [BR-366](20-business-rules.md#br-366) | Enrichment-source and payment-method labels | untested. |
| [BR-368](20-business-rules.md#br-368) | Ransack search configuration and bank-transaction filters | untested for filter semantics. |

### 3.2 Partially tested rules

| Rule | Title | Note |
|---|---|---|
| [BR-118](20-business-rules.md#br-118) | Post-sync enrichment and ATM linking | untested at job level. The enrichment itself is covered in the enrichment part; `spec/system/manual_sync_flow_spec.rb:16` runs the job end to end. |
| [BR-230](20-business-rules.md#br-230) | Own-account merchants (`OwnAccountMerchantSyncer`) | untested directly. Indirectly exercised by `spec/services/seeders/showcase_spec.rb:13` (connections created). |
| [BR-321](20-business-rules.md#br-321) | Spend change percentage | untested (only render 200 in `spec/requests/analytics_spec.rb:6`). |
| [BR-351](20-business-rules.md#br-351) | Cash wallet balances (cash index) | untested (balances); `spec/system/cash_with_atm_link_spec.rb:16` updates the list after a 50 PLN expense. |

### 3.3 Full matrix

<details><summary>All 225 rules with example count and spec files</summary>

| Rule | State | Examples | Spec files |
|---|---|---:|---|
| [BR-001](20-business-rules.md#br-001) | covered | 2 | `system/first_run_setup_spec.rb` |
| [BR-002](20-business-rules.md#br-002) | covered | 9 | `requests/public_spec.rb`, `system/first_run_setup_spec.rb`, `system/smoke/auth_spec.rb` |
| [BR-003](20-business-rules.md#br-003) | covered | 6 | `requests/public_spec.rb`, `system/first_run_setup_spec.rb`, `system/first_time_setup_spec.rb` |
| [BR-004](20-business-rules.md#br-004) | covered | 7 | `requests/onboarding_spec.rb`, `services/seeders/categories_spec.rb`, `services/seeders/merchant_rules_spec.rb` |
| [BR-005](20-business-rules.md#br-005) | untested | 0 | — |
| [BR-006](20-business-rules.md#br-006) | covered | 3 | `models/user_spec.rb`, `requests/settings_spec.rb` |
| [BR-007](20-business-rules.md#br-007) | covered | 4 | `requests/public_spec.rb`, `system/smoke/auth_spec.rb` |
| [BR-008](20-business-rules.md#br-008) | covered | 1 | `requests/public_spec.rb` |
| [BR-009](20-business-rules.md#br-009) | untested | 0 | — |
| [BR-010](20-business-rules.md#br-010) | covered | 3 | `requests/public_spec.rb`, `system/smoke/auth_spec.rb` |
| [BR-011](20-business-rules.md#br-011) | covered | 1 | `requests/public_spec.rb` |
| [BR-012](20-business-rules.md#br-012) | covered | 6 | `requests/banking_spec.rb`, `requests/public_spec.rb`, `system/oauth_callback_error_spec.rb`, `system/smoke/auth_spec.rb` |
| [BR-013](20-business-rules.md#br-013) | covered | 8 | `models/bank_connection_spec.rb`, `models/bank_transaction_spec.rb`, `models/user_spec.rb`, `requests/banking_spec.rb`, `system/cross_user_isolation_spec.rb` |
| [BR-014](20-business-rules.md#br-014) | covered | 21 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb`, `requests/cash_spec.rb`, `requests/mcp/protocol_spec.rb`, `requests/settings_spec.rb`, `system/cross_user_isolation_spec.rb` |
| [BR-015](20-business-rules.md#br-015) | untested | 0 | — |
| [BR-016](20-business-rules.md#br-016) | covered | 1 | `services/auth/personal_access_token_issuer_spec.rb` |
| [BR-017](20-business-rules.md#br-017) | covered | 7 | `models/personal_access_token_spec.rb`, `requests/settings_spec.rb`, `services/auth/personal_access_token_issuer_spec.rb`, `system/personal_access_token_lifecycle_spec.rb` |
| [BR-018](20-business-rules.md#br-018) | covered | 6 | `models/personal_access_token_spec.rb`, `requests/settings_spec.rb`, `services/auth/personal_access_token_issuer_spec.rb` |
| [BR-019](20-business-rules.md#br-019) | covered | 15 | `requests/api/v1/cross_cutting_spec.rb`, `requests/mcp/protocol_spec.rb`, `services/auth/personal_access_token_authenticator_spec.rb`, `system/personal_access_token_lifecycle_spec.rb` |
| [BR-020](20-business-rules.md#br-020) | covered | 3 | `models/personal_access_token_spec.rb`, `requests/settings_spec.rb` |
| [BR-021](20-business-rules.md#br-021) | covered | 2 | `requests/settings_spec.rb` |
| [BR-022](20-business-rules.md#br-022) | covered | 1 | `models/personal_access_token_spec.rb` |
| [BR-023](20-business-rules.md#br-023) | covered | 3 | `requests/settings_spec.rb` |
| [BR-024](20-business-rules.md#br-024) | covered | 2 | `requests/settings_spec.rb` |
| [BR-025](20-business-rules.md#br-025) | covered | 5 | `requests/settings_spec.rb` |
| [BR-026](20-business-rules.md#br-026) | covered | 2 | `models/user_spec.rb` |
| [BR-027](20-business-rules.md#br-027) | covered | 4 | `models/bank_account_spec.rb`, `models/user_spec.rb` |
| [BR-028](20-business-rules.md#br-028) | covered | 7 | `requests/settings_spec.rb` |
| [BR-050](20-business-rules.md#br-050) | covered | 4 | `models/tpp_credential_spec.rb`, `requests/banking_spec.rb` |
| [BR-051](20-business-rules.md#br-051) | covered | 2 | `requests/banking_spec.rb` |
| [BR-052](20-business-rules.md#br-052) | covered | 4 | `models/tpp_credential_spec.rb`, `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb` |
| [BR-053](20-business-rules.md#br-053) | covered | 6 | `models/tpp_credential_spec.rb` |
| [BR-054](20-business-rules.md#br-054) | covered | 3 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb` |
| [BR-055](20-business-rules.md#br-055) | covered | 9 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb`, `services/enable_banking/operations/verify_credential_spec.rb` |
| [BR-060](20-business-rules.md#br-060) | covered | 6 | `services/enable_banking/adapter_spec.rb`, `services/enable_banking/jwt_signer_spec.rb` |
| [BR-061](20-business-rules.md#br-061) | covered | 4 | `services/enable_banking/adapter_spec.rb` |
| [BR-062](20-business-rules.md#br-062) | covered | 5 | `services/enable_banking/adapter_spec.rb` |
| [BR-063](20-business-rules.md#br-063) | covered | 1 | `services/enable_banking/operations/verify_credential_spec.rb` |
| [BR-065](20-business-rules.md#br-065) | covered | 1 | `requests/banking_spec.rb` |
| [BR-066](20-business-rules.md#br-066) | covered | 3 | `requests/banking_spec.rb` |
| [BR-067](20-business-rules.md#br-067) | covered | 5 | `requests/banking_spec.rb`, `services/enable_banking/operations/start_auth_spec.rb` |
| [BR-068](20-business-rules.md#br-068) | covered | 6 | `services/enable_banking/state_spec.rb` |
| [BR-069](20-business-rules.md#br-069) | covered | 19 | `requests/public_spec.rb`, `system/connection_expiry_reauth_spec.rb`, `system/oauth_callback_error_spec.rb`, `system/oauth_callback_success_spec.rb` |
| [BR-070](20-business-rules.md#br-070) | covered | 3 | `requests/public_spec.rb`, `system/first_time_setup_spec.rb`, `system/oauth_callback_success_spec.rb` |
| [BR-075](20-business-rules.md#br-075) | covered | 3 | `services/enable_banking/operations/create_connection_spec.rb`, `system/oauth_callback_success_spec.rb` |
| [BR-076](20-business-rules.md#br-076) | covered | 2 | `services/enable_banking/operations/create_connection_spec.rb` |
| [BR-077](20-business-rules.md#br-077) | covered | 2 | `models/bank_account_spec.rb`, `services/enable_banking/operations/create_connection_spec.rb` |
| [BR-078](20-business-rules.md#br-078) | covered | 1 | `services/enable_banking/operations/refresh_account_details_spec.rb` |
| [BR-079](20-business-rules.md#br-079) | covered | 4 | `requests/banking_spec.rb`, `services/enable_banking/operations/create_connection_spec.rb`, `system/connection_expiry_reauth_spec.rb` |
| [BR-080](20-business-rules.md#br-080) | untested | 0 | — |
| [BR-085](20-business-rules.md#br-085) | covered | 6 | `models/bank_connection_spec.rb`, `requests/api/v1/banking_spec.rb` |
| [BR-086](20-business-rules.md#br-086) | covered | 7 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb`, `services/enable_banking/operations/refresh_connection_spec.rb` |
| [BR-087](20-business-rules.md#br-087) | covered | 6 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb`, `services/enable_banking/operations/close_connection_spec.rb` |
| [BR-090](20-business-rules.md#br-090) | covered | 7 | `models/bank_account_spec.rb`, `requests/banking_spec.rb` |
| [BR-091](20-business-rules.md#br-091) | covered | 6 | `models/bank_account_spec.rb`, `requests/banking_spec.rb`, `services/enable_banking/operations/refresh_account_details_spec.rb` |
| [BR-092](20-business-rules.md#br-092) | covered | 4 | `models/bank_account_spec.rb`, `requests/banking_spec.rb`, `services/enable_banking/operations/refresh_account_balances_spec.rb` |
| [BR-093](20-business-rules.md#br-093) | covered | 2 | `models/bank_account_spec.rb` |
| [BR-100](20-business-rules.md#br-100) | covered | 6 | `services/enable_banking/backfill_window_spec.rb`, `services/enable_banking/operations/sync_account_transactions_spec.rb` |
| [BR-101](20-business-rules.md#br-101) | covered | 4 | `services/enable_banking/api/get_account_transactions_spec.rb` |
| [BR-102](20-business-rules.md#br-102) | untested | 0 | — |
| [BR-103](20-business-rules.md#br-103) | covered | 5 | `models/bank_transaction_spec.rb`, `services/enable_banking/operations/sync_account_transactions_spec.rb` |
| [BR-104](20-business-rules.md#br-104) | covered | 14 | `services/enable_banking/transaction_normalizer_spec.rb` |
| [BR-105](20-business-rules.md#br-105) | covered | 16 | `services/enable_banking/payment_method_inferer_spec.rb` |
| [BR-106](20-business-rules.md#br-106) | covered | 11 | `models/bank_transaction_spec.rb`, `services/banking_spec.rb` |
| [BR-107](20-business-rules.md#br-107) | covered | 3 | `services/enable_banking/operations/sync_account_transactions_spec.rb` |
| [BR-108](20-business-rules.md#br-108) | covered | 2 | `system/manual_sync_flow_spec.rb` |
| [BR-109](20-business-rules.md#br-109) | covered | 1 | `system/first_time_setup_spec.rb` |
| [BR-110](20-business-rules.md#br-110) | untested | 0 | — |
| [BR-111](20-business-rules.md#br-111) | covered | 2 | `models/bank_transaction_spec.rb`, `services/enable_banking/transaction_normalizer_spec.rb` |
| [BR-115](20-business-rules.md#br-115) | covered | 4 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb`, `system/manual_sync_flow_spec.rb` |
| [BR-116](20-business-rules.md#br-116) | covered | 4 | `system/auto_sync_tick_spec.rb`, `system/manual_sync_flow_spec.rb` |
| [BR-117](20-business-rules.md#br-117) | covered | 2 | `system/manual_sync_flow_spec.rb` |
| [BR-118](20-business-rules.md#br-118) | partial | 1 | `system/manual_sync_flow_spec.rb` |
| [BR-119](20-business-rules.md#br-119) | untested | 0 | — |
| [BR-125](20-business-rules.md#br-125) | covered | 4 | `models/sync_schedule_spec.rb` |
| [BR-126](20-business-rules.md#br-126) | covered | 4 | `models/sync_schedule_spec.rb`, `services/auto_sync/dispatcher_spec.rb` |
| [BR-127](20-business-rules.md#br-127) | covered | 8 | `services/auto_sync/dispatcher_spec.rb`, `system/auto_sync_tick_spec.rb` |
| [BR-128](20-business-rules.md#br-128) | covered | 3 | `models/operation_run_spec.rb`, `services/auto_sync/dispatcher_spec.rb` |
| [BR-129](20-business-rules.md#br-129) | covered | 1 | `services/auto_sync/dispatcher_spec.rb` |
| [BR-130](20-business-rules.md#br-130) | covered | 8 | `services/auto_sync/next_run_calculator_spec.rb` |
| [BR-131](20-business-rules.md#br-131) | covered | 1 | `services/auto_sync/next_run_calculator_spec.rb` |
| [BR-132](20-business-rules.md#br-132) | covered | 10 | `requests/banking_spec.rb`, `services/auto_sync/schedule_upserter_spec.rb` |
| [BR-133](20-business-rules.md#br-133) | covered | 8 | `services/auto_sync/circuit_breaker_spec.rb`, `system/auto_sync_circuit_breaker_spec.rb` |
| [BR-134](20-business-rules.md#br-134) | covered | 2 | `services/auto_sync/circuit_breaker_spec.rb`, `system/auto_sync_circuit_breaker_spec.rb` |
| [BR-140](20-business-rules.md#br-140) | covered | 5 | `models/operation_run_spec.rb` |
| [BR-141](20-business-rules.md#br-141) | covered | 6 | `services/operation_run_finalizer_spec.rb`, `system/manual_sync_flow_spec.rb` |
| [BR-142](20-business-rules.md#br-142) | covered | 1 | `models/operation_run_spec.rb` |
| [BR-143](20-business-rules.md#br-143) | covered | 4 | `requests/api/v1/banking_spec.rb`, `requests/banking_spec.rb` |
| [BR-144](20-business-rules.md#br-144) | covered | 3 | `models/operation_run_spec.rb` |
| [BR-150](20-business-rules.md#br-150) | covered | 5 | `requests/settings_spec.rb`, `services/data_exchange/round_trip_spec.rb`, `system/data_exchange_round_trip_spec.rb` |
| [BR-151](20-business-rules.md#br-151) | covered | 1 | `services/data_exchange/round_trip_spec.rb` |
| [BR-152](20-business-rules.md#br-152) | covered | 3 | `services/data_exchange/round_trip_spec.rb`, `system/data_exchange_round_trip_spec.rb` |
| [BR-153](20-business-rules.md#br-153) | covered | 5 | `requests/settings_spec.rb`, `services/data_exchange/round_trip_spec.rb`, `system/data_exchange_round_trip_spec.rb` |
| [BR-154](20-business-rules.md#br-154) | covered | 6 | `requests/settings_spec.rb`, `services/data_exchange/round_trip_spec.rb`, `system/data_exchange_round_trip_spec.rb` |
| [BR-155](20-business-rules.md#br-155) | covered | 3 | `services/data_exchange/round_trip_spec.rb`, `system/data_exchange_round_trip_spec.rb` |
| [BR-156](20-business-rules.md#br-156) | covered | 2 | `requests/settings_spec.rb`, `services/data_exchange/round_trip_spec.rb` |
| [BR-157](20-business-rules.md#br-157) | untested | 0 | — |
| [BR-170](20-business-rules.md#br-170) | untested | 0 | — |
| [BR-171](20-business-rules.md#br-171) | untested | 0 | — |
| [BR-172](20-business-rules.md#br-172) | untested | 0 | — |
| [BR-173](20-business-rules.md#br-173) | untested | 0 | — |
| [BR-174](20-business-rules.md#br-174) | untested | 0 | — |
| [BR-175](20-business-rules.md#br-175) | untested | 0 | — |
| [BR-176](20-business-rules.md#br-176) | untested | 0 | — |
| [BR-180](20-business-rules.md#br-180) | covered | 5 | `models/bank_account_spec.rb`, `models/bank_connection_spec.rb`, `models/bank_transaction_spec.rb`, `models/tpp_credential_spec.rb` |
| [BR-200](20-business-rules.md#br-200) | covered | 2 | `models/ledger_entry_spec.rb` |
| [BR-201](20-business-rules.md#br-201) | covered | 2 | `models/category_spec.rb`, `models/ledger_entry_spec.rb` |
| [BR-202](20-business-rules.md#br-202) | covered | 4 | `models/category_spec.rb`, `requests/categorization_spec.rb`, `system/settings_change_spec.rb` |
| [BR-203](20-business-rules.md#br-203) | covered | 4 | `models/category_spec.rb`, `services/categories/creator_spec.rb`, `system/settings_change_spec.rb` |
| [BR-204](20-business-rules.md#br-204) | covered | 1 | `models/category_spec.rb` |
| [BR-205](20-business-rules.md#br-205) | covered | 6 | `requests/api/v1/categorization_spec.rb`, `requests/mcp/tools_spec.rb`, `services/categories/creator_spec.rb` |
| [BR-206](20-business-rules.md#br-206) | covered | 6 | `requests/api/v1/categorization_spec.rb`, `services/categories/mover_spec.rb` |
| [BR-207](20-business-rules.md#br-207) | covered | 2 | `models/category_spec.rb` |
| [BR-208](20-business-rules.md#br-208) | covered | 5 | `models/category_spec.rb`, `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb`, `system/settings_change_spec.rb` |
| [BR-209](20-business-rules.md#br-209) | covered | 3 | `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb` |
| [BR-210](20-business-rules.md#br-210) | covered | 3 | `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb` |
| [BR-211](20-business-rules.md#br-211) | covered | 5 | `models/user_hidden_category_spec.rb`, `models/user_spec.rb`, `requests/settings_spec.rb` |
| [BR-212](20-business-rules.md#br-212) | covered | 2 | `requests/categorization_spec.rb` |
| [BR-213](20-business-rules.md#br-213) | covered | 3 | `services/seeders/categories_spec.rb` |
| [BR-214](20-business-rules.md#br-214) | covered | 4 | `requests/onboarding_spec.rb` |
| [BR-215](20-business-rules.md#br-215) | covered | 4 | `models/merchant_spec.rb` |
| [BR-216](20-business-rules.md#br-216) | covered | 4 | `models/merchant_spec.rb`, `system/llm_enrichment_spec.rb` |
| [BR-217](20-business-rules.md#br-217) | covered | 3 | `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb` |
| [BR-218](20-business-rules.md#br-218) | covered | 3 | `models/concerns/ledger_entry_concern_spec.rb`, `requests/categorization_spec.rb` |
| [BR-219](20-business-rules.md#br-219) | covered | 1 | `requests/categorization_spec.rb` |
| [BR-220](20-business-rules.md#br-220) | covered | 3 | `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb` |
| [BR-221](20-business-rules.md#br-221) | covered | 8 | `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb`, `requests/mcp/tools_spec.rb`, `services/merchants/approver_spec.rb` |
| [BR-222](20-business-rules.md#br-222) | covered | 3 | `requests/categorization_spec.rb` |
| [BR-223](20-business-rules.md#br-223) | covered | 2 | `requests/categorization_spec.rb` |
| [BR-224](20-business-rules.md#br-224) | covered | 2 | `models/merchant_rule_spec.rb` |
| [BR-225](20-business-rules.md#br-225) | covered | 5 | `models/merchant_rule_spec.rb`, `services/enrichment/transaction_enricher_spec.rb` |
| [BR-226](20-business-rules.md#br-226) | covered | 6 | `models/merchant_rule_spec.rb`, `services/enrichment/transaction_enricher_spec.rb`, `system/categorization_workflow_spec.rb` |
| [BR-227](20-business-rules.md#br-227) | covered | 2 | `services/seeders/merchant_rules_spec.rb` |
| [BR-228](20-business-rules.md#br-228) | covered | 11 | `requests/categorization_spec.rb`, `services/merchant_rules/destroyer_spec.rb`, `services/merchant_rules/updater_spec.rb`, `system/categorization_workflow_spec.rb` |
| [BR-229](20-business-rules.md#br-229) | covered | 3 | `services/seeders/merchant_rules_spec.rb` |
| [BR-230](20-business-rules.md#br-230) | partial | 1 | `services/seeders/showcase_spec.rb` |
| [BR-231](20-business-rules.md#br-231) | covered | 7 | `models/concerns/ledger_entry_concern_spec.rb`, `models/transaction_enrichment_spec.rb` |
| [BR-232](20-business-rules.md#br-232) | covered | 10 | `models/concerns/ledger_entry_concern_spec.rb`, `models/ledger_entry_spec.rb`, `models/transaction_enrichment_spec.rb` |
| [BR-233](20-business-rules.md#br-233) | covered | 5 | `services/enrichment/transaction_enricher_spec.rb`, `system/categorization_workflow_spec.rb` |
| [BR-234](20-business-rules.md#br-234) | covered | 2 | `services/enrichment/transaction_enricher_spec.rb` |
| [BR-235](20-business-rules.md#br-235) | covered | 2 | `services/enrichment/transaction_enricher_spec.rb` |
| [BR-236](20-business-rules.md#br-236) | covered | 11 | `services/banking_spec.rb`, `services/enable_banking/operations/sync_account_transactions_spec.rb` |
| [BR-237](20-business-rules.md#br-237) | covered | 3 | `services/enrichment/classification_applier_spec.rb` |
| [BR-238](20-business-rules.md#br-238) | covered | 2 | `services/enrichment/classification_applier_spec.rb` |
| [BR-239](20-business-rules.md#br-239) | covered | 1 | `services/enrichment/classification_applier_spec.rb` |
| [BR-240](20-business-rules.md#br-240) | covered | 1 | `services/enrichment/classification_applier_spec.rb` |
| [BR-241](20-business-rules.md#br-241) | covered | 4 | `requests/categorization_spec.rb` |
| [BR-242](20-business-rules.md#br-242) | untested | 0 | — |
| [BR-243](20-business-rules.md#br-243) | covered | 1 | `requests/categorization_spec.rb` |
| [BR-244](20-business-rules.md#br-244) | covered | 3 | `models/llm_setting_spec.rb` |
| [BR-245](20-business-rules.md#br-245) | covered | 6 | `models/llm_setting_spec.rb` |
| [BR-246](20-business-rules.md#br-246) | covered | 4 | `requests/settings_spec.rb` |
| [BR-247](20-business-rules.md#br-247) | covered | 1 | `services/llm/connection_test_runner_spec.rb` |
| [BR-248](20-business-rules.md#br-248) | covered | 2 | `services/llm/clients/openai_spec.rb` |
| [BR-249](20-business-rules.md#br-249) | covered | 17 | `requests/settings_spec.rb`, `services/llm/connection_test_runner_spec.rb` |
| [BR-250](20-business-rules.md#br-250) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-251](20-business-rules.md#br-251) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-252](20-business-rules.md#br-252) | covered | 8 | `requests/api/v1/categorization_spec.rb`, `requests/categorization_spec.rb`, `system/cross_user_isolation_spec.rb`, `system/llm_enrichment_spec.rb` |
| [BR-253](20-business-rules.md#br-253) | covered | 3 | `system/llm_enrichment_spec.rb` |
| [BR-254](20-business-rules.md#br-254) | covered | 3 | `system/llm_enrichment_spec.rb` |
| [BR-255](20-business-rules.md#br-255) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-256](20-business-rules.md#br-256) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-257](20-business-rules.md#br-257) | covered | 2 | `system/llm_enrichment_spec.rb` |
| [BR-258](20-business-rules.md#br-258) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-259](20-business-rules.md#br-259) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-260](20-business-rules.md#br-260) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-261](20-business-rules.md#br-261) | covered | 1 | `system/llm_enrichment_spec.rb` |
| [BR-262](20-business-rules.md#br-262) | covered | 2 | `services/merchants/approver_spec.rb`, `system/llm_enrichment_spec.rb` |
| [BR-263](20-business-rules.md#br-263) | covered | 2 | `system/llm_enrichment_spec.rb` |
| [BR-264](20-business-rules.md#br-264) | covered | 5 | `services/enrichment/title_normalizer_spec.rb` |
| [BR-265](20-business-rules.md#br-265) | untested | 0 | — |
| [BR-266](20-business-rules.md#br-266) | covered | 7 | `services/seeders/showcase_spec.rb` |
| [BR-300](20-business-rules.md#br-300) | covered | 5 | `models/ledger_entry_spec.rb` |
| [BR-301](20-business-rules.md#br-301) | covered | 3 | `models/ledger_entry_spec.rb`, `models/manual_transaction_spec.rb` |
| [BR-302](20-business-rules.md#br-302) | covered | 6 | `models/concerns/ledger_entry_concern_spec.rb`, `models/ledger_entry_spec.rb` |
| [BR-303](20-business-rules.md#br-303) | covered | 3 | `models/ledger_entry_spec.rb`, `services/analytics/cash_flow_spec.rb` |
| [BR-304](20-business-rules.md#br-304) | covered | 1 | `models/ledger_entry_spec.rb` |
| [BR-305](20-business-rules.md#br-305) | covered | 4 | `models/ledger_entry_spec.rb`, `requests/api/v1/analytics_spec.rb`, `services/analytics/filter_spec.rb` |
| [BR-306](20-business-rules.md#br-306) | covered | 3 | `requests/analytics_spec.rb`, `services/analytics/filter_spec.rb` |
| [BR-307](20-business-rules.md#br-307) | covered | 3 | `models/ledger_entry_spec.rb`, `requests/analytics_spec.rb` |
| [BR-310](20-business-rules.md#br-310) | covered | 1 | `services/analytics/period_spec.rb` |
| [BR-311](20-business-rules.md#br-311) | covered | 4 | `requests/api/v1/analytics_spec.rb`, `services/analytics/filter_spec.rb`, `services/analytics/period_spec.rb` |
| [BR-312](20-business-rules.md#br-312) | covered | 1 | `services/analytics/filter_spec.rb` |
| [BR-313](20-business-rules.md#br-313) | covered | 4 | `services/analytics/cash_flow_spec.rb`, `services/analytics/period_spec.rb` |
| [BR-314](20-business-rules.md#br-314) | covered | 1 | `services/analytics/period_spec.rb` |
| [BR-315](20-business-rules.md#br-315) | untested | 0 | — |
| [BR-316](20-business-rules.md#br-316) | covered | 1 | `services/analytics/filter_spec.rb` |
| [BR-320](20-business-rules.md#br-320) | covered | 2 | `requests/api/v1/analytics_spec.rb`, `services/analytics/cash_flow_spec.rb` |
| [BR-321](20-business-rules.md#br-321) | partial | 1 | `requests/analytics_spec.rb` |
| [BR-322](20-business-rules.md#br-322) | untested | 0 | — |
| [BR-323](20-business-rules.md#br-323) | covered | 1 | `requests/analytics_spec.rb` |
| [BR-324](20-business-rules.md#br-324) | untested | 0 | — |
| [BR-325](20-business-rules.md#br-325) | covered | 1 | `requests/api/v1/analytics_spec.rb` |
| [BR-326](20-business-rules.md#br-326) | untested | 0 | — |
| [BR-327](20-business-rules.md#br-327) | covered | 4 | `requests/api/v1/analytics_spec.rb`, `services/analytics/top_merchants_spec.rb` |
| [BR-328](20-business-rules.md#br-328) | untested | 0 | — |
| [BR-329](20-business-rules.md#br-329) | untested | 0 | — |
| [BR-330](20-business-rules.md#br-330) | covered | 8 | `requests/analytics_spec.rb`, `requests/api/v1/analytics_spec.rb`, `system/daily_login_analytics_spec.rb` |
| [BR-331](20-business-rules.md#br-331) | covered | 7 | `requests/analytics_spec.rb`, `requests/api/v1/analytics_spec.rb` |
| [BR-332](20-business-rules.md#br-332) | covered | 2 | `system/daily_login_analytics_spec.rb` |
| [BR-333](20-business-rules.md#br-333) | covered | 2 | `requests/analytics_spec.rb` |
| [BR-334](20-business-rules.md#br-334) | covered | 1 | `system/daily_login_analytics_spec.rb` |
| [BR-340](20-business-rules.md#br-340) | covered | 6 | `services/cash/tracking_spec.rb`, `system/cash_with_atm_link_spec.rb` |
| [BR-341](20-business-rules.md#br-341) | covered | 2 | `services/cash/transaction_creator_spec.rb` |
| [BR-342](20-business-rules.md#br-342) | covered | 4 | `services/cash/transaction_creator_spec.rb`, `services/cash/transaction_updater_spec.rb` |
| [BR-343](20-business-rules.md#br-343) | covered | 8 | `requests/api/v1/transactions_spec.rb`, `requests/cash_spec.rb`, `services/cash/transaction_creator_spec.rb` |
| [BR-344](20-business-rules.md#br-344) | covered | 5 | `models/manual_transaction_spec.rb` |
| [BR-345](20-business-rules.md#br-345) | covered | 6 | `services/cash/transaction_creator_spec.rb`, `services/cash/transaction_updater_spec.rb` |
| [BR-346](20-business-rules.md#br-346) | untested | 0 | — |
| [BR-347](20-business-rules.md#br-347) | covered | 5 | `requests/api/v1/transactions_spec.rb`, `requests/cash_spec.rb`, `services/cash/transaction_updater_spec.rb` |
| [BR-348](20-business-rules.md#br-348) | covered | 10 | `requests/api/v1/transactions_spec.rb`, `requests/cash_spec.rb` |
| [BR-349](20-business-rules.md#br-349) | covered | 7 | `services/cash/atm_withdrawal_linker_spec.rb`, `system/cash_with_atm_link_spec.rb` |
| [BR-350](20-business-rules.md#br-350) | covered | 1 | `services/cash/tracking_spec.rb` |
| [BR-351](20-business-rules.md#br-351) | partial | 1 | `system/cash_with_atm_link_spec.rb` |
| [BR-352](20-business-rules.md#br-352) | covered | 6 | `requests/cash_spec.rb` |
| [BR-360](20-business-rules.md#br-360) | covered | 1 | `services/analytics/top_merchants_spec.rb` |
| [BR-361](20-business-rules.md#br-361) | untested | 0 | — |
| [BR-362](20-business-rules.md#br-362) | untested | 0 | — |
| [BR-363](20-business-rules.md#br-363) | untested | 0 | — |
| [BR-364](20-business-rules.md#br-364) | untested | 0 | — |
| [BR-365](20-business-rules.md#br-365) | untested | 0 | — |
| [BR-366](20-business-rules.md#br-366) | untested | 0 | — |
| [BR-367](20-business-rules.md#br-367) | covered | 1 | `requests/api/v1/transactions_spec.rb` |
| [BR-368](20-business-rules.md#br-368) | untested | 0 | — |
| [BR-369](20-business-rules.md#br-369) | covered | 4 | `requests/api/v1/transactions_spec.rb` |

</details>

---

## 4. Route coverage

Method **[I]** (static match over spec sources; the matched examples passed **[V]**): each example body (from its `it` line to the next
top-level `it`/`it_behaves_like`) in `spec/requests/**` and `spec/system/**` was scanned for
`get|post|patch|put|delete|visit|api_get|api_post|api_patch|api_delete` calls with a literal path (interpolations treated as one
segment) or a `*_path` helper. Helpers were mapped to URIs with the Prefix column of `../inventory/routes_development.txt`
(e.g. `admin_settings_preferences_test_llm_path` → `POST /admin/settings/preferences/llm/test`). Shared examples were resolved from
their `verb:`/`path:`/`path_for:` arguments; `mcp_call`/`mcp_tool_call` count as `POST /mcp`; Capybara `click_button` form submits
were mapped by button label to the form's action as rendered by the view (e.g. "Generate token" →
`POST /admin/settings/preferences/api_tokens`, `app/views/admin/settings/api_tokens/index.html.erb:34`; "Revoke"/"Delete" →
`DELETE /admin/settings/preferences/api_tokens/:id`, same file `:111-124`; "Add" → `POST /admin/merchants/:merchant_id/merchant_rules`,
`app/views/admin/merchants/show.html.erb:114`; "Save changes" on the category edit page → `PATCH /admin/categories/:id`). Smoke-crawler
examples are matched by the path in their description (`renders /admin/... (route_name)`). "Negative cases only" = every matching
example is a 404/foreign-record/unknown-id case (by description). The "Oracle cases" column links the runtime capture with its case count.

### 4.1 Routes

| Route key | 30-http-api.md | Spec coverage | Spec examples (file:line or rspec id) | Oracle cases |
|---|---|---|---|---:|
| `GET /admin/sign_in` | [route-get-admin-sign-in](30-http-api.md#route-get-admin-sign-in) | spec (request+system) | `requests/public_spec.rb:185`, `system/cash_with_atm_link_spec.rb:16`, `system/cash_with_atm_link_spec.rb:47`, `system/cash_with_atm_link_spec.rb:60` (+17) | [1](../oracle/http/GET_admin_sign_in.json) |
| `POST /admin/sign_in` | [route-post-admin-sign-in](30-http-api.md#route-post-admin-sign-in) | spec (request+system) | `requests/public_spec.rb:193`, `requests/public_spec.rb:201`, `system/cash_with_atm_link_spec.rb:16`, `system/cash_with_atm_link_spec.rb:47` (+17) | [3](../oracle/http/POST_admin_sign_in.json) |
| `DELETE /admin/sign_out` | [route-delete-admin-sign-out](30-http-api.md#route-delete-admin-sign-out) | spec (request) | `requests/public_spec.rb:208` | [2](../oracle/http/DELETE_admin_sign_out.json) |
| `GET /admin/password/new` | [route-get-admin-password-new](30-http-api.md#route-get-admin-password-new) | spec (request+system) | `requests/public_spec.rb:217`, `system/smoke/auth_spec.rb:49` | [1](../oracle/http/GET_admin_password_new.json) |
| `GET /admin/password/edit` | [route-get-admin-password-edit](30-http-api.md#route-get-admin-password-edit) | spec (request) | `requests/public_spec.rb:232` | [2](../oracle/http/GET_admin_password_edit.json) |
| `PATCH /admin/password` | [route-patch-admin-password](30-http-api.md#route-patch-admin-password) | **GAP** — no spec | — | [1](../oracle/http/PATCH_admin_password.json) |
| `PUT /admin/password` | [route-put-admin-password](30-http-api.md#route-put-admin-password) | **GAP** — neither PUT nor PATCH tested | — | [1](../oracle/http/PUT_admin_password.json) |
| `POST /admin/password` | [route-post-admin-password](30-http-api.md#route-post-admin-password) | spec (request) | `requests/public_spec.rb:224` | [2](../oracle/http/POST_admin_password.json) |
| `MOUNT /sidekiq` | [route-mount-sidekiq](30-http-api.md#route-mount-sidekiq) | no spec — out of scope (D-006 replaced by JobRunr dashboard (X-03)) | — | [2](../oracle/http/GET_sidekiq.json) |
| `GET /setup` | [route-get-setup](30-http-api.md#route-get-setup) | spec (request+system) | `requests/public_spec.rb:6`, `requests/public_spec.rb:14`, `requests/public_spec.rb:21`, `system/first_run_setup_spec.rb:25` (+6) | [2](../oracle/http/GET_setup.json) |
| `POST /setup` | [route-post-setup](30-http-api.md#route-post-setup) | spec (request+system) | `requests/public_spec.rb:29`, `requests/public_spec.rb:51`, `requests/public_spec.rb:67`, `requests/public_spec.rb:81` (+6) | [3](../oracle/http/POST_setup.json) |
| `GET /up` | [route-get-up](30-http-api.md#route-get-up) | **GAP** — no spec | — | [1](../oracle/http/GET_up.json) |
| `GET /callback` | [route-get-callback](30-http-api.md#route-get-callback) | spec (request+system) | `requests/public_spec.rb:110`, `requests/public_spec.rb:119`, `requests/public_spec.rb:129`, `requests/public_spec.rb:138` (+18) | [4](../oracle/http/GET_callback.json) |
| `GET /api/:version/docs` | [route-get-api-version-docs](30-http-api.md#route-get-api-version-docs) | **GAP** — no spec | — | [2](../oracle/http/GET_api__version_docs.json) |
| `GET /mcp` | [route-get-mcp](30-http-api.md#route-get-mcp) | spec (request) | `requests/mcp/protocol_spec.rb:83` | [1](../oracle/http/GET_mcp.json) |
| `POST /mcp` | [route-post-mcp](30-http-api.md#route-post-mcp) | spec (request+system) | `requests/mcp/protocol_spec.rb:101`, `requests/mcp/protocol_spec.rb:6`, `requests/mcp/protocol_spec.rb:13`, `requests/mcp/protocol_spec.rb:20` (+15) | [38](../oracle/http/POST_mcp.json) |
| `DELETE /mcp` | [route-delete-mcp](30-http-api.md#route-delete-mcp) | spec (request) | `requests/mcp/protocol_spec.rb:92` | [1](../oracle/http/DELETE_mcp.json) |
| `MOUNT /` | [route-mount-](30-http-api.md#route-mount-) | indirect — every `/api/v1` request spec passes through this mount | — | — |
| `GET /admin/debug` | [route-get-admin-debug](30-http-api.md#route-get-admin-debug) | no spec — out of scope (D-006 dev-only debug route (X-16)) | — | [1](../oracle/http/GET_admin_debug.json) |
| `GET /admin/debug/runtime_error` | [route-get-admin-debug-runtime-error](30-http-api.md#route-get-admin-debug-runtime-error) | no spec — out of scope (D-006 dev-only debug route (X-16)) | — | [1](../oracle/http/GET_admin_debug_runtime_error.json) |
| `GET /admin/debug/zero_division` | [route-get-admin-debug-zero-division](30-http-api.md#route-get-admin-debug-zero-division) | no spec — out of scope (D-006 dev-only debug route (X-16)) | — | [1](../oracle/http/GET_admin_debug_zero_division.json) |
| `GET /admin/debug/argument_error` | [route-get-admin-debug-argument-error](30-http-api.md#route-get-admin-debug-argument-error) | no spec — out of scope (D-006 dev-only debug route (X-16)) | — | [1](../oracle/http/GET_admin_debug_argument_error.json) |
| `GET /admin/debug/nested_error` | [route-get-admin-debug-nested-error](30-http-api.md#route-get-admin-debug-nested-error) | no spec — out of scope (D-006 dev-only debug route (X-16)) | — | [1](../oracle/http/GET_admin_debug_nested_error.json) |
| `POST /admin/debug/enqueue_failing_job` | [route-post-admin-debug-enqueue-failing-job](30-http-api.md#route-post-admin-debug-enqueue-failing-job) | no spec — out of scope (D-006 dev-only debug route (X-16)) | — | [1](../oracle/http/POST_admin_debug_enqueue_failing_job.json) |
| `GET /admin` | [route-get-admin](30-http-api.md#route-get-admin) | spec (smoke+system) | `system/smoke/admin_spec.rb[1:1]`, `system/smoke/auth_spec.rb:12` | [2](../oracle/http/GET_admin.json) |
| `GET /admin/styleguide` | [route-get-admin-styleguide](30-http-api.md#route-get-admin-styleguide) | spec (request+smoke) | `requests/meta_spec.rb:6`, `requests/meta_spec.rb:12`, `requests/public_spec.rb:208`, `system/smoke/admin_spec.rb[1:2]` | [1](../oracle/http/GET_admin_styleguide.json) |
| `POST /admin/onboarding/seed_taxonomy` | [route-post-admin-onboarding-seed-taxonomy](30-http-api.md#route-post-admin-onboarding-seed-taxonomy) | spec (request) | `requests/onboarding_spec.rb:6`, `requests/onboarding_spec.rb:22`, `requests/onboarding_spec.rb:34`, `requests/onboarding_spec.rb:49` | [1](../oracle/http/POST_admin_onboarding_seed_taxonomy.json) |
| `GET /admin/versions` | [route-get-admin-versions](30-http-api.md#route-get-admin-versions) | spec (request) | `requests/meta_spec.rb:21`, `requests/meta_spec.rb:55` | [2](../oracle/http/GET_admin_versions.json) |
| `GET /admin/versions/:id` | [route-get-admin-versions-id](30-http-api.md#route-get-admin-versions-id) | spec (request) | `requests/meta_spec.rb:30`, `requests/meta_spec.rb:46` | [2](../oracle/http/GET_admin_versions__id.json) |
| `PATCH /admin/bank_transactions/:bank_transaction_id/enrichment` | [route-patch-admin-bank-transactions-bank-transaction-id-enrichment](30-http-api.md#route-patch-admin-bank-transactions-bank-transaction-id-enrichment) | spec (request) | `requests/categorization_spec.rb:410`, `requests/categorization_spec.rb:432`, `requests/categorization_spec.rb:451`, `requests/categorization_spec.rb:467` | [1](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json) |
| `PUT /admin/bank_transactions/:bank_transaction_id/enrichment` | [route-put-admin-bank-transactions-bank-transaction-id-enrichment](30-http-api.md#route-put-admin-bank-transactions-bank-transaction-id-enrichment) | no spec — PUT alias of the PATCH action (PATCH is tested) | — | [1](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json) |
| `GET /admin/bank_transactions` | [route-get-admin-bank-transactions](30-http-api.md#route-get-admin-bank-transactions) | spec (request+smoke+system) | `requests/banking_spec.rb:354`, `requests/banking_spec.rb:370`, `system/categorization_workflow_spec.rb:16`, `system/cross_user_isolation_spec.rb:16` (+4) | [2](../oracle/http/GET_admin_bank_transactions.json) |
| `GET /admin/bank_transactions/:id` | [route-get-admin-bank-transactions-id](30-http-api.md#route-get-admin-bank-transactions-id) | spec (request+smoke+system) | `requests/banking_spec.rb:379`, `system/cross_user_isolation_spec.rb:58`, `system/smoke/admin_spec.rb[1:4]` | [2](../oracle/http/GET_admin_bank_transactions__id.json) |
| `GET /admin/cash_transactions` | [route-get-admin-cash-transactions](30-http-api.md#route-get-admin-cash-transactions) | spec (request+smoke+system) | `requests/cash_spec.rb:6`, `requests/cash_spec.rb:270`, `requests/cash_spec.rb:20`, `requests/cash_spec.rb:35` (+4) | [1](../oracle/http/GET_admin_cash_transactions.json) |
| `POST /admin/cash_transactions` | [route-post-admin-cash-transactions](30-http-api.md#route-post-admin-cash-transactions) | spec (request+system) | `requests/cash_spec.rb:119`, `requests/cash_spec.rb:135`, `requests/cash_spec.rb:150`, `requests/cash_spec.rb:96` (+1) | [2](../oracle/http/POST_admin_cash_transactions.json) |
| `GET /admin/cash_transactions/new` | [route-get-admin-cash-transactions-new](30-http-api.md#route-get-admin-cash-transactions-new) | spec (request+smoke+system) | `requests/cash_spec.rb:61`, `requests/cash_spec.rb:71`, `system/cash_with_atm_link_spec.rb:16`, `system/smoke/admin_spec.rb[1:6]` | [2](../oracle/http/GET_admin_cash_transactions_new.json) |
| `GET /admin/cash_transactions/:id/edit` | [route-get-admin-cash-transactions-id-edit](30-http-api.md#route-get-admin-cash-transactions-id-edit) | spec (request+smoke) | `requests/cash_spec.rb:163`, `requests/cash_spec.rb:173`, `system/smoke/admin_spec.rb[1:7]` | [1](../oracle/http/GET_admin_cash_transactions__id_edit.json) |
| `GET /admin/cash_transactions/:id` | [route-get-admin-cash-transactions-id](30-http-api.md#route-get-admin-cash-transactions-id) | spec (request+smoke) | `requests/cash_spec.rb:81`, `requests/cash_spec.rb[1:8:1]`, `requests/cash_spec.rb[1:8:2]`, `system/smoke/admin_spec.rb[1:8]` | [2](../oracle/http/GET_admin_cash_transactions__id.json) |
| `PATCH /admin/cash_transactions/:id` | [route-patch-admin-cash-transactions-id](30-http-api.md#route-patch-admin-cash-transactions-id) | spec (request) | `requests/cash_spec.rb:188`, `requests/cash_spec.rb:210`, `requests/cash_spec.rb:225` | [1](../oracle/http/PATCH_admin_cash_transactions__id.json) |
| `PUT /admin/cash_transactions/:id` | [route-put-admin-cash-transactions-id](30-http-api.md#route-put-admin-cash-transactions-id) | no spec — PUT alias of the PATCH action (PATCH is tested) | — | [1](../oracle/http/PUT_admin_cash_transactions__id.json) |
| `DELETE /admin/cash_transactions/:id` | [route-delete-admin-cash-transactions-id](30-http-api.md#route-delete-admin-cash-transactions-id) | spec (request) | `requests/cash_spec.rb:243`, `requests/cash_spec.rb:255` | [1](../oracle/http/DELETE_admin_cash_transactions__id.json) |
| `POST /admin/categories/:id/archive` | [route-post-admin-categories-id-archive](30-http-api.md#route-post-admin-categories-id-archive) | spec (request) | `requests/categorization_spec.rb:150` | [1](../oracle/http/POST_admin_categories__id_archive.json) |
| `POST /admin/categories/:id/unarchive` | [route-post-admin-categories-id-unarchive](30-http-api.md#route-post-admin-categories-id-unarchive) | spec (request) | `requests/categorization_spec.rb:161` | [1](../oracle/http/POST_admin_categories__id_unarchive.json) |
| `GET /admin/categories` | [route-get-admin-categories](30-http-api.md#route-get-admin-categories) | spec (request+smoke+system) | `requests/categorization_spec.rb:6`, `requests/categorization_spec.rb:537`, `system/cross_user_isolation_spec.rb:68`, `system/settings_change_spec.rb:16` (+2) | [1](../oracle/http/GET_admin_categories.json) |
| `POST /admin/categories` | [route-post-admin-categories](30-http-api.md#route-post-admin-categories) | spec (request) | `requests/categorization_spec.rb:29`, `requests/categorization_spec.rb:47` | [3](../oracle/http/POST_admin_categories.json) |
| `GET /admin/categories/new` | [route-get-admin-categories-new](30-http-api.md#route-get-admin-categories-new) | spec (request+smoke) | `requests/categorization_spec.rb:20`, `system/smoke/admin_spec.rb[1:10]` | [1](../oracle/http/GET_admin_categories_new.json) |
| `GET /admin/categories/:id/edit` | [route-get-admin-categories-id-edit](30-http-api.md#route-get-admin-categories-id-edit) | spec (request+smoke+system) | `requests/categorization_spec.rb:61`, `requests/categorization_spec.rb:71`, `requests/categorization_spec.rb:82`, `system/settings_change_spec.rb:16` (+3) | [2](../oracle/http/GET_admin_categories__id_edit.json) |
| `PATCH /admin/categories/:id` | [route-patch-admin-categories-id](30-http-api.md#route-patch-admin-categories-id) | spec (request+system) | `requests/categorization_spec.rb:94`, `requests/categorization_spec.rb:111`, `system/settings_change_spec.rb:16`, `system/settings_change_spec.rb:86` (+1) | [1](../oracle/http/PATCH_admin_categories__id.json) |
| `PUT /admin/categories/:id` | [route-put-admin-categories-id](30-http-api.md#route-put-admin-categories-id) | no spec — PUT alias of the PATCH action (PATCH is tested) | — | [1](../oracle/http/PUT_admin_categories__id.json) |
| `DELETE /admin/categories/:id` | [route-delete-admin-categories-id](30-http-api.md#route-delete-admin-categories-id) | spec (request) | `requests/categorization_spec.rb:125`, `requests/categorization_spec.rb:138` | [2](../oracle/http/DELETE_admin_categories__id.json) |
| `POST /admin/merchants/:id/archive` | [route-post-admin-merchants-id-archive](30-http-api.md#route-post-admin-merchants-id-archive) | spec (request) | `requests/categorization_spec.rb:324` | [1](../oracle/http/POST_admin_merchants__id_archive.json) |
| `POST /admin/merchants/:id/unarchive` | [route-post-admin-merchants-id-unarchive](30-http-api.md#route-post-admin-merchants-id-unarchive) | **GAP** — no spec | — | [1](../oracle/http/POST_admin_merchants__id_unarchive.json) |
| `POST /admin/merchants/:id/approve` | [route-post-admin-merchants-id-approve](30-http-api.md#route-post-admin-merchants-id-approve) | spec (request) | `requests/categorization_spec.rb:334` | [1](../oracle/http/POST_admin_merchants__id_approve.json) |
| `POST /admin/merchants/:merchant_id/merchant_rules` | [route-post-admin-merchants-merchant-id-merchant-rules](30-http-api.md#route-post-admin-merchants-merchant-id-merchant-rules) | spec (request+system) | `requests/categorization_spec.rb:348`, `requests/categorization_spec.rb:365`, `system/categorization_workflow_spec.rb:16`, `system/categorization_workflow_spec.rb:57` (+1) | [2](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json) |
| `PATCH /admin/merchants/:merchant_id/merchant_rules/:id` | [route-patch-admin-merchants-merchant-id-merchant-rules-id](30-http-api.md#route-patch-admin-merchants-merchant-id-merchant-rules-id) | spec (request) | `requests/categorization_spec.rb:380` | [1](../oracle/http/PATCH_admin_merchants__merchant_id_merchant_rules__id.json) |
| `PUT /admin/merchants/:merchant_id/merchant_rules/:id` | [route-put-admin-merchants-merchant-id-merchant-rules-id](30-http-api.md#route-put-admin-merchants-merchant-id-merchant-rules-id) | no spec — PUT alias of the PATCH action (PATCH is tested) | — | [1](../oracle/http/PUT_admin_merchants__merchant_id_merchant_rules__id.json) |
| `DELETE /admin/merchants/:merchant_id/merchant_rules/:id` | [route-delete-admin-merchants-merchant-id-merchant-rules-id](30-http-api.md#route-delete-admin-merchants-merchant-id-merchant-rules-id) | spec (request) | `requests/categorization_spec.rb:396` | [1](../oracle/http/DELETE_admin_merchants__merchant_id_merchant_rules__id.json) |
| `GET /admin/merchants` | [route-get-admin-merchants](30-http-api.md#route-get-admin-merchants) | spec (request+smoke) | `requests/categorization_spec.rb:172`, `requests/categorization_spec.rb:186`, `requests/categorization_spec.rb:198`, `system/smoke/admin_spec.rb[1:12]` | [2](../oracle/http/GET_admin_merchants.json) |
| `POST /admin/merchants` | [route-post-admin-merchants](30-http-api.md#route-post-admin-merchants) | spec (request+system) | `requests/categorization_spec.rb:244`, `requests/categorization_spec.rb:259`, `system/categorization_workflow_spec.rb:16`, `system/categorization_workflow_spec.rb:57` (+1) | [2](../oracle/http/POST_admin_merchants.json) |
| `GET /admin/merchants/new` | [route-get-admin-merchants-new](30-http-api.md#route-get-admin-merchants-new) | spec (smoke+system) | `system/categorization_workflow_spec.rb:16`, `system/categorization_workflow_spec.rb:57`, `system/categorization_workflow_spec.rb:103`, `system/smoke/admin_spec.rb[1:13]` | [1](../oracle/http/GET_admin_merchants_new.json) |
| `GET /admin/merchants/:id/edit` | [route-get-admin-merchants-id-edit](30-http-api.md#route-get-admin-merchants-id-edit) | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:14]` | [1](../oracle/http/GET_admin_merchants__id_edit.json) |
| `GET /admin/merchants/:id` | [route-get-admin-merchants-id](30-http-api.md#route-get-admin-merchants-id) | spec (request+smoke) | `requests/categorization_spec.rb:210`, `requests/categorization_spec.rb:220`, `requests/categorization_spec.rb:231`, `system/smoke/admin_spec.rb[1:15]` | [2](../oracle/http/GET_admin_merchants__id.json) |
| `PATCH /admin/merchants/:id` | [route-patch-admin-merchants-id](30-http-api.md#route-patch-admin-merchants-id) | spec (request) | `requests/categorization_spec.rb:273`, `requests/categorization_spec.rb:286` | [2](../oracle/http/PATCH_admin_merchants__id.json) |
| `PUT /admin/merchants/:id` | [route-put-admin-merchants-id](30-http-api.md#route-put-admin-merchants-id) | no spec — PUT alias of the PATCH action (PATCH is tested) | — | [1](../oracle/http/PUT_admin_merchants__id.json) |
| `DELETE /admin/merchants/:id` | [route-delete-admin-merchants-id](30-http-api.md#route-delete-admin-merchants-id) | spec (request) | `requests/categorization_spec.rb:299`, `requests/categorization_spec.rb:314` | [1](../oracle/http/DELETE_admin_merchants__id.json) |
| `GET /admin/llm_enrichments` | [route-get-admin-llm-enrichments](30-http-api.md#route-get-admin-llm-enrichments) | spec (request+smoke+system) | `requests/categorization_spec.rb:479`, `system/llm_enrichment_spec.rb:16`, `system/llm_enrichment_spec.rb:67`, `system/llm_enrichment_spec.rb:91` (+2) | [1](../oracle/http/GET_admin_llm_enrichments.json) |
| `POST /admin/llm_enrichments` | [route-post-admin-llm-enrichments](30-http-api.md#route-post-admin-llm-enrichments) | spec (request+system) | `requests/categorization_spec.rb:494`, `requests/categorization_spec.rb:506`, `system/llm_enrichment_spec.rb:16`, `system/llm_enrichment_spec.rb:67` (+2) | [1](../oracle/http/POST_admin_llm_enrichments.json) |
| `GET /admin/llm_enrichments/:id` | [route-get-admin-llm-enrichments-id](30-http-api.md#route-get-admin-llm-enrichments-id) | spec — negative cases only | `system/cross_user_isolation_spec.rb:83` | [1](../oracle/http/GET_admin_llm_enrichments__id.json) |
| `GET /admin/analytics` | [route-get-admin-analytics](30-http-api.md#route-get-admin-analytics) | spec (request+smoke+system) | `requests/analytics_spec.rb:140`, `requests/analytics_spec.rb:6`, `requests/analytics_spec.rb:15`, `requests/analytics_spec.rb:24` (+6) | [5](../oracle/http/GET_admin_analytics.json) |
| `GET /admin/analytics/categories/:slug` | [route-get-admin-analytics-categories-slug](30-http-api.md#route-get-admin-analytics-categories-slug) | spec (request+smoke+system) | `requests/analytics_spec.rb:55`, `requests/analytics_spec.rb:65`, `requests/analytics_spec.rb:74`, `requests/analytics_spec.rb:85` (+3) | [2](../oracle/http/GET_admin_analytics_categories__slug.json) |
| `GET /admin/analytics/merchants/:slug` | [route-get-admin-analytics-merchants-slug](30-http-api.md#route-get-admin-analytics-merchants-slug) | spec (request+smoke) | `requests/analytics_spec.rb:97`, `requests/analytics_spec.rb:107`, `requests/analytics_spec.rb:116`, `requests/analytics_spec.rb:127` (+1) | [1](../oracle/http/GET_admin_analytics_merchants__slug.json) |
| `GET /admin/matching_engine` | [route-get-admin-matching-engine](30-http-api.md#route-get-admin-matching-engine) | spec (request+smoke) | `requests/categorization_spec.rb:522`, `system/smoke/admin_spec.rb[1:20]` | [1](../oracle/http/GET_admin_matching_engine.json) |
| `GET /admin/transaction_syncs` | [route-get-admin-transaction-syncs](30-http-api.md#route-get-admin-transaction-syncs) | spec (request+smoke+system) | `requests/banking_spec.rb:390`, `system/auto_sync_circuit_breaker_spec.rb:17`, `system/manual_sync_flow_spec.rb:114`, `system/smoke/admin_spec.rb[1:21]` | [1](../oracle/http/GET_admin_transaction_syncs.json) |
| `POST /admin/transaction_syncs` | [route-post-admin-transaction-syncs](30-http-api.md#route-post-admin-transaction-syncs) | spec (request+system) | `requests/banking_spec.rb:429`, `requests/banking_spec.rb:446`, `system/auto_sync_circuit_breaker_spec.rb:83`, `system/first_time_setup_spec.rb:55` (+2) | [2](../oracle/http/POST_admin_transaction_syncs.json) |
| `GET /admin/transaction_syncs/new` | [route-get-admin-transaction-syncs-new](30-http-api.md#route-get-admin-transaction-syncs-new) | spec (request+smoke+system) | `requests/banking_spec.rb:415`, `system/auto_sync_circuit_breaker_spec.rb:83`, `system/first_time_setup_spec.rb:55`, `system/manual_sync_flow_spec.rb:16` (+2) | [1](../oracle/http/GET_admin_transaction_syncs_new.json) |
| `GET /admin/transaction_syncs/:id` | [route-get-admin-transaction-syncs-id](30-http-api.md#route-get-admin-transaction-syncs-id) | spec (request+smoke) | `requests/banking_spec.rb:404`, `system/smoke/admin_spec.rb[1:23]` | [1](../oracle/http/GET_admin_transaction_syncs__id.json) |
| `POST /admin/tpp_credentials/:id/test_connection` | [route-post-admin-tpp-credentials-id-test-connection](30-http-api.md#route-post-admin-tpp-credentials-id-test-connection) | spec (request) | `requests/banking_spec.rb:126`, `requests/banking_spec.rb:111` | [1](../oracle/http/POST_admin_tpp_credentials__id_test_connection.json) |
| `POST /admin/tpp_credentials/:id/make_primary` | [route-post-admin-tpp-credentials-id-make-primary](30-http-api.md#route-post-admin-tpp-credentials-id-make-primary) | spec (request) | `requests/banking_spec.rb:140` | [1](../oracle/http/POST_admin_tpp_credentials__id_make_primary.json) |
| `GET /admin/tpp_credentials` | [route-get-admin-tpp-credentials](30-http-api.md#route-get-admin-tpp-credentials) | spec (request+smoke) | `requests/banking_spec.rb:6`, `system/smoke/admin_spec.rb[1:24]` | [1](../oracle/http/GET_admin_tpp_credentials.json) |
| `POST /admin/tpp_credentials` | [route-post-admin-tpp-credentials](30-http-api.md#route-post-admin-tpp-credentials) | spec (request+system) | `requests/banking_spec.rb:35`, `requests/banking_spec.rb:55`, `requests/banking_spec.rb:75`, `system/first_time_setup_spec.rb:55` | [2](../oracle/http/POST_admin_tpp_credentials.json) |
| `GET /admin/tpp_credentials/new` | [route-get-admin-tpp-credentials-new](30-http-api.md#route-get-admin-tpp-credentials-new) | spec (request+smoke+system) | `requests/banking_spec.rb:25`, `system/first_time_setup_spec.rb:55`, `system/smoke/admin_spec.rb[1:25]` | [1](../oracle/http/GET_admin_tpp_credentials_new.json) |
| `GET /admin/tpp_credentials/:id/edit` | [route-get-admin-tpp-credentials-id-edit](30-http-api.md#route-get-admin-tpp-credentials-id-edit) | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:26]` | [1](../oracle/http/GET_admin_tpp_credentials__id_edit.json) |
| `GET /admin/tpp_credentials/:id` | [route-get-admin-tpp-credentials-id](30-http-api.md#route-get-admin-tpp-credentials-id) | spec (request+smoke+system) | `requests/banking_spec.rb[1:2:1]`, `requests/banking_spec.rb[1:2:2]`, `system/cross_user_isolation_spec.rb:38`, `system/smoke/admin_spec.rb[1:27]` | [2](../oracle/http/GET_admin_tpp_credentials__id.json) |
| `PATCH /admin/tpp_credentials/:id` | [route-patch-admin-tpp-credentials-id](30-http-api.md#route-patch-admin-tpp-credentials-id) | **GAP** — no spec | — | [1](../oracle/http/PATCH_admin_tpp_credentials__id.json) |
| `PUT /admin/tpp_credentials/:id` | [route-put-admin-tpp-credentials-id](30-http-api.md#route-put-admin-tpp-credentials-id) | **GAP** — neither PUT nor PATCH tested | — | [1](../oracle/http/PUT_admin_tpp_credentials__id.json) |
| `DELETE /admin/tpp_credentials/:id` | [route-delete-admin-tpp-credentials-id](30-http-api.md#route-delete-admin-tpp-credentials-id) | spec (request) | `requests/banking_spec.rb:87`, `requests/banking_spec.rb:100` | [1](../oracle/http/DELETE_admin_tpp_credentials__id.json) |
| `POST /admin/bank_connections/:id/refresh` | [route-post-admin-bank-connections-id-refresh](30-http-api.md#route-post-admin-bank-connections-id-refresh) | spec (request) | `requests/banking_spec.rb:275` | [1](../oracle/http/POST_admin_bank_connections__id_refresh.json) |
| `POST /admin/bank_connections/:id/reauth` | [route-post-admin-bank-connections-id-reauth](30-http-api.md#route-post-admin-bank-connections-id-reauth) | spec (request+system) | `requests/banking_spec.rb:288`, `system/connection_expiry_reauth_spec.rb:16` | [1](../oracle/http/POST_admin_bank_connections__id_reauth.json) |
| `GET /admin/bank_connections/:bank_connection_id/sync_schedule/edit` | [route-get-admin-bank-connections-bank-connection-id-sync-schedule-edit](30-http-api.md#route-get-admin-bank-connections-bank-connection-id-sync-schedule-edit) | spec (request+smoke) | `requests/banking_spec.rb:458`, `requests/banking_spec.rb:469`, `system/smoke/admin_spec.rb[1:28]` | [1](../oracle/http/GET_admin_bank_connections__bank_connection_id_sync_schedule_edit.json) |
| `PATCH /admin/bank_connections/:bank_connection_id/sync_schedule` | [route-patch-admin-bank-connections-bank-connection-id-sync-schedule](30-http-api.md#route-patch-admin-bank-connections-bank-connection-id-sync-schedule) | spec (request) | `requests/banking_spec.rb:480`, `requests/banking_spec.rb:502` | [1](../oracle/http/PATCH_admin_bank_connections__bank_connection_id_sync_schedule.json) |
| `PUT /admin/bank_connections/:bank_connection_id/sync_schedule` | [route-put-admin-bank-connections-bank-connection-id-sync-schedule](30-http-api.md#route-put-admin-bank-connections-bank-connection-id-sync-schedule) | no spec — PUT alias of the PATCH action (PATCH is tested) | — | [1](../oracle/http/PUT_admin_bank_connections__bank_connection_id_sync_schedule.json) |
| `GET /admin/bank_connections` | [route-get-admin-bank-connections](30-http-api.md#route-get-admin-bank-connections) | spec (request+smoke) | `requests/banking_spec.rb:153`, `requests/banking_spec.rb:518`, `system/smoke/admin_spec.rb[1:29]` | [1](../oracle/http/GET_admin_bank_connections.json) |
| `POST /admin/bank_connections` | [route-post-admin-bank-connections](30-http-api.md#route-post-admin-bank-connections) | spec (request) | `requests/banking_spec.rb:227`, `requests/banking_spec.rb:243` | [2](../oracle/http/POST_admin_bank_connections.json) |
| `GET /admin/bank_connections/new` | [route-get-admin-bank-connections-new](30-http-api.md#route-get-admin-bank-connections-new) | spec (request+smoke+system) | `requests/banking_spec.rb:172`, `requests/banking_spec.rb:182`, `requests/banking_spec.rb:199`, `requests/banking_spec.rb:212` (+2) | [2](../oracle/http/GET_admin_bank_connections_new.json) |
| `GET /admin/bank_connections/:id/edit` | [route-get-admin-bank-connections-id-edit](30-http-api.md#route-get-admin-bank-connections-id-edit) | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:31]` | [1](../oracle/http/GET_admin_bank_connections__id_edit.json) |
| `GET /admin/bank_connections/:id` | [route-get-admin-bank-connections-id](30-http-api.md#route-get-admin-bank-connections-id) | spec (request+smoke+system) | `requests/banking_spec.rb[1:13:1]`, `requests/banking_spec.rb[1:13:2]`, `system/connection_expiry_reauth_spec.rb:16`, `system/cross_user_isolation_spec.rb:28` (+1) | [2](../oracle/http/GET_admin_bank_connections__id.json) |
| `PATCH /admin/bank_connections/:id` | [route-patch-admin-bank-connections-id](30-http-api.md#route-patch-admin-bank-connections-id) | **GAP** — no spec | — | [1](../oracle/http/PATCH_admin_bank_connections__id.json) |
| `PUT /admin/bank_connections/:id` | [route-put-admin-bank-connections-id](30-http-api.md#route-put-admin-bank-connections-id) | **GAP** — neither PUT nor PATCH tested | — | [1](../oracle/http/PUT_admin_bank_connections__id.json) |
| `DELETE /admin/bank_connections/:id` | [route-delete-admin-bank-connections-id](30-http-api.md#route-delete-admin-bank-connections-id) | spec (request) | `requests/banking_spec.rb:262` | [2](../oracle/http/DELETE_admin_bank_connections__id.json) |
| `POST /admin/bank_accounts/:id/refresh_details` | [route-post-admin-bank-accounts-id-refresh-details](30-http-api.md#route-post-admin-bank-accounts-id-refresh-details) | spec (request) | `requests/banking_spec.rb:328` | [1](../oracle/http/POST_admin_bank_accounts__id_refresh_details.json) |
| `POST /admin/bank_accounts/:id/refresh_balances` | [route-post-admin-bank-accounts-id-refresh-balances](30-http-api.md#route-post-admin-bank-accounts-id-refresh-balances) | spec (request) | `requests/banking_spec.rb:341` | [1](../oracle/http/POST_admin_bank_accounts__id_refresh_balances.json) |
| `GET /admin/bank_accounts` | [route-get-admin-bank-accounts](30-http-api.md#route-get-admin-bank-accounts) | spec (request+smoke) | `requests/banking_spec.rb:303`, `system/smoke/admin_spec.rb[1:33]` | [1](../oracle/http/GET_admin_bank_accounts.json) |
| `GET /admin/bank_accounts/:id` | [route-get-admin-bank-accounts-id](30-http-api.md#route-get-admin-bank-accounts-id) | spec (request+smoke+system) | `requests/banking_spec.rb:317`, `system/cross_user_isolation_spec.rb:48`, `system/smoke/admin_spec.rb[1:34]` | [1](../oracle/http/GET_admin_bank_accounts__id.json) |
| `GET /admin/settings` | [route-get-admin-settings](30-http-api.md#route-get-admin-settings) | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:35]` | [1](../oracle/http/GET_admin_settings.json) |
| `GET /admin/settings/preferences` | [route-get-admin-settings-preferences](30-http-api.md#route-get-admin-settings-preferences) | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:36]` | [1](../oracle/http/GET_admin_settings_preferences.json) |
| `GET /admin/settings/preferences/profile` | [route-get-admin-settings-preferences-profile](30-http-api.md#route-get-admin-settings-preferences-profile) | spec (request+smoke+system) | `requests/settings_spec.rb:6`, `requests/settings_spec.rb:426`, `requests/settings_spec.rb:36`, `system/smoke/admin_spec.rb[1:37]` (+1) | [1](../oracle/http/GET_admin_settings_preferences_profile.json) |
| `PATCH /admin/settings/preferences/profile` | [route-patch-admin-settings-preferences-profile](30-http-api.md#route-patch-admin-settings-preferences-profile) | spec (request) | `requests/settings_spec.rb:15`, `requests/settings_spec.rb:26` | [2](../oracle/http/PATCH_admin_settings_preferences_profile.json) |
| `PATCH /admin/settings/preferences/password` | [route-patch-admin-settings-preferences-password](30-http-api.md#route-patch-admin-settings-preferences-password) | spec (request) | `requests/settings_spec.rb:36`, `requests/settings_spec.rb:54` | [2](../oracle/http/PATCH_admin_settings_preferences_password.json) |
| `GET /admin/settings/preferences/app` | [route-get-admin-settings-preferences-app](30-http-api.md#route-get-admin-settings-preferences-app) | spec (request+smoke) | `requests/settings_spec.rb:70`, `system/smoke/admin_spec.rb[1:38]` | [1](../oracle/http/GET_admin_settings_preferences_app.json) |
| `PATCH /admin/settings/preferences/app` | [route-patch-admin-settings-preferences-app](30-http-api.md#route-patch-admin-settings-preferences-app) | spec (request) | `requests/settings_spec.rb:116`, `requests/settings_spec.rb:79`, `requests/settings_spec.rb:90`, `requests/settings_spec.rb:106` | [1](../oracle/http/PATCH_admin_settings_preferences_app.json) |
| `GET /admin/settings/preferences/llm` | [route-get-admin-settings-preferences-llm](30-http-api.md#route-get-admin-settings-preferences-llm) | spec (request+smoke) | `requests/settings_spec.rb:127`, `system/smoke/admin_spec.rb[1:39]` | [1](../oracle/http/GET_admin_settings_preferences_llm.json) |
| `PATCH /admin/settings/preferences/llm` | [route-patch-admin-settings-preferences-llm](30-http-api.md#route-patch-admin-settings-preferences-llm) | spec (request) | `requests/settings_spec.rb:136`, `requests/settings_spec.rb:149`, `requests/settings_spec.rb:164` | [2](../oracle/http/PATCH_admin_settings_preferences_llm.json) |
| `POST /admin/settings/preferences/llm/test` | [route-post-admin-settings-preferences-llm-test](30-http-api.md#route-post-admin-settings-preferences-llm-test) | spec (request) | `requests/settings_spec.rb:176`, `requests/settings_spec.rb:186`, `requests/settings_spec.rb:200` | [1](../oracle/http/POST_admin_settings_preferences_llm_test.json) |
| `GET /admin/settings/preferences/data_exchange` | [route-get-admin-settings-preferences-data-exchange](30-http-api.md#route-get-admin-settings-preferences-data-exchange) | spec (request+smoke+system) | `requests/settings_spec.rb:213`, `system/data_exchange_round_trip_spec.rb:16`, `system/data_exchange_round_trip_spec.rb:29`, `system/data_exchange_round_trip_spec.rb:51` (+3) | [1](../oracle/http/GET_admin_settings_preferences_data_exchange.json) |
| `POST /admin/settings/preferences/data_exchange/export` | [route-post-admin-settings-preferences-data-exchange-export](30-http-api.md#route-post-admin-settings-preferences-data-exchange-export) | spec (request+system) | `requests/settings_spec.rb:222`, `requests/settings_spec.rb:238`, `system/data_exchange_round_trip_spec.rb:29` | [2](../oracle/http/POST_admin_settings_preferences_data_exchange_export.json) |
| `POST /admin/settings/preferences/data_exchange/import` | [route-post-admin-settings-preferences-data-exchange-import](30-http-api.md#route-post-admin-settings-preferences-data-exchange-import) | spec (request+system) | `requests/settings_spec.rb:250`, `requests/settings_spec.rb:260`, `requests/settings_spec.rb:284`, `system/data_exchange_round_trip_spec.rb:51` (+2) | [2](../oracle/http/POST_admin_settings_preferences_data_exchange_import.json) |
| `GET /admin/settings/preferences/api_tokens` | [route-get-admin-settings-preferences-api-tokens](30-http-api.md#route-get-admin-settings-preferences-api-tokens) | spec (request+smoke+system) | `requests/settings_spec.rb:299`, `requests/settings_spec.rb:308`, `requests/settings_spec.rb:325`, `system/personal_access_token_lifecycle_spec.rb:16` (+4) | [1](../oracle/http/GET_admin_settings_preferences_api_tokens.json) |
| `POST /admin/settings/preferences/api_tokens` | [route-post-admin-settings-preferences-api-tokens](30-http-api.md#route-post-admin-settings-preferences-api-tokens) | spec (request+system) | `requests/settings_spec.rb:325`, `requests/settings_spec.rb:348`, `requests/settings_spec.rb:363`, `system/personal_access_token_lifecycle_spec.rb:16` (+3) | [2](../oracle/http/POST_admin_settings_preferences_api_tokens.json) |
| `DELETE /admin/settings/preferences/api_tokens/:id` | [route-delete-admin-settings-preferences-api-tokens-id](30-http-api.md#route-delete-admin-settings-preferences-api-tokens-id) | spec (request+system) | `requests/settings_spec.rb:384`, `requests/settings_spec.rb:399`, `requests/settings_spec.rb[1:31:1]`, `requests/settings_spec.rb[1:31:2]` (+1) | [2](../oracle/http/DELETE_admin_settings_preferences_api_tokens__id.json) |
| `GET /` | [route-get-root](30-http-api.md#route-get-root) | spec (system) | `system/first_run_setup_spec.rb:16`, `system/first_time_setup_spec.rb:16` | [1](../oracle/http/GET_root.json) |
| `GET /recede_historical_location` | [route-get-recede-historical-location](30-http-api.md#route-get-recede-historical-location) | no spec — out of scope (D-006 Turbo Native route (X-16)) | — | [1](../oracle/http/GET_recede_historical_location.json) |
| `GET /resume_historical_location` | [route-get-resume-historical-location](30-http-api.md#route-get-resume-historical-location) | no spec — out of scope (D-006 Turbo Native route (X-16)) | — | [1](../oracle/http/GET_resume_historical_location.json) |
| `GET /refresh_historical_location` | [route-get-refresh-historical-location](30-http-api.md#route-get-refresh-historical-location) | no spec — out of scope (D-006 Turbo Native route (X-16)) | — | [1](../oracle/http/GET_refresh_historical_location.json) |
| `POST /rails/action_mailbox/postmark/inbound_emails` | [route-post-rails-action-mailbox-postmark-inbound-emails](30-http-api.md#route-post-rails-action-mailbox-postmark-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_action_mailbox_postmark_inbound_emails.json) |
| `POST /rails/action_mailbox/relay/inbound_emails` | [route-post-rails-action-mailbox-relay-inbound-emails](30-http-api.md#route-post-rails-action-mailbox-relay-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_action_mailbox_relay_inbound_emails.json) |
| `POST /rails/action_mailbox/sendgrid/inbound_emails` | [route-post-rails-action-mailbox-sendgrid-inbound-emails](30-http-api.md#route-post-rails-action-mailbox-sendgrid-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_action_mailbox_sendgrid_inbound_emails.json) |
| `GET /rails/action_mailbox/mandrill/inbound_emails` | [route-get-rails-action-mailbox-mandrill-inbound-emails](30-http-api.md#route-get-rails-action-mailbox-mandrill-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_action_mailbox_mandrill_inbound_emails.json) |
| `POST /rails/action_mailbox/mandrill/inbound_emails` | [route-post-rails-action-mailbox-mandrill-inbound-emails](30-http-api.md#route-post-rails-action-mailbox-mandrill-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_action_mailbox_mandrill_inbound_emails.json) |
| `POST /rails/action_mailbox/mailgun/inbound_emails/mime` | [route-post-rails-action-mailbox-mailgun-inbound-emails-mime](30-http-api.md#route-post-rails-action-mailbox-mailgun-inbound-emails-mime) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_action_mailbox_mailgun_inbound_emails_mime.json) |
| `GET /rails/conductor/action_mailbox/inbound_emails` | [route-get-rails-conductor-action-mailbox-inbound-emails](30-http-api.md#route-get-rails-conductor-action-mailbox-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails.json) |
| `POST /rails/conductor/action_mailbox/inbound_emails` | [route-post-rails-conductor-action-mailbox-inbound-emails](30-http-api.md#route-post-rails-conductor-action-mailbox-inbound-emails) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_conductor_action_mailbox_inbound_emails.json) |
| `GET /rails/conductor/action_mailbox/inbound_emails/new` | [route-get-rails-conductor-action-mailbox-inbound-emails-new](30-http-api.md#route-get-rails-conductor-action-mailbox-inbound-emails-new) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails_new.json) |
| `GET /rails/conductor/action_mailbox/inbound_emails/:id` | [route-get-rails-conductor-action-mailbox-inbound-emails-id](30-http-api.md#route-get-rails-conductor-action-mailbox-inbound-emails-id) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails__id.json) |
| `GET /rails/conductor/action_mailbox/inbound_emails/sources/new` | [route-get-rails-conductor-action-mailbox-inbound-emails-sources-new](30-http-api.md#route-get-rails-conductor-action-mailbox-inbound-emails-sources-new) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails_sources_new.json) |
| `POST /rails/conductor/action_mailbox/inbound_emails/sources` | [route-post-rails-conductor-action-mailbox-inbound-emails-sources](30-http-api.md#route-post-rails-conductor-action-mailbox-inbound-emails-sources) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_conductor_action_mailbox_inbound_emails_sources.json) |
| `POST /rails/conductor/action_mailbox/:inbound_email_id/reroute` | [route-post-rails-conductor-action-mailbox-inbound-email-id-reroute](30-http-api.md#route-post-rails-conductor-action-mailbox-inbound-email-id-reroute) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_conductor_action_mailbox__inbound_email_id_reroute.json) |
| `POST /rails/conductor/action_mailbox/:inbound_email_id/incinerate` | [route-post-rails-conductor-action-mailbox-inbound-email-id-incinerate](30-http-api.md#route-post-rails-conductor-action-mailbox-inbound-email-id-incinerate) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_conductor_action_mailbox__inbound_email_id_incinerate.json) |
| `GET /rails/active_storage/blobs/redirect/:signed_id/*filename` | [route-get-rails-active-storage-blobs-redirect-signed-id-filename](30-http-api.md#route-get-rails-active-storage-blobs-redirect-signed-id-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_blobs_redirect__signed_id__filename.json) |
| `GET /rails/active_storage/blobs/proxy/:signed_id/*filename` | [route-get-rails-active-storage-blobs-proxy-signed-id-filename](30-http-api.md#route-get-rails-active-storage-blobs-proxy-signed-id-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_blobs_proxy__signed_id__filename.json) |
| `GET /rails/active_storage/blobs/:signed_id/*filename` | [route-get-rails-active-storage-blobs-signed-id-filename](30-http-api.md#route-get-rails-active-storage-blobs-signed-id-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_blobs__signed_id__filename.json) |
| `GET /rails/active_storage/representations/redirect/:signed_blob_id/:variation_key/*filename` | [route-get-rails-active-storage-representations-redirect-signed-blob-id-variation-key-filename](30-http-api.md#route-get-rails-active-storage-representations-redirect-signed-blob-id-variation-key-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_representations_redirect__signed_blob_id__variation_key__filename.json) |
| `GET /rails/active_storage/representations/proxy/:signed_blob_id/:variation_key/*filename` | [route-get-rails-active-storage-representations-proxy-signed-blob-id-variation-key-filename](30-http-api.md#route-get-rails-active-storage-representations-proxy-signed-blob-id-variation-key-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_representations_proxy__signed_blob_id__variation_key__filename.json) |
| `GET /rails/active_storage/representations/:signed_blob_id/:variation_key/*filename` | [route-get-rails-active-storage-representations-signed-blob-id-variation-key-filename](30-http-api.md#route-get-rails-active-storage-representations-signed-blob-id-variation-key-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_representations__signed_blob_id__variation_key__filename.json) |
| `GET /rails/active_storage/disk/:encoded_key/*filename` | [route-get-rails-active-storage-disk-encoded-key-filename](30-http-api.md#route-get-rails-active-storage-disk-encoded-key-filename) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/GET_rails_active_storage_disk__encoded_key__filename.json) |
| `PUT /rails/active_storage/disk/:encoded_token` | [route-put-rails-active-storage-disk-encoded-token](30-http-api.md#route-put-rails-active-storage-disk-encoded-token) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/PUT_rails_active_storage_disk__encoded_token.json) |
| `POST /rails/active_storage/direct_uploads` | [route-post-rails-active-storage-direct-uploads](30-http-api.md#route-post-rails-active-storage-direct-uploads) | no spec — out of scope (D-006 framework route (X-16)) | — | [1](../oracle/http/POST_rails_active_storage_direct_uploads.json) |
| `GET /api/v1/transactions` | [route-get-api-v1-transactions](30-http-api.md#route-get-api-v1-transactions) | spec (request) | `requests/api/v1/cross_cutting_spec.rb:44`, `requests/api/v1/transactions_spec.rb:6`, `requests/api/v1/transactions_spec.rb:28` | [4](../oracle/http/GET_api__version_transactions.json) |
| `GET /api/v1/transactions/:source_type/:source_id` | [route-get-api-v1-transactions-source-type-source-id](30-http-api.md#route-get-api-v1-transactions-source-type-source-id) | spec (request+system) | `requests/api/v1/transactions_spec.rb:43`, `requests/api/v1/transactions_spec.rb:57`, `system/personal_access_token_lifecycle_spec.rb:123` | [4](../oracle/http/GET_api__version_transactions__source_type__source_id.json) |
| `GET /api/v1/cash_transactions` | [route-get-api-v1-cash-transactions](30-http-api.md#route-get-api-v1-cash-transactions) | spec (request+system) | `requests/api/v1/cross_cutting_spec.rb:100`, `requests/api/v1/cross_cutting_spec.rb[1:1:1]`, `requests/api/v1/cross_cutting_spec.rb[1:1:2]`, `requests/api/v1/cross_cutting_spec.rb[1:1:3]` (+6) | [1](../oracle/http/GET_api__version_cash_transactions.json) |
| `POST /api/v1/cash_transactions` | [route-post-api-v1-cash-transactions](30-http-api.md#route-post-api-v1-cash-transactions) | spec (request) | `requests/api/v1/cross_cutting_spec.rb:33`, `requests/api/v1/cross_cutting_spec.rb:56`, `requests/api/v1/transactions_spec.rb:84`, `requests/api/v1/transactions_spec.rb:102` | [4](../oracle/http/POST_api__version_cash_transactions.json) |
| `GET /api/v1/cash_transactions/:id` | [route-get-api-v1-cash-transactions-id](30-http-api.md#route-get-api-v1-cash-transactions-id) | spec — negative cases only | `requests/api/v1/cross_cutting_spec.rb:22`, `requests/api/v1/transactions_spec.rb:114`, `requests/api/v1/transactions_spec.rb:123` | [2](../oracle/http/GET_api__version_cash_transactions__id.json) |
| `PATCH /api/v1/cash_transactions/:id` | [route-patch-api-v1-cash-transactions-id](30-http-api.md#route-patch-api-v1-cash-transactions-id) | spec (request) | `requests/api/v1/transactions_spec.rb:134`, `requests/api/v1/transactions_spec.rb:147` | [2](../oracle/http/PATCH_api__version_cash_transactions__id.json) |
| `DELETE /api/v1/cash_transactions/:id` | [route-delete-api-v1-cash-transactions-id](30-http-api.md#route-delete-api-v1-cash-transactions-id) | spec (request) | `requests/api/v1/transactions_spec.rb:161` | [2](../oracle/http/DELETE_api__version_cash_transactions__id.json) |
| `GET /api/v1/bank_transactions` | [route-get-api-v1-bank-transactions](30-http-api.md#route-get-api-v1-bank-transactions) | spec (request) | `requests/api/v1/transactions_spec.rb:172` | [1](../oracle/http/GET_api__version_bank_transactions.json) |
| `GET /api/v1/bank_transactions/:id` | [route-get-api-v1-bank-transactions-id](30-http-api.md#route-get-api-v1-bank-transactions-id) | spec — negative cases only | `requests/api/v1/transactions_spec.rb:189` | [2](../oracle/http/GET_api__version_bank_transactions__id.json) |
| `POST /api/v1/bank_transactions/:bank_transaction_id/classification` | [route-post-api-v1-bank-transactions-bank-transaction-id-classification](30-http-api.md#route-post-api-v1-bank-transactions-bank-transaction-id-classification) | spec (request) | `requests/api/v1/transactions_spec.rb:200`, `requests/api/v1/transactions_spec.rb:212`, `requests/api/v1/transactions_spec.rb:226` | [3](../oracle/http/POST_api__version_bank_transactions__bank_transaction_id_classification.json) |
| `GET /api/v1/categories` | [route-get-api-v1-categories](30-http-api.md#route-get-api-v1-categories) | spec (request) | `requests/api/v1/categorization_spec.rb:6`, `requests/api/v1/categorization_spec.rb:22` | [2](../oracle/http/GET_api__version_categories.json) |
| `POST /api/v1/categories` | [route-post-api-v1-categories](30-http-api.md#route-post-api-v1-categories) | spec (request) | `requests/api/v1/categorization_spec.rb:34`, `requests/api/v1/categorization_spec.rb:48` | [3](../oracle/http/POST_api__version_categories.json) |
| `GET /api/v1/categories/:id` | [route-get-api-v1-categories-id](30-http-api.md#route-get-api-v1-categories-id) | spec — negative cases only | `requests/api/v1/categorization_spec.rb:57` | [3](../oracle/http/GET_api__version_categories__id.json) |
| `PATCH /api/v1/categories/:id` | [route-patch-api-v1-categories-id](30-http-api.md#route-patch-api-v1-categories-id) | spec (request) | `requests/api/v1/categorization_spec.rb:68` | [3](../oracle/http/PATCH_api__version_categories__id.json) |
| `DELETE /api/v1/categories/:id` | [route-delete-api-v1-categories-id](30-http-api.md#route-delete-api-v1-categories-id) | spec (request) | `requests/api/v1/categorization_spec.rb:79`, `requests/api/v1/categorization_spec.rb:91` | [2](../oracle/http/DELETE_api__version_categories__id.json) |
| `POST /api/v1/categories/:id/archive` | [route-post-api-v1-categories-id-archive](30-http-api.md#route-post-api-v1-categories-id-archive) | spec (request) | `requests/api/v1/categorization_spec.rb:102` | [1](../oracle/http/POST_api__version_categories__id_archive.json) |
| `POST /api/v1/categories/:id/unarchive` | [route-post-api-v1-categories-id-unarchive](30-http-api.md#route-post-api-v1-categories-id-unarchive) | **GAP** — no spec | — | [1](../oracle/http/POST_api__version_categories__id_unarchive.json) |
| `GET /api/v1/merchants` | [route-get-api-v1-merchants](30-http-api.md#route-get-api-v1-merchants) | spec (request) | `requests/api/v1/categorization_spec.rb:113`, `requests/api/v1/categorization_spec.rb:128` | [8](../oracle/http/GET_api__version_merchants.json) |
| `POST /api/v1/merchants` | [route-post-api-v1-merchants](30-http-api.md#route-post-api-v1-merchants) | spec (request) | `requests/api/v1/categorization_spec.rb:142` | [3](../oracle/http/POST_api__version_merchants.json) |
| `GET /api/v1/merchants/:id` | [route-get-api-v1-merchants-id](30-http-api.md#route-get-api-v1-merchants-id) | spec — negative cases only | `requests/api/v1/categorization_spec.rb:152` | [2](../oracle/http/GET_api__version_merchants__id.json) |
| `PATCH /api/v1/merchants/:id` | [route-patch-api-v1-merchants-id](30-http-api.md#route-patch-api-v1-merchants-id) | spec (request) | `requests/api/v1/categorization_spec.rb:163` | [1](../oracle/http/PATCH_api__version_merchants__id.json) |
| `DELETE /api/v1/merchants/:id` | [route-delete-api-v1-merchants-id](30-http-api.md#route-delete-api-v1-merchants-id) | spec (request) | `requests/api/v1/categorization_spec.rb:174` | [1](../oracle/http/DELETE_api__version_merchants__id.json) |
| `POST /api/v1/merchants/:id/archive` | [route-post-api-v1-merchants-id-archive](30-http-api.md#route-post-api-v1-merchants-id-archive) | **GAP** — no spec | — | [1](../oracle/http/POST_api__version_merchants__id_archive.json) |
| `POST /api/v1/merchants/:id/unarchive` | [route-post-api-v1-merchants-id-unarchive](30-http-api.md#route-post-api-v1-merchants-id-unarchive) | **GAP** — no spec | — | [1](../oracle/http/POST_api__version_merchants__id_unarchive.json) |
| `POST /api/v1/merchants/:id/approve` | [route-post-api-v1-merchants-id-approve](30-http-api.md#route-post-api-v1-merchants-id-approve) | spec (request) | `requests/api/v1/categorization_spec.rb:187` | [1](../oracle/http/POST_api__version_merchants__id_approve.json) |
| `GET /api/v1/merchants/:merchant_id/rules` | [route-get-api-v1-merchants-merchant-id-rules](30-http-api.md#route-get-api-v1-merchants-merchant-id-rules) | spec (request) | `requests/api/v1/categorization_spec.rb:199` | [1](../oracle/http/GET_api__version_merchants__merchant_id_rules.json) |
| `POST /api/v1/merchants/:merchant_id/rules` | [route-post-api-v1-merchants-merchant-id-rules](30-http-api.md#route-post-api-v1-merchants-merchant-id-rules) | spec (request) | `requests/api/v1/categorization_spec.rb:212` | [3](../oracle/http/POST_api__version_merchants__merchant_id_rules.json) |
| `PATCH /api/v1/merchants/:merchant_id/rules/:id` | [route-patch-api-v1-merchants-merchant-id-rules-id](30-http-api.md#route-patch-api-v1-merchants-merchant-id-rules-id) | spec (request) | `requests/api/v1/categorization_spec.rb:228` | [1](../oracle/http/PATCH_api__version_merchants__merchant_id_rules__id.json) |
| `DELETE /api/v1/merchants/:merchant_id/rules/:id` | [route-delete-api-v1-merchants-merchant-id-rules-id](30-http-api.md#route-delete-api-v1-merchants-merchant-id-rules-id) | spec (request) | `requests/api/v1/categorization_spec.rb:241` | [1](../oracle/http/DELETE_api__version_merchants__merchant_id_rules__id.json) |
| `GET /api/v1/bank_accounts` | [route-get-api-v1-bank-accounts](30-http-api.md#route-get-api-v1-bank-accounts) | spec (request) | `requests/api/v1/banking_spec.rb:6`, `requests/api/v1/banking_spec.rb:23` | [2](../oracle/http/GET_api__version_bank_accounts.json) |
| `GET /api/v1/bank_accounts/:id` | [route-get-api-v1-bank-accounts-id](30-http-api.md#route-get-api-v1-bank-accounts-id) | spec (request) | `requests/api/v1/banking_spec.rb:36`, `requests/api/v1/banking_spec.rb:48` | [1](../oracle/http/GET_api__version_bank_accounts__id.json) |
| `POST /api/v1/bank_accounts/:id/refresh_details` | [route-post-api-v1-bank-accounts-id-refresh-details](30-http-api.md#route-post-api-v1-bank-accounts-id-refresh-details) | spec (request) | `requests/api/v1/banking_spec.rb:72` | [1](../oracle/http/POST_api__version_bank_accounts__id_refresh_details.json) |
| `POST /api/v1/bank_accounts/:id/refresh_balances` | [route-post-api-v1-bank-accounts-id-refresh-balances](30-http-api.md#route-post-api-v1-bank-accounts-id-refresh-balances) | spec (request) | `requests/api/v1/banking_spec.rb:59` | [1](../oracle/http/POST_api__version_bank_accounts__id_refresh_balances.json) |
| `GET /api/v1/bank_connections` | [route-get-api-v1-bank-connections](30-http-api.md#route-get-api-v1-bank-connections) | spec (request) | `requests/api/v1/banking_spec.rb:84` | [2](../oracle/http/GET_api__version_bank_connections.json) |
| `GET /api/v1/bank_connections/:id` | [route-get-api-v1-bank-connections-id](30-http-api.md#route-get-api-v1-bank-connections-id) | spec — negative cases only | `requests/api/v1/banking_spec.rb:98` | [2](../oracle/http/GET_api__version_bank_connections__id.json) |
| `PATCH /api/v1/bank_connections/:id` | [route-patch-api-v1-bank-connections-id](30-http-api.md#route-patch-api-v1-bank-connections-id) | spec (request) | `requests/api/v1/banking_spec.rb:109` | [1](../oracle/http/PATCH_api__version_bank_connections__id.json) |
| `POST /api/v1/bank_connections/:id/refresh` | [route-post-api-v1-bank-connections-id-refresh](30-http-api.md#route-post-api-v1-bank-connections-id-refresh) | spec (request) | `requests/api/v1/banking_spec.rb:121` | [1](../oracle/http/POST_api__version_bank_connections__id_refresh.json) |
| `DELETE /api/v1/bank_connections/:id` | [route-delete-api-v1-bank-connections-id](30-http-api.md#route-delete-api-v1-bank-connections-id) | spec (request) | `requests/api/v1/banking_spec.rb:132` | [2](../oracle/http/DELETE_api__version_bank_connections__id.json) |
| `GET /api/v1/tpp_credentials` | [route-get-api-v1-tpp-credentials](30-http-api.md#route-get-api-v1-tpp-credentials) | spec (request) | `requests/api/v1/banking_spec.rb:143` | [1](../oracle/http/GET_api__version_tpp_credentials.json) |
| `POST /api/v1/tpp_credentials` | [route-post-api-v1-tpp-credentials](30-http-api.md#route-post-api-v1-tpp-credentials) | spec (request) | `requests/api/v1/banking_spec.rb:159` | [2](../oracle/http/POST_api__version_tpp_credentials.json) |
| `GET /api/v1/tpp_credentials/:id` | [route-get-api-v1-tpp-credentials-id](30-http-api.md#route-get-api-v1-tpp-credentials-id) | **GAP** — no spec | — | [2](../oracle/http/GET_api__version_tpp_credentials__id.json) |
| `PATCH /api/v1/tpp_credentials/:id` | [route-patch-api-v1-tpp-credentials-id](30-http-api.md#route-patch-api-v1-tpp-credentials-id) | **GAP** — no spec | — | [1](../oracle/http/PATCH_api__version_tpp_credentials__id.json) |
| `DELETE /api/v1/tpp_credentials/:id` | [route-delete-api-v1-tpp-credentials-id](30-http-api.md#route-delete-api-v1-tpp-credentials-id) | spec (request) | `requests/api/v1/banking_spec.rb:174` | [1](../oracle/http/DELETE_api__version_tpp_credentials__id.json) |
| `POST /api/v1/tpp_credentials/:id/test_connection` | [route-post-api-v1-tpp-credentials-id-test-connection](30-http-api.md#route-post-api-v1-tpp-credentials-id-test-connection) | spec (request) | `requests/api/v1/banking_spec.rb:186` | [2](../oracle/http/POST_api__version_tpp_credentials__id_test_connection.json) |
| `POST /api/v1/tpp_credentials/:id/make_primary` | [route-post-api-v1-tpp-credentials-id-make-primary](30-http-api.md#route-post-api-v1-tpp-credentials-id-make-primary) | spec (request) | `requests/api/v1/banking_spec.rb:199` | [2](../oracle/http/POST_api__version_tpp_credentials__id_make_primary.json) |
| `GET /api/v1/transaction_syncs` | [route-get-api-v1-transaction-syncs](30-http-api.md#route-get-api-v1-transaction-syncs) | spec (request) | `requests/api/v1/banking_spec.rb:212` | [1](../oracle/http/GET_api__version_transaction_syncs.json) |
| `POST /api/v1/transaction_syncs` | [route-post-api-v1-transaction-syncs](30-http-api.md#route-post-api-v1-transaction-syncs) | spec (request) | `requests/api/v1/banking_spec.rb:227` | [3](../oracle/http/POST_api__version_transaction_syncs.json) |
| `GET /api/v1/transaction_syncs/:id` | [route-get-api-v1-transaction-syncs-id](30-http-api.md#route-get-api-v1-transaction-syncs-id) | spec — negative cases only | `requests/api/v1/banking_spec.rb:241` | [1](../oracle/http/GET_api__version_transaction_syncs__id.json) |
| `GET /api/v1/llm_enrichments` | [route-get-api-v1-llm-enrichments](30-http-api.md#route-get-api-v1-llm-enrichments) | spec (request) | `requests/api/v1/categorization_spec.rb:254` | [1](../oracle/http/GET_api__version_llm_enrichments.json) |
| `POST /api/v1/llm_enrichments` | [route-post-api-v1-llm-enrichments](30-http-api.md#route-post-api-v1-llm-enrichments) | spec (request) | `requests/api/v1/categorization_spec.rb:269`, `requests/api/v1/categorization_spec.rb:281` | [2](../oracle/http/POST_api__version_llm_enrichments.json) |
| `GET /api/v1/llm_enrichments/:id` | [route-get-api-v1-llm-enrichments-id](30-http-api.md#route-get-api-v1-llm-enrichments-id) | **GAP** — no spec | — | [2](../oracle/http/GET_api__version_llm_enrichments__id.json) |
| `GET /api/v1/analytics/cash_flow` | [route-get-api-v1-analytics-cash-flow](30-http-api.md#route-get-api-v1-analytics-cash-flow) | spec (request) | `requests/api/v1/analytics_spec.rb:117`, `requests/api/v1/analytics_spec.rb:129`, `requests/api/v1/analytics_spec.rb:6` | [4](../oracle/http/GET_api__version_analytics_cash_flow.json) |
| `GET /api/v1/analytics/spend` | [route-get-api-v1-analytics-spend](30-http-api.md#route-get-api-v1-analytics-spend) | spec (request) | `requests/api/v1/analytics_spec.rb:20` | [1](../oracle/http/GET_api__version_analytics_spend.json) |
| `GET /api/v1/analytics/top_merchants` | [route-get-api-v1-analytics-top-merchants](30-http-api.md#route-get-api-v1-analytics-top-merchants) | spec (request) | `requests/api/v1/analytics_spec.rb:32` | [1](../oracle/http/GET_api__version_analytics_top_merchants.json) |
| `GET /api/v1/analytics/categories/:slug` | [route-get-api-v1-analytics-categories-slug](30-http-api.md#route-get-api-v1-analytics-categories-slug) | spec (request) | `requests/api/v1/analytics_spec.rb:44`, `requests/api/v1/analytics_spec.rb:53`, `requests/api/v1/analytics_spec.rb:64` | [2](../oracle/http/GET_api__version_analytics_categories__slug.json) |
| `GET /api/v1/analytics/merchants/:slug` | [route-get-api-v1-analytics-merchants-slug](30-http-api.md#route-get-api-v1-analytics-merchants-slug) | spec (request) | `requests/api/v1/analytics_spec.rb:77`, `requests/api/v1/analytics_spec.rb:86`, `requests/api/v1/analytics_spec.rb:97` | [2](../oracle/http/GET_api__version_analytics_merchants__slug.json) |
| `GET /api/v1/swagger_doc` | [route-get-api-v1-swagger-doc](30-http-api.md#route-get-api-v1-swagger-doc) | spec (request) | `requests/api/v1/cross_cutting_spec.rb:68` | [1](../oracle/http/GET_api__version_swagger_doc.json) |
| `GET /api/v1/swagger_doc/:name` | [route-get-api-v1-swagger-doc-name](30-http-api.md#route-get-api-v1-swagger-doc-name) | **GAP** — no spec | — | [2](../oracle/http/GET_api__version_swagger_doc__name.json) |

**Counts** (204 route keys): 148 exercised by a spec, 1 indirect (`MOUNT /`), 6 PUT aliases whose PATCH
twin is tested (`PUT /admin/bank_transactions/:bank_transaction_id/enrichment`, `PUT /admin/cash_transactions/:id`, `PUT /admin/categories/:id`, `PUT /admin/merchants/:merchant_id/merchant_rules/:id`, `PUT /admin/merchants/:id`, `PUT /admin/bank_connections/:bank_connection_id/sync_schedule`), 16 in-scope gaps, 33 out of scope.

**In-scope routes with no spec (gaps)** — Kotlin must add tests; behaviour is documented in 30-http-api.md and observed in the oracle
where a case exists:

- `PATCH /admin/password` → [30-http-api.md#route-patch-admin-password](30-http-api.md#route-patch-admin-password) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `PUT /admin/password` → [30-http-api.md#route-put-admin-password](30-http-api.md#route-put-admin-password) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `GET /up` → [30-http-api.md#route-get-up](30-http-api.md#route-get-up) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `GET /api/:version/docs` → [30-http-api.md#route-get-api-version-docs](30-http-api.md#route-get-api-version-docs) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `POST /admin/merchants/:id/unarchive` → [30-http-api.md#route-post-admin-merchants-id-unarchive](30-http-api.md#route-post-admin-merchants-id-unarchive) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `PATCH /admin/tpp_credentials/:id` → [30-http-api.md#route-patch-admin-tpp-credentials-id](30-http-api.md#route-patch-admin-tpp-credentials-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `PUT /admin/tpp_credentials/:id` → [30-http-api.md#route-put-admin-tpp-credentials-id](30-http-api.md#route-put-admin-tpp-credentials-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `PATCH /admin/bank_connections/:id` → [30-http-api.md#route-patch-admin-bank-connections-id](30-http-api.md#route-patch-admin-bank-connections-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `PUT /admin/bank_connections/:id` → [30-http-api.md#route-put-admin-bank-connections-id](30-http-api.md#route-put-admin-bank-connections-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `POST /api/v1/categories/:id/unarchive` → [30-http-api.md#route-post-api-v1-categories-id-unarchive](30-http-api.md#route-post-api-v1-categories-id-unarchive) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `POST /api/v1/merchants/:id/archive` → [30-http-api.md#route-post-api-v1-merchants-id-archive](30-http-api.md#route-post-api-v1-merchants-id-archive) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `POST /api/v1/merchants/:id/unarchive` → [30-http-api.md#route-post-api-v1-merchants-id-unarchive](30-http-api.md#route-post-api-v1-merchants-id-unarchive) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `GET /api/v1/tpp_credentials/:id` → [30-http-api.md#route-get-api-v1-tpp-credentials-id](30-http-api.md#route-get-api-v1-tpp-credentials-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `PATCH /api/v1/tpp_credentials/:id` → [30-http-api.md#route-patch-api-v1-tpp-credentials-id](30-http-api.md#route-patch-api-v1-tpp-credentials-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `GET /api/v1/llm_enrichments/:id` → [30-http-api.md#route-get-api-v1-llm-enrichments-id](30-http-api.md#route-get-api-v1-llm-enrichments-id) [V] (no matching call in `spec/requests/**`, `spec/system/**`)
- `GET /api/v1/swagger_doc/:name` → [30-http-api.md#route-get-api-v1-swagger-doc-name](30-http-api.md#route-get-api-v1-swagger-doc-name) [V] (no matching call in `spec/requests/**`, `spec/system/**`)

Notes on the gaps: `PUT /admin/password`, `PUT /admin/tpp_credentials/:id` and `PUT /admin/bank_connections/:id` are aliases, but their
PATCH twins are untested as well. `GET /api/:version/docs` renders `app/views/swagger/index.html.erb` from a controller that SimpleCov
filters out (`spec/spec_helper.rb:5`); only `GET /api/v1/swagger_doc` has a spec (`spec/requests/api/v1/cross_cutting_spec.rb:68`).

**Exercised only weakly** **[V]**: `GET /admin/settings`, `GET /admin/settings/preferences`, `GET /admin/merchants/:id/edit`,
`GET /admin/tpp_credentials/:id/edit`, `GET /admin/bank_connections/:id/edit` are hit only by the smoke crawler (which accepts 200/301/302
without checking content); `GET /admin/llm_enrichments/:id` and `GET /api/v1/{cash_transactions,bank_transactions,categories,merchants,bank_connections,transaction_syncs}/:id`
are hit only with foreign/unknown ids (404), never with an owned record.

**Out of scope per D-006 (no spec, not to be ported)**: `MOUNT /sidekiq`, `GET /admin/debug`, `GET /admin/debug/runtime_error`, `GET /admin/debug/zero_division`, `GET /admin/debug/argument_error`, `GET /admin/debug/nested_error`, `POST /admin/debug/enqueue_failing_job`, `GET /recede_historical_location`, `GET /resume_historical_location`, `GET /refresh_historical_location`, `POST /rails/action_mailbox/postmark/inbound_emails`, `POST /rails/action_mailbox/relay/inbound_emails`, `POST /rails/action_mailbox/sendgrid/inbound_emails`, `GET /rails/action_mailbox/mandrill/inbound_emails`, `POST /rails/action_mailbox/mandrill/inbound_emails`, `POST /rails/action_mailbox/mailgun/inbound_emails/mime`, `GET /rails/conductor/action_mailbox/inbound_emails`, `POST /rails/conductor/action_mailbox/inbound_emails`, `GET /rails/conductor/action_mailbox/inbound_emails/new`, `GET /rails/conductor/action_mailbox/inbound_emails/:id`, `GET /rails/conductor/action_mailbox/inbound_emails/sources/new`, `POST /rails/conductor/action_mailbox/inbound_emails/sources`, `POST /rails/conductor/action_mailbox/:inbound_email_id/reroute`, `POST /rails/conductor/action_mailbox/:inbound_email_id/incinerate`, `GET /rails/active_storage/blobs/redirect/:signed_id/*filename`, `GET /rails/active_storage/blobs/proxy/:signed_id/*filename`, `GET /rails/active_storage/blobs/:signed_id/*filename`, `GET /rails/active_storage/representations/redirect/:signed_blob_id/:variation_key/*filename`, `GET /rails/active_storage/representations/proxy/:signed_blob_id/:variation_key/*filename`, `GET /rails/active_storage/representations/:signed_blob_id/:variation_key/*filename`, `GET /rails/active_storage/disk/:encoded_key/*filename`, `PUT /rails/active_storage/disk/:encoded_token`, `POST /rails/active_storage/direct_uploads` — see [decisions.md D-006](decisions.md) and deviation rows X-03/X-16.

### 4.2 MCP tools

`tools/list` registration of all 27 tool classes is asserted by `spec/services/mcp/server_builder_spec.rb:17` **[V]**, but only the tools
below marked with spec examples are actually invoked. The line-coverage column shows the effect: never-invoked tools have only their
class-level DSL lines covered (8 lines each) **[V]** (`../inventory/coverage_by_file.json`). Oracle cases are in
[POST_mcp.json](../oracle/http/POST_mcp.json).

| MCP tool | 30-http-api.md | Request/system spec (`tools/call`) | Line coverage of tool file | Oracle case |
|---|---|---|---:|---|
| `analytics.cash_flow` | [mcp-analytics-cash-flow](30-http-api.md#mcp-analytics-cash-flow) | `requests/mcp/tools_spec.rb:112` | 100.0% (14/14) | `tools_call:analytics.cash_flow -> 200`; `tools_call:analytics.cash_flow:invalid_enum -> 200` |
| `analytics.spend` | [mcp-analytics-spend](30-http-api.md#mcp-analytics-spend) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 61.5% (8/13) | `tools_call:analytics.spend -> 200` |
| `analytics.top_merchants` | [mcp-analytics-top-merchants](30-http-api.md#mcp-analytics-top-merchants) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 57.1% (8/14) | `tools_call:analytics.top_merchants -> 200` |
| `bank_accounts.list` | [mcp-bank-accounts-list](30-http-api.md#mcp-bank-accounts-list) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 44.4% (8/18) | `tools_call:bank_accounts.list -> 200` |
| `bank_accounts.refresh_balances` | [mcp-bank-accounts-refresh-balances](30-http-api.md#mcp-bank-accounts-refresh-balances) | `requests/mcp/tools_spec.rb:86` | 92.9% (13/14) | `tools_call:bank_accounts.refresh_balances -> 200` |
| `bank_accounts.refresh_details` | [mcp-bank-accounts-refresh-details](30-http-api.md#mcp-bank-accounts-refresh-details) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 57.1% (8/14) | `tools_call:bank_accounts.refresh_details -> 200` |
| `bank_connections.list` | [mcp-bank-connections-list](30-http-api.md#mcp-bank-connections-list) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 57.1% (8/14) | `tools_call:bank_connections.list -> 200` |
| `bank_connections.refresh` | [mcp-bank-connections-refresh](30-http-api.md#mcp-bank-connections-refresh) | `requests/mcp/tools_spec.rb:99` | 92.9% (13/14) | `tools_call:bank_connections.refresh -> 200` |
| `cash.create_transaction` | [mcp-cash-create-transaction](30-http-api.md#mcp-cash-create-transaction) | `requests/mcp/protocol_spec.rb:42`, `requests/mcp/protocol_spec.rb:61`, `requests/mcp/tools_spec.rb:6` | 100.0% (13/13) | `tools_call:cash.create_transaction -> 200`; `tools_call:cash.create_transaction:invalid_amount -> 200` |
| `cash.delete_transaction` | [mcp-cash-delete-transaction](30-http-api.md#mcp-cash-delete-transaction) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 57.1% (8/14) | `tools_call:cash.delete_transaction -> 200` |
| `cash.update_transaction` | [mcp-cash-update-transaction](30-http-api.md#mcp-cash-update-transaction) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 50.0% (8/16) | `tools_call:cash.update_transaction -> 200` |
| `categories.archive` | [mcp-categories-archive](30-http-api.md#mcp-categories-archive) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 61.5% (8/13) | `tools_call:categories.archive -> 200` |
| `categories.create` | [mcp-categories-create](30-http-api.md#mcp-categories-create) | `requests/mcp/tools_spec.rb:43` | 100.0% (13/13) | `tools_call:categories.create -> 200`; `tools_call:categories.create:invalid -> 200` |
| `categories.list` | [mcp-categories-list](30-http-api.md#mcp-categories-list) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 61.5% (8/13) | `tools_call:categories.list -> 200` |
| `categories.unarchive` | [mcp-categories-unarchive](30-http-api.md#mcp-categories-unarchive) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 61.5% (8/13) | `tools_call:categories.unarchive -> 200` |
| `categories.update` | [mcp-categories-update](30-http-api.md#mcp-categories-update) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 53.3% (8/15) | `tools_call:categories.update -> 200` |
| `merchants.approve` | [mcp-merchants-approve](30-http-api.md#mcp-merchants-approve) | `requests/mcp/tools_spec.rb:62`, `requests/mcp/tools_spec.rb:77` | 100.0% (13/13) | `tools_call:merchants.approve -> 200` |
| `merchants.archive` | [mcp-merchants-archive](30-http-api.md#mcp-merchants-archive) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 61.5% (8/13) | `tools_call:merchants.archive -> 200` |
| `merchants.create` | [mcp-merchants-create](30-http-api.md#mcp-merchants-create) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 66.7% (8/12) | `tools_call:merchants.create -> 200` |
| `merchants.list` | [mcp-merchants-list](30-http-api.md#mcp-merchants-list) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 42.1% (8/19) | `tools_call:merchants.list -> 200` |
| `merchants.unarchive` | [mcp-merchants-unarchive](30-http-api.md#mcp-merchants-unarchive) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 61.5% (8/13) | `tools_call:merchants.unarchive -> 200` |
| `merchants.update` | [mcp-merchants-update](30-http-api.md#mcp-merchants-update) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 57.1% (8/14) | `tools_call:merchants.update -> 200` |
| `llm_enrichments.create` | [mcp-llm-enrichments-create](30-http-api.md#mcp-llm-enrichments-create) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 72.7% (8/11) | `tools_call:llm_enrichments.create -> 200` |
| `transaction_syncs.create` | [mcp-transaction-syncs-create](30-http-api.md#mcp-transaction-syncs-create) | `requests/mcp/tools_spec.rb:123` | 100.0% (12/12) | `tools_call:transaction_syncs.create -> 200` |
| `transactions.classify` | [mcp-transactions-classify](30-http-api.md#mcp-transactions-classify) | **GAP** — only registration asserted (`spec/services/mcp/server_builder_spec.rb:17`) | 50.0% (8/16) | `tools_call:transactions.classify -> 200` |
| `transactions.get` | [mcp-transactions-get](30-http-api.md#mcp-transactions-get) | `requests/mcp/protocol_spec.rb:101`, `system/personal_access_token_lifecycle_spec.rb:123` | 91.7% (11/12) | `tools_call:transactions.get -> 200`; `tools_call:transactions.get:other_tenant -> 200` |
| `transactions.list` | [mcp-transactions-list](30-http-api.md#mcp-transactions-list) | `requests/mcp/tools_spec.rb:25`, `system/personal_access_token_lifecycle_spec.rb:16` | 100.0% (26/26) | `tools_call:transactions.list -> 200` |

**MCP tools never invoked by a spec (gaps)**: `analytics.spend`, `analytics.top_merchants`, `bank_accounts.list`, `bank_accounts.refresh_details`, `bank_connections.list`, `cash.delete_transaction`, `cash.update_transaction`, `categories.archive`, `categories.list`, `categories.unarchive`, `categories.update`, `merchants.archive`, `merchants.create`, `merchants.list`, `merchants.unarchive`, `merchants.update`, `llm_enrichments.create`, `transactions.classify`. Each of them was executed successfully against the real server in the oracle
capture (case `tools_call:<name> -> 200`) **[V]**, so the oracle is the only executable reference for their output shape.

---

## 5. Page coverage

A page counts as **rendered** when a request or system spec issues a non-negative GET to the route that renders it (same static method
as section 4) **[I]**; page templates are also re-rendered by failed POST/PATCH submissions (422) where 40-ui.md says so. Page → route
mapping follows the controller conventions documented in [40-ui.md](40-ui.md). Oracle screenshots are linked where captured.

| Page (view) | 40-ui.md | Rendering route | Rendered by spec? | Spec examples | Oracle UI |
|---|---|---|---|---|---|
| `pwa/manifest.json.erb` | [page-pwa-manifest](40-ui.md#page-pwa-manifest) | — | not routed (see 40-ui.md) | — | — |
| `pwa/service-worker.js` | [page-pwa-service-worker-js](40-ui.md#page-pwa-service-worker-js) | — | not routed (see 40-ui.md) | — | — |
| `swagger/index.html.erb` | [page-swagger-index](40-ui.md#page-swagger-index) | `GET /api/:version/docs` | no — SimpleCov-filtered controller, no spec | — | — |
| `admin/debug/index.html.erb` | [page-admin-debug-index](40-ui.md#page-admin-debug-index) | `GET /admin/debug` | no — out of scope (D-006) | — | [admin_debug](../oracle/ui/admin_debug.png) |
| `admin/matching_engine/show.html.erb` | [page-admin-matching-engine-show](40-ui.md#page-admin-matching-engine-show) | `GET /admin/matching_engine` | yes | `requests/categorization_spec.rb:522`, `system/smoke/admin_spec.rb[1:20]` | [admin_matching_engine](../oracle/ui/admin_matching_engine.png) |
| `admin/styleguide/index.html.erb` | [page-admin-styleguide-index](40-ui.md#page-admin-styleguide-index) | `GET /admin/styleguide` | yes | `requests/meta_spec.rb:12`, `requests/public_spec.rb:208`, `system/smoke/admin_spec.rb[1:2]` | [admin_styleguide](../oracle/ui/admin_styleguide.png) |
| `admin/settings/preferences/app.html.erb` | [page-admin-settings-preferences-app](40-ui.md#page-admin-settings-preferences-app) | `GET /admin/settings/preferences/app` | yes | `requests/settings_spec.rb:70`, `system/smoke/admin_spec.rb[1:38]` | — |
| `admin/settings/preferences/llm.html.erb` | [page-admin-settings-preferences-llm](40-ui.md#page-admin-settings-preferences-llm) | `GET /admin/settings/preferences/llm` | yes | `requests/settings_spec.rb:127`, `system/smoke/admin_spec.rb[1:39]` | — |
| `admin/settings/preferences/profile.html.erb` | [page-admin-settings-preferences-profile](40-ui.md#page-admin-settings-preferences-profile) | `GET /admin/settings/preferences/profile` | yes | `requests/settings_spec.rb:6`, `requests/settings_spec.rb:426`, `requests/settings_spec.rb:36` (+1) | — |
| `admin/settings/api_tokens/index.html.erb` | [page-admin-settings-api-tokens-index](40-ui.md#page-admin-settings-api-tokens-index) | `GET /admin/settings/preferences/api_tokens` | yes | `requests/settings_spec.rb:299`, `requests/settings_spec.rb:308`, `requests/settings_spec.rb:325` (+4) | [admin_settings_api_tokens](../oracle/ui/admin_settings_api_tokens.png) |
| `admin/settings/data_exchange/show.html.erb` | [page-admin-settings-data-exchange-show](40-ui.md#page-admin-settings-data-exchange-show) | `GET /admin/settings/preferences/data_exchange` | yes | `requests/settings_spec.rb:213`, `system/data_exchange_round_trip_spec.rb:16`, `system/data_exchange_round_trip_spec.rb:29` (+4) | [admin_settings_data_exchange](../oracle/ui/admin_settings_data_exchange.png) |
| `admin/passwords/edit.html.erb` | [page-admin-passwords-edit](40-ui.md#page-admin-passwords-edit) | `GET /admin/password/edit` | yes | `requests/public_spec.rb:232` | — |
| `admin/passwords/new.html.erb` | [page-admin-passwords-new](40-ui.md#page-admin-passwords-new) | `GET /admin/password/new` | yes | `requests/public_spec.rb:217`, `system/smoke/auth_spec.rb:49` | — |
| `admin/bank_transactions/index.html.erb` | [page-admin-bank-transactions-index](40-ui.md#page-admin-bank-transactions-index) | `GET /admin/bank_transactions` | yes | `requests/banking_spec.rb:354`, `requests/banking_spec.rb:370`, `system/categorization_workflow_spec.rb:16` (+3) | [admin_bank_transactions_index](../oracle/ui/admin_bank_transactions_index.png) |
| `admin/bank_transactions/show.html.erb` | [page-admin-bank-transactions-show](40-ui.md#page-admin-bank-transactions-show) | `GET /admin/bank_transactions/:id` | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:4]` | [admin_bank_transactions_show](../oracle/ui/admin_bank_transactions_show.png) |
| `admin/bank_accounts/index.html.erb` | [page-admin-bank-accounts-index](40-ui.md#page-admin-bank-accounts-index) | `GET /admin/bank_accounts` | yes | `requests/banking_spec.rb:303`, `system/smoke/admin_spec.rb[1:33]` | [admin_bank_accounts_index](../oracle/ui/admin_bank_accounts_index.png) |
| `admin/bank_accounts/show.html.erb` | [page-admin-bank-accounts-show](40-ui.md#page-admin-bank-accounts-show) | `GET /admin/bank_accounts/:id` | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:34]` | [admin_bank_accounts_show](../oracle/ui/admin_bank_accounts_show.png) |
| `admin/llm_enrichments/index.html.erb` | [page-admin-llm-enrichments-index](40-ui.md#page-admin-llm-enrichments-index) | `GET /admin/llm_enrichments` | yes | `requests/categorization_spec.rb:479`, `system/llm_enrichment_spec.rb:16`, `system/llm_enrichment_spec.rb:67` (+3) | [admin_llm_enrichments_index](../oracle/ui/admin_llm_enrichments_index.png) |
| `admin/llm_enrichments/show.html.erb` | [page-admin-llm-enrichments-show](40-ui.md#page-admin-llm-enrichments-show) | `GET /admin/llm_enrichments/:id` | **GAP** — only negative (404/redirect) cases | `system/cross_user_isolation_spec.rb:83` | [admin_llm_enrichments_show](../oracle/ui/admin_llm_enrichments_show.png) |
| `admin/analytics/categories/show.html.erb` | [page-admin-analytics-categories-show](40-ui.md#page-admin-analytics-categories-show) | `GET /admin/analytics/categories/:slug` | yes | `requests/analytics_spec.rb:55`, `requests/analytics_spec.rb:85`, `system/daily_login_analytics_spec.rb:48` (+1) | — |
| `admin/analytics/merchants/show.html.erb` | [page-admin-analytics-merchants-show](40-ui.md#page-admin-analytics-merchants-show) | `GET /admin/analytics/merchants/:slug` | yes | `requests/analytics_spec.rb:97`, `requests/analytics_spec.rb:127`, `system/smoke/admin_spec.rb[1:19]` | — |
| `admin/analytics/dashboard/index.html.erb` | [page-admin-analytics-dashboard-index](40-ui.md#page-admin-analytics-dashboard-index) | `GET /admin/analytics` | yes | `requests/analytics_spec.rb:140`, `requests/analytics_spec.rb:6`, `requests/analytics_spec.rb:15` (+5) | [admin_analytics_dashboard](../oracle/ui/admin_analytics_dashboard.png) |
| `admin/sessions/new.html.erb` | [page-admin-sessions-new](40-ui.md#page-admin-sessions-new) | `GET /admin/sign_in` | yes | `requests/public_spec.rb:185`, `system/cash_with_atm_link_spec.rb:16`, `system/cash_with_atm_link_spec.rb:47` (+14) | — |
| `admin/versions/index.html.erb` | [page-admin-versions-index](40-ui.md#page-admin-versions-index) | `GET /admin/versions` | yes | `requests/meta_spec.rb:21`, `requests/meta_spec.rb:55` | [admin_versions_index](../oracle/ui/admin_versions_index.png) |
| `admin/versions/show.html.erb` | [page-admin-versions-show](40-ui.md#page-admin-versions-show) | `GET /admin/versions/:id` | yes | `requests/meta_spec.rb:30` | [admin_versions_show](../oracle/ui/admin_versions_show.png) |
| `admin/transaction_syncs/index.html.erb` | [page-admin-transaction-syncs-index](40-ui.md#page-admin-transaction-syncs-index) | `GET /admin/transaction_syncs` | yes | `requests/banking_spec.rb:390`, `system/auto_sync_circuit_breaker_spec.rb:17`, `system/manual_sync_flow_spec.rb:114` (+1) | [admin_transaction_syncs_index](../oracle/ui/admin_transaction_syncs_index.png) |
| `admin/transaction_syncs/new.html.erb` | [page-admin-transaction-syncs-new](40-ui.md#page-admin-transaction-syncs-new) | `GET /admin/transaction_syncs/new` | yes | `requests/banking_spec.rb:415`, `system/auto_sync_circuit_breaker_spec.rb:83`, `system/first_time_setup_spec.rb:55` (+3) | [admin_transaction_syncs_new](../oracle/ui/admin_transaction_syncs_new.png) |
| `admin/transaction_syncs/show.html.erb` | [page-admin-transaction-syncs-show](40-ui.md#page-admin-transaction-syncs-show) | `GET /admin/transaction_syncs/:id` | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:23]` | [admin_transaction_syncs_show](../oracle/ui/admin_transaction_syncs_show.png) |
| `admin/cash_transactions/edit.html.erb` | [page-admin-cash-transactions-edit](40-ui.md#page-admin-cash-transactions-edit) | `GET /admin/cash_transactions/:id/edit` | yes | `requests/cash_spec.rb:163`, `requests/cash_spec.rb:173`, `system/smoke/admin_spec.rb[1:7]` | [admin_cash_transactions_edit](../oracle/ui/admin_cash_transactions_edit.png) |
| `admin/cash_transactions/index.html.erb` | [page-admin-cash-transactions-index](40-ui.md#page-admin-cash-transactions-index) | `GET /admin/cash_transactions` | yes | `requests/cash_spec.rb:6`, `requests/cash_spec.rb:270`, `requests/cash_spec.rb:20` (+5) | [admin_cash_transactions_index](../oracle/ui/admin_cash_transactions_index.png) |
| `admin/cash_transactions/new.html.erb` | [page-admin-cash-transactions-new](40-ui.md#page-admin-cash-transactions-new) | `GET /admin/cash_transactions/new` | yes | `requests/cash_spec.rb:61`, `requests/cash_spec.rb:71`, `system/cash_with_atm_link_spec.rb:16` (+1) | [admin_cash_transactions_new](../oracle/ui/admin_cash_transactions_new.png) |
| `admin/categories/edit.html.erb` | [page-admin-categories-edit](40-ui.md#page-admin-categories-edit) | `GET /admin/categories/:id/edit` | yes | `requests/categorization_spec.rb:61`, `requests/categorization_spec.rb:82`, `system/settings_change_spec.rb:16` (+3) | [admin_categories_edit](../oracle/ui/admin_categories_edit.png) |
| `admin/categories/index.html.erb` | [page-admin-categories-index](40-ui.md#page-admin-categories-index) | `GET /admin/categories` | yes | `requests/categorization_spec.rb:6`, `requests/categorization_spec.rb:537`, `system/settings_change_spec.rb:16` (+2) | [admin_categories_index](../oracle/ui/admin_categories_index.png) |
| `admin/categories/new.html.erb` | [page-admin-categories-new](40-ui.md#page-admin-categories-new) | `GET /admin/categories/new` | yes | `requests/categorization_spec.rb:20`, `system/smoke/admin_spec.rb[1:10]` | [admin_categories_new](../oracle/ui/admin_categories_new.png) |
| `admin/merchants/edit.html.erb` | [page-admin-merchants-edit](40-ui.md#page-admin-merchants-edit) | `GET /admin/merchants/:id/edit` | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:14]` | [admin_merchants_edit](../oracle/ui/admin_merchants_edit.png) |
| `admin/merchants/index.html.erb` | [page-admin-merchants-index](40-ui.md#page-admin-merchants-index) | `GET /admin/merchants` | yes | `requests/categorization_spec.rb:172`, `requests/categorization_spec.rb:186`, `requests/categorization_spec.rb:198` (+1) | [admin_merchants_index](../oracle/ui/admin_merchants_index.png) |
| `admin/merchants/new.html.erb` | [page-admin-merchants-new](40-ui.md#page-admin-merchants-new) | `GET /admin/merchants/new` | yes | `system/categorization_workflow_spec.rb:16`, `system/categorization_workflow_spec.rb:57`, `system/categorization_workflow_spec.rb:103` (+1) | [admin_merchants_new](../oracle/ui/admin_merchants_new.png) |
| `admin/merchants/show.html.erb` | [page-admin-merchants-show](40-ui.md#page-admin-merchants-show) | `GET /admin/merchants/:id` | yes | `requests/categorization_spec.rb:210`, `requests/categorization_spec.rb:231`, `system/smoke/admin_spec.rb[1:15]` | [admin_merchants_show](../oracle/ui/admin_merchants_show.png) |
| `admin/sync_schedules/edit.html.erb` | [page-admin-sync-schedules-edit](40-ui.md#page-admin-sync-schedules-edit) | `GET /admin/bank_connections/:bank_connection_id/sync_schedule/edit` | yes | `requests/banking_spec.rb:458`, `system/smoke/admin_spec.rb[1:28]` | [admin_sync_schedules_edit](../oracle/ui/admin_sync_schedules_edit.png) |
| `admin/tpp_credentials/edit.html.erb` | [page-admin-tpp-credentials-edit](40-ui.md#page-admin-tpp-credentials-edit) | `GET /admin/tpp_credentials/:id/edit` | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:26]` | [admin_tpp_credentials_edit](../oracle/ui/admin_tpp_credentials_edit.png) |
| `admin/tpp_credentials/index.html.erb` | [page-admin-tpp-credentials-index](40-ui.md#page-admin-tpp-credentials-index) | `GET /admin/tpp_credentials` | yes | `requests/banking_spec.rb:6`, `system/smoke/admin_spec.rb[1:24]` | [admin_tpp_credentials_index](../oracle/ui/admin_tpp_credentials_index.png) |
| `admin/tpp_credentials/new.html.erb` | [page-admin-tpp-credentials-new](40-ui.md#page-admin-tpp-credentials-new) | `GET /admin/tpp_credentials/new` | yes | `requests/banking_spec.rb:25`, `system/first_time_setup_spec.rb:55`, `system/smoke/admin_spec.rb[1:25]` | [admin_tpp_credentials_new](../oracle/ui/admin_tpp_credentials_new.png) |
| `admin/tpp_credentials/show.html.erb` | [page-admin-tpp-credentials-show](40-ui.md#page-admin-tpp-credentials-show) | `GET /admin/tpp_credentials/:id` | yes | `requests/banking_spec.rb[1:2:2]`, `system/smoke/admin_spec.rb[1:27]` | [admin_tpp_credentials_show](../oracle/ui/admin_tpp_credentials_show.png) |
| `admin/bank_connections/edit.html.erb` | [page-admin-bank-connections-edit](40-ui.md#page-admin-bank-connections-edit) | `GET /admin/bank_connections/:id/edit` | smoke crawl only (200/301/302 accepted) | `system/smoke/admin_spec.rb[1:31]` | [admin_bank_connections_edit](../oracle/ui/admin_bank_connections_edit.png) |
| `admin/bank_connections/index.html.erb` | [page-admin-bank-connections-index](40-ui.md#page-admin-bank-connections-index) | `GET /admin/bank_connections` | yes | `requests/banking_spec.rb:153`, `requests/banking_spec.rb:518`, `system/smoke/admin_spec.rb[1:29]` | [admin_bank_connections_index](../oracle/ui/admin_bank_connections_index.png) |
| `admin/bank_connections/new.html.erb` | [page-admin-bank-connections-new](40-ui.md#page-admin-bank-connections-new) | `GET /admin/bank_connections/new` | yes | `requests/banking_spec.rb:172`, `requests/banking_spec.rb:182`, `requests/banking_spec.rb:199` (+2) | [admin_bank_connections_new](../oracle/ui/admin_bank_connections_new.png) |
| `admin/bank_connections/show.html.erb` | [page-admin-bank-connections-show](40-ui.md#page-admin-bank-connections-show) | `GET /admin/bank_connections/:id` | yes | `requests/banking_spec.rb[1:13:2]`, `system/connection_expiry_reauth_spec.rb:16`, `system/smoke/admin_spec.rb[1:32]` | [admin_bank_connections_show](../oracle/ui/admin_bank_connections_show.png) |
| `setup/new.html.erb` | [page-setup-new](40-ui.md#page-setup-new) | `GET /setup` | yes | `requests/public_spec.rb:6`, `requests/public_spec.rb:14`, `requests/public_spec.rb:21` (+7) | — |

**Counts** (48 page keys): 37 rendered by a request/system spec, 6 only by the smoke crawler (`admin/bank_transactions/show`,
`admin/bank_accounts/show`, `admin/transaction_syncs/show`, `admin/merchants/edit`, `admin/tpp_credentials/edit`,
`admin/bank_connections/edit`), not rendered by any spec: `swagger/index.html.erb`, `admin/llm_enrichments/show.html.erb`, out of scope: `admin/debug/index.html.erb` (D-006), not routed:
`pwa/manifest.json.erb`, `pwa/service-worker.js` (see [40-ui.md#page-pwa-manifest](40-ui.md#page-pwa-manifest)).
Because no system spec runs with `js: true` (section 1.3), **none of the 21 Stimulus controllers, Turbo Stream updates, the command
palette or privacy-mask toggling is exercised by the suite** **[V]**; only the oracle UI capture (Playwright, e.g.
[admin_command_palette_open](../oracle/ui/admin_command_palette_open.png), [admin_privacy_mask_toggled](../oracle/ui/admin_privacy_mask_toggled.png))
shows them working.

---

## 6. Low-coverage files (< 80 % line coverage)

From `../inventory/coverage_by_file.json`; uncovered line numbers from `src/coverage/.resultset.json` of the same run **[V]**.
"What is untested" is read from those lines **[I]** unless stated.

| File | Line coverage | Uncovered lines | What is untested |
|---|---:|---|---|
| `app/mailers/application_mailer.rb` | 0.0% (0/4) | 1-4 | Never loaded: `ApplicationMailer` has no actions and no spec references it (Devise mails, e.g. the reset request in `spec/requests/public_spec.rb:224`, do not go through it) [I]. |
| `app/services/enable_banking/operations/sync_user_transactions.rb` | 0.0% (0/24) | 3-6, 8-13, 15-16, 18-29 | Whole operation never executed: the User-subject branch of `TransactionSyncJob#invoke_operation` (`app/jobs/transaction_sync_job.rb:109`) is not reached by any spec (sync of all active connections of a user). |
| `app/services/llm/clients/gemini.rb` | 0.0% (0/25) | 3-10, 12-18, 20, 23-31 | Gemini provider client never instantiated (only `spec/services/llm/clients/openai_spec.rb` exists, 2 examples): `structured`, error wrapping "Gemini API error: …", response parsing. |
| `lib/api/entities/pagination.rb` | 0.0% (0/8) | 3-10 | Grape entity never presented by any spec. |
| `lib/mcp/application_resource.rb` | 0.0% (0/4) | 3-6 | Empty MCP resource base class; no resources are defined, never loaded. |
| `lib/mcp/tools/merchants/list.rb` | 42.1% (8/19) | 21-23, 25-29, 31-32, 37 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:merchants.list`) [V] |
| `lib/mcp/tools/bank_accounts/list.rb` | 44.4% (8/18) | 17-19, 21-22, 27-28, 30, 32, 38 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:bank_accounts.list`) [V] |
| `lib/api/helpers/error_helper.rb` | 50.0% (5/10) | 8-9, 11, 16-17 | `present_or_fail!` (success → present with status; failure → 422 `{"message": error or "Request failed.", "details": error_messages}`) and `present_with_status` are never called by a spec. |
| `lib/mcp/tools/cash/update_transaction.rb` | 50.0% (8/16) | 28-31, 33-34, 36-37 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:cash.update_transaction`) [V] |
| `lib/mcp/tools/transactions/classify.rb` | 50.0% (8/16) | 29-31, 33, 41, 43-44, 46 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:transactions.classify`) [V] |
| `lib/mcp/tools/categories/update.rb` | 53.3% (8/15) | 26-28, 30-31, 36-37 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:categories.update`) [V] |
| `app/services/llm/client.rb` | 57.1% (12/21) | 19, 25-27, 30, 38, 40, 44-45 | `Llm::Client.for(user:)` body (lines 25-30: `NotConfiguredError` "User has not configured an LLM provider - see /admin/settings/preferences", `setting.build_client`) never runs because every example stubs `Llm::Client.for` (`spec/support/fakes_helpers.rb:32`); `ruby_llm_context` (38-45) only runs for real providers; abstract `structured` (19). |
| `lib/mcp/tools/analytics/top_merchants.rb` | 57.1% (8/14) | 22-24, 26-27, 31 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:analytics.top_merchants`) [V] |
| `lib/mcp/tools/bank_accounts/refresh_details.rb` | 57.1% (8/14) | 13-15, 17-18, 20 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:bank_accounts.refresh_details`) [V] |
| `lib/mcp/tools/bank_connections/list.rb` | 57.1% (8/14) | 13-15, 17-18, 23 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:bank_connections.list`) [V] |
| `lib/mcp/tools/cash/delete_transaction.rb` | 57.1% (8/14) | 16-19, 21-22 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:cash.delete_transaction`) [V] |
| `lib/mcp/tools/merchants/update.rb` | 57.1% (8/14) | 24-26, 28-29, 31 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:merchants.update`) [V] |
| `lib/mcp/tools/analytics/spend.rb` | 61.5% (8/13) | 22-23, 25, 33, 38 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:analytics.spend`) [V] |
| `lib/mcp/tools/categories/archive.rb` | 61.5% (8/13) | 13-15, 17-18 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:categories.archive`) [V] |
| `lib/mcp/tools/categories/list.rb` | 61.5% (8/13) | 17-18, 20-21, 24 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:categories.list`) [V] |
| `lib/mcp/tools/categories/unarchive.rb` | 61.5% (8/13) | 13-15, 17-18 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:categories.unarchive`) [V] |
| `lib/mcp/tools/merchants/archive.rb` | 61.5% (8/13) | 13-15, 17-18 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:merchants.archive`) [V] |
| `lib/mcp/tools/merchants/unarchive.rb` | 61.5% (8/13) | 13-15, 17-18 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:merchants.unarchive`) [V] |
| `lib/mcp/tools/merchants/create.rb` | 66.7% (8/12) | 23-26 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:merchants.create`) [V] |
| `app/jobs/transaction_sync_job.rb` | 70.1% (47/67) | 32-33, 45, 58, 67, 69, 71, 73, 76-77, 79, 85, 87, 94, 96, 109, 114, 116, 118, 120 | Failure rescue that marks the run failed and re-raises (32-33); logged failures of the circuit-breaker observer (45) and of post-sync enrichment (58); ATM-link pass after sync for `track_cash` users (67-79); `scoped_user`/`scoped_pending_transactions` branches for User and BankAccount subjects (85-96); User-subject dispatch (109), BankAccount-subject dispatch (114-118) and "Unsupported subject" failure (120). |
| `app/controllers/admin/bank_transactions_controller.rb` | 70.4% (19/27) | 33, 35, 56, 58, 60, 62, 64, 66 | Hidden-category redirect on `show` (33-35, alert "This transaction is in a hidden category. Remove it from the hidden list in preferences to open it.") and the enrichment-state filters `merchantless` / `llm_ready` / `no_llm_signal` of the index (56-66). |
| `lib/mcp/tools/operations/queue_llm_enrichment.rb` | 72.7% (8/11) | 17-18, 22 | Only the class-level DSL (description/input schema) ran at load; the `call` body (user lookup, scoping, response JSON) never ran because no spec invokes the tool via `tools/call`. Oracle executed it (`POST_mcp.json` case `tools_call:llm_enrichments.create`) [V] |

Takeaways for the Kotlin team: (a) 18 of the 27 low files are MCP tool `call` bodies — cover every tool with a Kotlin integration test
(section 7.5); (b) the User-subject sync path (`SyncUserTransactions`, `transaction_sync_job.rb:109`) is never executed in Ruby although
D-003/X-06 changes exactly this area — the Kotlin test for X-06 is the first executable spec of it; (c) the Gemini provider and the
real `Llm::Client.for` factory are unexecuted because the fake replaces the factory — keep a contract test per provider (section 7.6).

---

## 7. Kotlin parity test strategy

### 7.1 Test pyramid for the rebuild

| Ruby layer | Kotlin equivalent | Port how |
|---|---|---|
| Model specs (`spec/models/**`, 143 examples) | JPA/entity + repository tests on PostgreSQL (Testcontainers), incl. the `ledger_entries` view invariants and encryption round-trip | Port the assertions example by example; keep the spec ids in test names for traceability |
| Service specs (`spec/services/**`, 283 examples) | Unit/integration tests of the Kotlin services against in-memory fakes of the two adapters | Port; the fakes (section 7.6) make these 1:1 |
| Request specs (admin/public 181, API 83, MCP 19) | Spring MVC tests (`MockMvc`/`WebTestClient`) + golden comparisons against the oracle | Port the five-things assertions; add the gaps of section 4 |
| System journeys (16 files, 67 examples) | Playwright end-to-end tests against the running Kotlin app (section 7.4) | Rewrite as browser stories |
| Smoke (48 examples) | One parameterised test over every GET route with fixture ids, asserting 200/30x **and** no error page | Port and tighten |
| Factory lint (1) | Fixture-builder sanity test | Port |

(Counts per layer from section 1.2 **[V]**.) Every deviation row X-01..X-27 in [decisions.md](decisions.md) needs its own Kotlin test
(stated in the register header) — they are the only places where the Kotlin expectation differs from the Ruby suite and oracle.

### 7.2 Reusing the oracle as golden fixtures

The oracle (`../oracle/`) was captured on 2026-10-21 (e.g. `captured_at 2026-10-21T13:22:03.109Z` in
[GET_admin_analytics.json](../oracle/http/GET_admin_analytics.json)) against a real Rails server in `RAILS_ENV=development`, seeded by
`Seeders::Showcase` for two tenants ("main", user id 1, and "other", user id 2) with the repo's own fakes swapped in
(`../tools/oracle_seed.rb`, `../tools/zz_oracle_fakes.rb`, `../oracle/fixture.json`) **[V]**. 205 route sample files, mapped to route keys by
`../oracle/index.json` **[V]**.

Golden-test harness for Kotlin **[I]** (recommendation):

1. **Same seed data.** Port `Seeders::Showcase` (+ `Seeders::Categories`, `Seeders::MerchantRules`) to Kotlin and run it with the Kotlin
   fakes for two tenants exactly as `../tools/oracle_seed.rb` does, including the fixed PATs from `../oracle/fixture.json`
   (`obrl_oracle_main_token_…01`, `obrl_oracle_other_token_…02`, revoked `…03`). Alternative with zero porting risk: restore a Rails-created
   database dump of the seeded state (D-005 requires the Kotlin app to run on Rails-created data anyway).
2. **Same clock and zone.** Run parity tests with `APP_TIME_ZONE=UTC` (D-007) and the clock frozen at the capture instant
   (2026-10-21): default analytics periods in the oracle are month-to-date relative to that day (e.g. MCP `analytics.cash_flow` →
   `"period":{"from":"2026-10-01","to":"2026-10-21","bucket":"day"}` in [POST_mcp.json](../oracle/http/POST_mcp.json)) **[V]**.
3. **Replay each case** (`cases[].request` with the same actor: anon / main session / main token / other …) and compare status, the
   selected headers (`content-type`, `location`, `cache-control`) and `body_sample`.
4. **Normalise volatile values** before comparing: database ids where seeding order may differ (compare via natural keys), timestamps
   (`enriched_at`, `created_at`), `x-request-id`, `duration_ms`, CSRF tokens (`<redacted>` in requests), PAT secrets. HTML pages: compare
   extracted user-visible strings, form field names and link targets rather than raw markup (D-004 keeps templates equivalent, not
   byte-identical).
5. **Skip or invert superseded cases** (7.3) — the Ruby sample documents the old behaviour only.
6. UI: use `../oracle/ui/*.png|html` (1440×900 + 390 px mobile) as visual references for Playwright screenshot comparison with a tolerance;
   [ui_console_errors.txt](../oracle/ui_console_errors.txt) lists the browser errors already present in Ruby.

### 7.3 Oracle cases superseded by the deviation register

| Row | Oracle cases that document Ruby behaviour (not the Kotlin expectation) | Kotlin assertion |
|---|---|---|
| X-01 | No HTTP case; observed while seeding two tenants (BRIEF finding; `EnableBanking::Operations::CreateConnection#find_existing_account`) | Two tenants with the same provider account uid keep separate accounts |
| X-02 | [GET_admin_versions.json](../oracle/http/GET_admin_versions.json) `other_tenant_sees_all_versions -> 200`; [GET_admin_versions__id.json](../oracle/http/GET_admin_versions__id.json) `other_tenant_reads_main_version -> 200` **[V]** | Only own versions; foreign id → 404 |
| X-03 | [GET_sidekiq.json](../oracle/http/GET_sidekiq.json) `authenticated -> 200`; UI [sidekiq_dashboard](../oracle/ui/sidekiq_dashboard.png) **[V]** | JobRunr dashboard, operator-only or disabled |
| X-04 | UI [admin_merchants_show](../oracle/ui/admin_merchants_show.html) shows doubled breadcrumbs "Jedzenie / Jedzenie / W domu / W domu / …" (cited in 20-business-rules.md) | User-scoped ancestry, single breadcrumb per level |
| X-05 | [POST_api__version_merchants.json](../oracle/http/POST_api__version_merchants.json) `foreign_category -> 201` **[V]** | 422 with `{"message","details"}` |
| X-06 | [POST_api__version_transaction_syncs.json](../oracle/http/POST_api__version_transaction_syncs.json) `date_to_before_from -> 201`, `other_tenant_connection -> 201` **[V]** | 400 `Invalid parameters.` / 404 |
| X-07 | No dedicated case | Hidden-category guard on merchant edit/update/destroy |
| X-08 | [GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `from_after_to -> 500` **[V]** | 400 `Invalid parameters.` (API), `isError` (MCP), alert (HTML) |
| X-09 | [PATCH_admin_settings_preferences_llm.json](../oracle/http/PATCH_admin_settings_preferences_llm.json) `invalid_provider -> 500` **[V]** | 422 re-render |
| X-10 | [POST_mcp.json](../oracle/http/POST_mcp.json) `malformed_json -> 500` **[V]** | JSON-RPC −32700 / −32602 |
| X-11 | No case without `mode` (`invalid_mode -> 400` in [POST_api…classification](../oracle/http/POST_api__version_bank_transactions__bank_transaction_id_classification.json) is still valid) | 422 / 400 |
| X-12 | No non-file `bundle` case (`missing_bundle`/`garbage_bundle -> 302` in [import](../oracle/http/POST_admin_settings_preferences_data_exchange_import.json) remain valid) | Redirect with "Bundle file is required." |
| X-13 | [POST_admin_bank_connections.json](../oracle/http/POST_admin_bank_connections.json) `invalid_blank_aspsp -> 204` **[V]** | 422 re-render |
| X-14 | No case | Delete succeeds |
| X-15 | No dedicated case identified | 400/422 |
| X-16 | Every `/rails/action_mailbox/*`, `/rails/conductor/*`, `/rails/active_storage/*`, `*_historical_location` and `/admin/debug*` sample (e.g. [GET_rails_conductor_action_mailbox_inbound_emails.json](../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails.json) `default -> 500`, [GET_recede_historical_location.json](../oracle/http/GET_recede_historical_location.json) `default -> 200`, [GET_admin_debug.json](../oracle/http/GET_admin_debug.json)) **[V]** | 404 (routes absent) |
| X-17 | [GET_api__version_swagger_doc.json](../oracle/http/GET_api__version_swagger_doc.json), [GET_api__version_swagger_doc__name.json](../oracle/http/GET_api__version_swagger_doc__name.json) (Swagger 2.0) **[V]** | OpenAPI 3 document; compare endpoint list, not format |
| X-18 | Not superseded **if** parity runs use `APP_TIME_ZONE=UTC` (7.2); add separate tests for `Europe/Warsaw` day boundaries | "today"/periods in `APP_TIME_ZONE` |
| X-19 | No HTTP case; scheduling observed in [operation_runs_after_capture.jsonl](../oracle/operation_runs_after_capture.jsonl) | Slot-based cadence, single failure count, reaper, lock |
| X-20 | [POST_mcp.json](../oracle/http/POST_mcp.json) `tools_call:transactions.list` and `tools_call:merchants.list` with `{}` arguments return `"count":1` **[V]** | 25 / 50 rows |
| X-21 | [GET_api__version_cash_transactions.json](../oracle/http/GET_api__version_cash_transactions.json) `default`: row `source "atm_link"`, `payment_method "cash_atm_topup"`, `counterparty_kind "unknown"`, enrichment `source "system_fallback"` **[V]** | Category `money.transfers.atm`, counterparty kind `self` |
| X-22 | [PATCH_api__version_cash_transactions__id.json](../oracle/http/PATCH_api__version_cash_transactions__id.json) `default` (sends only `title`, `amount`) — fields omitted from the request are cleared in Ruby **[V]** (request body) | Omitted fields unchanged |
| X-23 | [POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `invalid_amount -> 422`, [POST_admin_cash_transactions.json](../oracle/http/POST_admin_cash_transactions.json) `invalid_amount -> 422`: status stays valid, the side effect (wallet created) differs | No wallet row after a failed create |
| X-24 | No case with blank slug (the `default` case of [POST_admin_categories.json](../oracle/http/POST_admin_categories.json) sends no slug field and stays valid) | Slug generated from the name |
| X-25 | No case with a generated Polish slug (seeded slugs such as `zabka` come from the seeder data) | Transliterated slug |
| X-26 | No `source=system` case (`invalid_enum` uses `source=martian` → 400, still valid) | `source=system` accepted |
| X-27 | Every API `other_tenant_id -> 404` body, e.g. [GET_api__version_cash_transactions__id.json](../oracle/http/GET_api__version_cash_transactions__id.json) `{"message":"Couldn't find ManualTransaction with 'id'=19 [WHERE …"}` **[V]** | Status 404 kept; generic message without SQL — compare status only |

Ruby specs that assert superseded behaviour must be inverted, not ported, e.g. `spec/requests/meta_spec.rb:260,269` (versions readable
without scoping, X-02) and any spec asserting `from > to` raising (`spec/services/analytics/period_spec.rb:6` stays valid at service level;
the HTTP mapping changes per X-08) **[I]**.

### 7.4 System journeys → Playwright end-to-end tests

All 16 journeys run today with rack_test only (no JavaScript). In Kotlin they should become Playwright tests against the running app with
the Kotlin fakes injected and JobRunr executed synchronously where the Ruby spec drains Sidekiq **[I]**. Priority order:

| Ruby journey | Kotlin E2E scope | Notes |
|---|---|---|
| `spec/system/first_run_setup_spec.rb`, `first_time_setup_spec.rb` | Empty DB → `/setup` → dashboard; credential → OAuth callback → manual sync (`first_time_setup_spec.rb:55`) | Core onboarding; compare with UI [setup_first_run](../oracle/ui/setup_first_run.png), [first_run_after_setup_dashboard](../oracle/ui/first_run_after_setup_dashboard.png) |
| `oauth_callback_success_spec.rb`, `oauth_callback_error_spec.rb`, `connection_expiry_reauth_spec.rb` | `/callback` outcomes and re-auth replacement | Must include the X-01 two-tenant uid case |
| `manual_sync_flow_spec.rb`, `auto_sync_tick_spec.rb`, `auto_sync_circuit_breaker_spec.rb` | Sync form → run page with per-account breakdown; scheduled tick; breaker badge | Assertions on cadence follow X-19, not Ruby |
| `cash_with_atm_link_spec.rb` | Cash entry + ATM link listing | ATM top-up category per X-21 |
| `categorization_workflow_spec.rb`, `llm_enrichment_spec.rb` | Rule add → rebuild; LLM proposals with confidence gating | Uses the LLM fake contract (7.6) |
| `settings_change_spec.rb`, `daily_login_analytics_spec.rb` | Category essential flag → dashboard split; login → stat cards | Numeric parity with the oracle (D-009) |
| `data_exchange_round_trip_spec.rb` | Export → wipe → import `.obrbundle`; wrong passphrase; malformed bundle | Also import a bundle produced by Ruby (D-005) |
| `personal_access_token_lifecycle_spec.rb` | Issue → use on API + MCP → revoke → delete | |
| `cross_user_isolation_spec.rb` | Deep links into the other tenant's records → 404 | Extend with every D-003 leak (X-02, X-04..X-07) |
| `spec/system/smoke/*` | Parameterised GET crawl + unauthenticated redirects | Remove the Ruby skips (`/admin/versions*`, `/admin/llm_enrichments/:id`) by seeding the needed records |

Add Playwright coverage that Ruby never had: the JS behaviours listed in section 5 (Stimulus controllers, Turbo Stream run pages,
command palette, privacy mask, mobile 390 px layout per `../oracle/ui/mobile_*`).

### 7.5 Filling the gaps

- Write Kotlin tests from the rule text for the 31 untested and 4 partial rules (section 3.1/3.2); the rake-task rules
  BR-170..176 become tests of whatever operator commands replace them.
- Add request tests for the 16 untested routes (section 4.1) and owned-record positive cases for the "negative only" routes.
- Add one MCP integration test per tool (all 27; 18 have no Ruby spec), using the oracle `tools_call:*` cases as golden output,
  normalising ids.

### 7.6 Golden tests for ActiveRecord-encryption compatibility (D-005)

Encrypted attributes (all non-deterministic: no `deterministic: true` in any `encrypts` call) **[V]** (`app/models/*.rb`):
`TppCredential.application_id`, `TppCredential.private_key_pem` (`app/models/tpp_credential.rb:45`); `BankConnection.session_id`,
`psu_id_hash`, `raw_session_payload` (`app/models/bank_connection.rb:55`); `BankTransaction.raw_payload` (`app/models/bank_transaction.rb:65`);
`BankAccount.raw_balances` (`app/models/bank_account.rb:64`); `LlmSetting.api_key` (`app/models/llm_setting.rb:28`). Ruby only proves
"ciphertext ≠ plaintext and round-trips" (`expect_encrypted_at_rest`, specs listed in 1.2) — not the byte format.

Recommended golden suite **[I]**:

1. With fixed keys (`ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY`, `…_DETERMINISTIC_KEY`, `…_KEY_DERIVATION_SALT`), have the Ruby app write one
   record per encrypted attribute (including multi-line PEM, JSON payloads, unicode, empty string and nil) and export the raw column values
   (`raw_column_value`, `spec/support/encryption_helpers.rb:9-14`) together with the plaintexts as a fixture file.
2. Kotlin test A — **decrypt**: every Ruby ciphertext decrypts to the expected plaintext (AES-256-GCM, JSON envelope `p` + headers `h.iv`,
   `h.at`, PBKDF2-SHA256 key derivation as described in D-005).
3. Kotlin test B — **encrypt → Ruby decrypt**: ciphertexts produced by Kotlin are read back by a small Ruby script (or by the Rails console)
   to the same plaintext; envelope keys/encoding identical.
4. Kotlin test C — **wrong key** fails loudly; nil stays NULL.
5. Repeat A with a database restored from the oracle capture (Rails-created rows) and with a `.obrbundle` exported by Ruby
   (BR-150..157, D-005).

### 7.7 Contract tests for the Enable Banking and LLM adapters

The fakes define the adapter seam the whole Ruby suite runs on; the Kotlin adapters should keep the same seam so that the ported tests and
the oracle stay comparable (ID-6 in [decisions.md](decisions.md)) **[I]**:

- **Enable Banking port** — interface `get(path, params)`, `post(path, body)`, `delete(path)` → `Result(success, status, data, headers, error)`
  covering exactly the paths of the fake (`/application`, `/aspsps`, `/sessions/:id`, `/accounts/:uid/{balances,details,transactions}`,
  `POST /auth`, `POST /sessions`, `DELETE /sessions/:id`) **[V]** (`spec/support/fakes/enable_banking_client.rb:54-116`; pagination via `continuation_key` at `:347-349`). Write one shared
  contract test suite and run it (a) against the Kotlin in-memory fake and (b) against the real HTTP adapter with WireMock stubs that
  replay the wire format proven by `spec/services/enable_banking/adapter_spec.rb` (Bearer JWT, JSON, 4xx/5xx/429 mapping, BR-060..063).
  Include pagination of transactions (`transactions_page_size=`, `continuation_key`) and failure injection (`simulate_failure/429/500`).
- **LLM port** — `structured(systemPrompt, userPrompt, schema) → Map` raising a single `LlmClientError`; run the contract against the fake
  and against each provider adapter (OpenAI, Gemini) with HTTP stubs (WebMock matchers `openai_url`, `gemini_url` show the hosts,
  `spec/support/webmock_config.rb:12-21`). Gemini has 0 % Ruby coverage (section 6), so this is its first test.
- **Factory seam** — Ruby replaces `Llm::Client.for(user:)` wholesale, so its "not configured" error path (`app/services/llm/client.rb:24-31`)
  is untested; the Kotlin factory needs its own test. Note `POST /admin/settings/preferences/llm/test` bypasses `Llm::Client.for` in Ruby
  (BRIEF finding: the oracle made a real OpenAI call) — the Kotlin test must assert that connection tests also go through the injectable port.
- UI-faker and test-helper methods of the fakes (`add_session`, `add_account`, `respond_for_merchant_suggester`, …) should be ported as a
  Kotlin test-fixtures module so journeys read the same as the Ruby specs.

---

## 8. Open points

- No unknown ids were created for this document. Items worth a decision are already covered by the deviation register or listed as gaps
  above: the 31 untested rules, the 16 untested routes, the 18 uninvoked MCP tools, the `admin/llm_enrichments/show` and
  Swagger UI pages, and the absence of any JavaScript-driven test.
- The route/page matching in sections 4–5 is a static analysis of spec sources **[I]**; a dynamic check (Rails request instrumentation
  during `bundle exec rspec`) would confirm it but was not run.
