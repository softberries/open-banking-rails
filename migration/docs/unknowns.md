# Unknowns — open questions

> 171 entries (124 resolved by a decision, the rest default to preserved behaviour). Numbering by area: U-001–099 investigator/environment ·
> U-100–149 domain & data · U-200–249 identity/banking/sync · U-300–349 classification/LLM · U-400–449 cash/ledger/analytics · U-500–549 Rails routes ·
> U-600–649 REST API/MCP · U-700–749 UI · U-800–849 async/integrations/security. **BUG?** marks suspected defects. Several areas found the same
> issue independently — the theme index groups duplicates. Each entry: what is unclear, evidence for/against, who/what can resolve, whether it
> needs a human, proposed default, and its **Resolution** (decision id in [decisions.md](decisions.md)).

## Theme index

| Theme | Entries | Resolution |
|---|---|---|
| T1 Target stack & migration approach | 001, 106, 818, 107, 516 | D-001, D-005 |
| T2 Bug-parity policy | all BUG? entries | D-002 (+ classification table in decisions.md) |
| T3 Tenant isolation / multi-user leaks | 100, 300, 700, 712, 101, 200, 506, 121, 500, 811, 501, 810, 320, 524, 604, 209, 605, 806, 512, 304, 505, 521, 701, 411 | D-003 (fix); U-411 → D-015 |
| T4 Invalid input → 500 / missing validation | 402, 603, 515, 503, 602, 309, 513, 514, 216, 416, 610, 611, 612, 614, 210, 805, 203, 502, 702 | D-002 (fix), D-018 |
| T5 Time zones & scheduling | 120, 202, 405, 201, 221, 206, 800, 801, 803, 804, 204, 205 | D-007, D-008; U-204/U-205 open (preserve) |
| T6 Analytics & cash semantics | 406, 407, 409, 410, 412, 413, 414, 415, 417, 104, 400, 401, 403, 404 | D-009 (keep), D-011 (fix ATM/cash API) |
| T7 Classification & LLM behaviour | 301, 302, 303, 119, 305, 116, 118, 306, 307, 308, 310, 311, 313, 525, 316, 317, 319, 321, 322, 323, 820 | D-010 (keep LLM), D-011 (slug fixes); others preserved |
| T8 Privacy & security posture | 312, 816, 219, 519, 220, 223, 507, 808, 520, 819, 812, 517, 813, 211, 212, 606, 817, 123 | D-012 (parity, hardening backlog), D-010, D-011 (U-606) |
| T9 Data lifecycle, seeds, import/export | 109, 315, 110, 213, 214, 215, 217, 218, 821, 105, 108, 115, 208, 207, 103, 122 | D-013, D-016, D-017; rest preserved |
| T10 Scope: framework/unused/dev & documentation-only features | 005, 509, 510, 802, 314, 408, 616, 511, 522, 523, 617, 608, 609, 613, 615, 607, 600, 601, 707 | D-006, D-014, D-011; rest preserved |
| T11 Operations: mail, observability, deployment | 508, 807, 809, 822, 814, 815, 222, 518, 004 | open — operator topics, preserve (no decision requested) |
| T12 UI details | 703, 704, 705, 706, 708, 709, 710, 711 | preserve (D-004 page contract); U-706 is an oracle-capture note |
| T13 Investigation environment | 002, 003, 006 | no decision needed |

## Things that could not be exercised in the oracle (and why)

See U-004 (external systems only through fakes), U-005 (framework routes, real bank callback with valid state, password reset with a real
token), U-706 (UI captures that depend on interactive state), plus the "Not covered" notes at the end of 30-http-api.md sections marked [I].

## Post-migration backlog (decided: parity now, change later)

D-009 analytics semantics (U-406, U-407, U-409, U-413), D-010 LLM privacy/overwrite behaviour (U-306, U-312, U-318, U-816), D-012 security
hardening (U-223, U-507, U-808, U-812, U-813, U-219, U-519, U-819, U-313, U-520), D-017 re-seed overwrite (U-109, U-315).

## Entries

### U-001 Target stack for the Kotlin service is not defined
- **What is unclear:** The brief refers to a target stack in CLAUDE.md, but no project-level CLAUDE.md exists and Context Fabric has no prior Ruby→Kotlin decisions. Web framework (Spring Boot vs Ktor), persistence (JPA vs jOOQ/Exposed), job runner, UI technology are open.
- **Evidence for / against:** `/home/ubuntu/.claude/CLAUDE.md` only contains TraceVault instructions; `/project-workspace` has no CLAUDE.md; Context Fabric `wiki_find` exact `kotlin|spring|ktor` → no matches.
- **Who/what can resolve:** migration lead / architecture owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Spring Boot 3 + Kotlin, jOOQ (or Spring JDBC) + Flyway, JobRunr, server-rendered templates keeping Hotwire JS.
- **Resolution:** Resolved by D-001 (Spring Boot 3 + JPA/Hibernate + Flyway + Spring Security + JobRunr). **Update 2026-10-22:** `CLAUDE.md` now fixes the target stack (decisions.md ID-7); it agrees with D-001/D-004 and narrows the template engine to JTE.

### U-002 Oracle environment deviates from the brief: no Docker daemon
- **What is unclear:** Nothing functional — recorded for reproducibility. Docker was unavailable (`tcp://localhost:2375` refused, no socket, no sudo). Postgres 17.11 (zonky embedded binaries) and Redis 7.4.2 (built from source) were run in user space on 127.0.0.1:5432/6379 instead.
- **Evidence for / against:** investigator session log; `select version()` → `PostgreSQL 17.11`; `redis-cli ping` → PONG.
- **Who/what can resolve:** n/a (environment). Re-running `oracle.sh` with Docker-provided services should give identical results.
- **Human question?** no
- **Proposed default:** keep as documented.
- **Resolution:** No decision needed. **Verified 2026-10-22:** a re-run with Docker `postgres:17` (17.11) and `redis:7` reproduced the inventory exactly, the spec suite (825 examples / 0 failures, `../inventory/specs_run_docker.json`) and every oracle status code (205 files / 344 cases, 0 mismatches, `../oracle/reproducibility_2026-10-22.json`). The environment deviation has no effect on the specification.

### U-003 Oracle ran in RAILS_ENV=development, not test
- **What is unclear:** Brief says RAILS_ENV=test unless the README says otherwise. The test environment disables CSRF (`config/environments/test.rb: allow_forgery_protection = false`), uses the `test` ActionCable adapter and `:null_store`, which would hide real behaviour. The inventory and spec run used test; the HTTP/UI oracle used development (CSRF on, Redis cable, real Sidekiq worker). Side effects of development mode visible in the samples: detailed exception pages for 500s (production renders `public/500.html`), Bullet footer, `annotate_rendered_view_with_filenames` HTML comments, dev-only `/admin/debug*` routes.
- **Evidence for / against:** config/environments/{test,development}.rb; oracle samples.
- **Who/what can resolve:** n/a.
- **Human question?** no
- **Proposed default:** treat status codes, redirects, flash messages and JSON bodies as the contract; ignore dev-only page decorations.
- **Resolution:** No decision needed (investigation environment).

### U-004 External systems exercised only through in-memory fakes
- **What is unclear:** Enable Banking and LLM providers were replaced in the oracle by the repo's own fakes (`spec/support/fakes/enable_banking_client.rb`, `spec/support/fakes/llm_client.rb`) via a temporary, uncommitted initializer. Real wire behaviour (JWT acceptance, pagination quirks of real ASPSPs, real LLM outputs, rate limits) is only documented from code and `spec/services/enable_banking/adapter_spec.rb` (WebMock).
- **Evidence for / against:** `/workspace/ruby-service-investigator/oracle/zz_oracle_fakes.rb` (oracle script); exception: `POST /admin/settings/preferences/llm/test` bypassed the fake and reached OpenAI with a fake key (operation run `llm_connection_test` failed with `Incorrect API key provided`).
- **Who/what can resolve:** a run against the Enable Banking sandbox with real TPP credentials and a real LLM key.
- **Human question?** no (needs credentials, not a decision) — but see the parity-policy question.
- **Proposed default:** contract tests against the fakes' interface + a manual sandbox smoke test before cut-over.
- **Resolution:** Open: needs Enable Banking sandbox + real LLM key run before cut-over (not a decision).

### U-005 Routes not exercisable with meaningful input
- **What is unclear:** Framework routes were called only with invalid input: ActionMailbox ingresses (postmark/relay/sendgrid/mandrill/mailgun), the ActionMailbox conductor (GET → 500 because `action_mailbox_inbound_emails` does not exist), ActiveStorage blob/representation/disk/direct-upload routes (no blobs exist, tables absent). The Grape mount itself (`MOUNT /`) has no sample of its own (covered by its 58 endpoints). Real bank redirects to `/callback` with a valid state were only exercised by specs (`spec/system/oauth_callback_success_spec.rb`), not by the oracle. Password reset with a valid token was not exercised (needs the e-mailed token).
- **Evidence for / against:** `../oracle/index.json`; `../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails.json`.
- **Who/what can resolve:** scope decision (are framework routes part of the contract?).
- **Human question?** yes (scope) — folded into the framework-routes question.
- **Proposed default:** do not port ActionMailbox/ActiveStorage/ActionText/turbo-native routes.
- **Resolution:** Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).

### U-006 First-run `/setup` capture required truncating users
- **What is unclear:** Nothing functional. To capture the first-run flow the oracle truncated `users` (cascade) at the end of the run; the setup samples are appended as extra cases to `GET_setup.json`/`POST_setup.json` and screenshots `setup_first_run*.png`.
- **Evidence for / against:** `oracle.sh`.
- **Who/what can resolve:** n/a.
- **Human question?** no
- **Proposed default:** n/a.
- **Resolution:** No decision needed (investigation environment).

### U-100 BUG? Category tree helpers are not tenant-scoped (duplicated breadcrumbs, cross-tenant leaks)
- **What is unclear:** `Category#ancestors`, `#descendants`, `#self_and_descendants`, `#children`, `#parent`, `#in_use?` and `#breadcrumb_names` query `Category` by ltree path without `user_id` (`app/models/category.rb:83-119`). Since migration `20260507180000`, paths are only unique per user, and every user gets the same seeded paths. The effects: (a) breadcrumbs list each ancestor once per tenant; (b) the other tenant's category **names** are shown (information leak, e.g. a renamed category); (c) `in_use?` returns true when another tenant has descendants, which blocks deletion; (d) `parent` may return the other tenant's row; (e) the analytics category page's subtree/ancestor lists mix tenants (`app/controllers/admin/analytics/categories_controller.rb:19,35`, `lib/api/resources/analytics/categories.rb:26`).
- **Evidence for / against:** Oracle with two tenants: [oracle](../../oracle/ui/admin_cash_transactions_new.html) contains "Jedzenie / Jedzenie / W domu / W domu / Supermarkety" and "Jedzenie / Jedzenie / Oracle API Category Renamed" [V]. The spec `spec/models/category_spec.rb:103` covers a single user only. By contrast, `Categories::Mover` scopes its rewrite to the user (`spec/services/categories/mover_spec.rb:61`).
- **Who/what can resolve:** product owner (confirm the bug), developer.
- **Human question?** yes (fix vs keep; the fix is almost certainly wanted)
- **Proposed default:** In Kotlin, scope every tree query by `user_id` of the category (`WHERE user_id = :uid AND path <@ :p`).
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-101 BUG? BankAccount uid is globally unique and account lookup is not scoped to the tenant
- **What is unclear:** `bank_accounts.uid` has a global unique index (`db/schema.rb:49`), and `CreateConnection#find_existing_account` does `BankAccount.find_by(uid:)` unscoped (`app/services/enable_banking/operations/create_connection.rb:85-93`). The upsert then reassigns `tpp_credential` and `current_bank_connection` to the new credential (`:55-73`). If a second tenant's bank returns the same uid, that tenant takes over the first tenant's account and its whole transaction history.
- **Evidence for / against:** Code reading [I]. The investigator observed it while seeding two tenants (brief). I did not reproduce it independently. Wallet uids embed the user id (`cash_<user_id>_<cur>`, `app/services/cash/wallet_resolver.rb:35-37`), so wallets are unaffected.
- **Who/what can resolve:** product owner; running two tenants against a bank returning identical uids.
- **Human question?** yes (bug-to-fix and the uniqueness scope for the new schema)
- **Proposed default:** Make the uid unique per `tpp_credential_id` (or per user) and scope the lookup to the credential.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-102 BUG? LedgerEntryConcern delegates `enrichment_source` / `enrichment_confidence` to methods that do not exist
- **What is unclear:** `delegate :merchant, :category, :enrichment_source, :enrichment_confidence, to: :enrichment, allow_nil: true` (`app/models/concerns/ledger_entry_concern.rb:14-15`). `TransactionEnrichment` has `source` and `confidence`, but no `enrichment_source`/`enrichment_confidence`. Calling these on a transaction that has an enrichment would raise NoMethodError. With no enrichment they return nil (`spec/models/concerns/ledger_entry_concern_spec.rb:6,19` [V]).
- **Evidence for / against:** grep finds no callers in app/lib (only `params[:enrichment_source]` and helpers named `enrichment_source_*`) [I].
- **Who/what can resolve:** developer.
- **Human question?** no
- **Proposed default:** Expose `enrichmentSource`/`enrichmentConfidence` on the Kotlin ledger entity as `enrichment?.source` / `enrichment?.confidence`.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-103 Enum values that no code path ever produces
- **What is unclear:** Several allowed values are never written: `TransactionEnrichment.source = "llm_pending"` (only UI labels, `app/helpers/admin/enrichment_helper.rb:9,19`); `BankConnection.status = "pending"` (DB default only; connections are created `authorized`, `create_connection.rb:38`); `BankAccount.status = "inactive"/"revoked"`; `OperationRun.kind = balance_refresh / connection_refresh / account_details_refresh` (no `OperationRun.create!` with those kinds, grep of app/lib); `ManualTransaction.source = csv_import / recurring` ("reserved", `db/migrate/20260430120001_create_manual_transactions.rb:31-33`).
- **Evidence for / against:** grep of `app/`, `lib/` [I]. Oracle runs contain only transaction_sync, llm_enrichment, llm_connection_test, data_export (`oracle/operation_runs_after_capture.jsonl`) [V].
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope: keep the reserved values in Kotlin enums?)
- **Proposed default:** Keep all values in the Kotlin enums (data import/export and filters accept them) but implement no producers.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-104 BUG? ATM top-up enrichment looks up a category slug that is never seeded
- **What is unclear:** `Cash::AtmWithdrawalLinker` builds the top-up's enrichment with `category: user.categories.find_by(slug: "cash_atm_topup")` (`app/services/cash/atm_withdrawal_linker.rb:46-50`). The seeded taxonomy has no such slug (seed slugs are full paths with underscores, e.g. `money_transfers_atm`, `app/services/seeders/categories.rb:171,203`). The top-up is therefore stored with `source = system_fallback` and `category_id = NULL`, which makes it unmatched in analytics until a later `rebuild!` re-enriches it through the payment-method fallback (`credit, cash_atm_topup → money.transfers.atm`, `app/services/enrichment/transaction_enricher.rb:39`).
- **Evidence for / against:** The spec `spec/services/cash/atm_withdrawal_linker_spec.rb:30` compares against the same nil lookup, so it passes vacuously [I].
- **Who/what can resolve:** developer / product owner.
- **Human question?** no (the intent is clear from the comments: the pair is a transfer)
- **Proposed default:** Use the category at path `money.transfers.atm` (the enricher's fallback) for the top-up.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-105 PaperTrail history: `whodunnit` never recorded; YAML with Ruby tags
- **What is unclear:** No controller sets `whodunnit`, so every `versions.whodunnit` is NULL, even though the UI shows a "By" column (`app/views/admin/versions/index.html.erb:62,86`). `object`/`object_changes` are Psych YAML containing `!ruby/object:ActiveSupport::TimeWithZone` tags and anchors. Should the Kotlin service record the actor, and must historical versions be converted?
- **Evidence for / against:** oracle `server.log.txt` INSERT INTO "versions" … whodunnit NULL; YAML bodies [V]. grep of app finds no `whodunnit` assignment [I].
- **Who/what can resolve:** product owner (audit requirements); migration owner.
- **Human question?** yes (migration choice)
- **Proposed default:** The Kotlin audit log records the acting user id. Convert historical rows once to JSON (parse the YAML with a Ruby-tag-tolerant parser, or export from Rails before cut-over), keeping `whodunnit` NULL for history.
- **Resolution:** Resolved by D-005 (in-place compatibility: Flyway baseline from schema.rb, Rails AR-encryption format, PaperTrail YAML kept).

### U-106 Encrypted-at-rest data: Rails ActiveRecord-encryption compatibility
- **What is unclear:** 8 columns plus copies in `versions` (BankAccount `raw_balances`) hold Rails AR-encryption envelopes `{"p","h":{"iv","at"[,"c"]}}` (AES-256-GCM, key derived from env primary key + salt, optional zlib compression). A Kotlin service must either implement a Rails-compatible decryptor/encryptor or re-encrypt the data during migration. ADR 0004 also states that "PaperTrail skips them", which is false for `BankAccount.raw_balances` (`app/models/bank_account.rb:71`).
- **Evidence for / against:** `docs/adr/0004-encryption-at-rest.md:15-23`; `config/initializers/active_record_encryption.rb:15-32`; envelopes observed in oracle `server.log.txt` (including inside BankAccount versions) [V]. KDF/cipher details are Rails defaults, not verified by execution [I].
- **Who/what can resolve:** migration owner; a spike decrypting a sample with the JVM.
- **Human question?** yes (migration choice)
- **Proposed default:** A one-off Rails-side export that decrypts and re-encrypts with the Kotlin scheme (e.g. AES-GCM via Tink), plus stripping or re-encrypting `raw_balances` inside migrated versions.
- **Resolution:** Resolved by D-005 (in-place compatibility: Flyway baseline from schema.rb, Rails AR-encryption format, PaperTrail YAML kept).

### U-107 Migrations cannot be replayed on an empty database
- **What is unclear:** `20260430230000_scope_categories_merchants_rules_to_user` raises "Cannot backfill - no User exists. Create one first." when `users` is empty (`db/migrate/20260430230000_scope_categories_merchants_rules_to_user.rb:19-20`), so a fresh install depends on `db:schema:load`, not `db:migrate`. Migration #15 also calls application code (`EnableBanking::PaymentMethodInferer`).
- **Evidence for / against:** Code reading [I]. The oracle DB was built from the schema (33 schema_migrations rows) [V].
- **Who/what can resolve:** none needed.
- **Human question?** no
- **Proposed default:** The Flyway baseline is generated from the final `db/schema.rb` (see 50-data §5). Do not port individual migrations.
- **Resolution:** Resolved by D-005 (in-place compatibility: Flyway baseline from schema.rb, Rails AR-encryption format, PaperTrail YAML kept).

### U-108 `categories.path` is nullable in the DB but mandatory in the model
- **What is unclear:** Migration 24 added `path` without a backfill or NOT NULL (`db/migrate/20260501140000_layered_categories_foundation.rb:60-62`). The model requires presence (`app/models/category.rb:56`). Rows with NULL path would be invisible to every ltree query and to the view's `category_path`.
- **Evidence for / against:** `db/schema.rb:118` [I]. The oracle has seeded rows only (all with paths).
- **Who/what can resolve:** migration owner (check production for NULL paths).
- **Human question?** yes (migration choice)
- **Proposed default:** `path ltree NOT NULL` in the Kotlin baseline, after verifying that no NULLs exist (or after reseeding).
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-109 Re-running the seeders overwrites user customisations of seeded rows
- **What is unclear:** `Seeders::Categories` re-assigns `name`, `kind`, `color`, `icon`, `essential`, `path`, `position` on every seeded slug (`app/services/seeders/categories.rb:200-216`). `Seeders::MerchantRules` re-assigns merchant `name`, `kind`, `source`, `default_category` and rule `kind`/`enabled` (`app/services/seeders/merchant_rules.rb:270-349`). The admin button `POST /admin/onboarding/seed_taxonomy` and `db:seed` therefore revert renames, moves (the path is reset while descendants are not), kind changes and disabled system rules. ADR 0010 says renames are safe because only `name` changes (`docs/adr/0010-three-layer-category-model.md:38-40`).
- **Evidence for / against:** `spec/services/seeders/categories_spec.rb:18` asserts "re-applies attribute changes" [V], so this is intended for definition edits. Whether user edits should survive is not stated.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Replicate as-is (idempotent upsert keyed by slug that overwrites), and document the button as "reset baseline taxonomy".
- **Resolution:** Resolved by D-017 — keep overwrite-on-reseed behaviour.

### U-110 User deletion semantics are undefined
- **What is unclear:** There is no UI/API to delete a user. Through `dependent: :destroy` chains, deletion would fail when a credential has connections or accounts (`restrict_with_error`, `app/models/tpp_credential.rb:42-43`), and order-dependent FK errors are possible (e.g. `manual_transactions.created_by_user_id` pointing at another user). ADR 0009 assumes "cascade-on-user-delete" for operation runs.
- **Evidence for / against:** `app/models/user.rb:27-45`; `docs/adr/0009-operation-run-tracker.md:32` [I]. Only token cascade is spec'd (`spec/models/personal_access_token_spec.rb:120` [V]).
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** Out of scope for parity. If implemented, do a full tenant purge in one transaction, in FK order.
- **Resolution:** Resolved by D-016 — no user-deletion feature.

### U-115 Bank transaction edge cases: zero amounts and pending rows that change id on booking
- **What is unclear:** (a) `bank_transactions.amount_cents` has no positivity rule (the manual table requires > 0), so a 0.00 bank entry is stored and counts as a debit (signed `-0`). (b) Sync updates a pending row only when the booked version keeps the same `external_id`. If the bank issues a new id at booking, the stale pending row remains forever (no cleanup) (`app/services/enable_banking/operations/sync_account_transactions.rb:66-76`).
- **Evidence for / against:** Code reading [I]. No spec covers either case.
- **Who/what can resolve:** bank data analysis / product owner.
- **Human question?** yes (bug-to-keep-or-fix for b)
- **Proposed default:** Keep the behaviour (parity). Log a follow-up to purge pending rows older than N days that were not seen in the latest sync window.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-116 Three different slug algorithms for merchants
- **What is unclear:** `Merchant#generate_slug` NFD-normalises before stripping marks ("Żabka" → `zabka`, `app/models/merchant.rb:83-88`). `Merchants::Creator#generate_slug` and `Llm::EnrichmentRunner#slugify` strip `\p{M}` **without** NFD normalisation, so precomposed letters like "Ż" become `_` and are trimmed (`abka`) (`app/services/merchants/creator.rb:35-45`, `app/services/llm/enrichment_runner.rb:178-181`). The Creator also adds `_2`, `_3` suffixes. The LLM runner can therefore create a second merchant for a seeded one (`zabka` vs `abka`). Categories::Creator uses the non-NFD variant too.
- **Evidence for / against:** Code reading [I]; `spec/models/merchant_spec.rb:43` covers only the model path [V].
- **Who/what can resolve:** developer.
- **Human question?** no
- **Proposed default:** One slug function in Kotlin (NFD + strip marks + `[^a-z0-9]+`→`_` + trim), with `_n` dedupe where the Creator does it.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-118 Category `slug` vs path leaf are inconsistent by construction
- **What is unclear:** The model comment and ADR 0010 say `slug` is the leaf segment, but seeded slugs are the full path with underscores (`food_cooking_supermarket` for leaf `supermarket`), and the model accepts any slug that differs from the leaf (`ensure_path_ends_with_slug` only fills a blank slug, `app/models/category.rb:135-140`). User-created categories get `slug` = name-derived and `path = parent + "." + slug` (`app/services/categories/creator.rb:19-22`). A slug containing `-` (allowed by the slug format) makes the path invalid ("must be lowercase letters, digits, underscores, dot-separated").
- **Evidence for / against:** `spec/models/category_spec.rb:76` [V] (an explicit slug is left alone).
- **Who/what can resolve:** product owner / developer.
- **Human question?** no
- **Proposed default:** Replicate: slug and path are independent keys, and both are unique per user. Do not derive one from the other except on create.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-119 BUG? Deleting a category that some user has hidden raises a FK error
- **What is unclear:** `Category` declares no association to `user_hidden_categories`, and the FK is NO ACTION (`db/schema.rb:397`). `in_use?` ignores hidden-category rows, so `DELETE /admin/categories/:id` (or the API) on an unused but hidden category hits `PG::ForeignKeyViolation`, which surfaces as a 500 [I].
- **Evidence for / against:** `app/models/category.rb:48-50,112-114`; `app/controllers/admin/categories_controller.rb:54-62` [I]. Not exercised in the oracle.
- **Who/what can resolve:** running the scenario; developer.
- **Human question?** no
- **Proposed default:** Delete the user_hidden_categories rows together with the category (nullify/destroy cascade).
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-120 `preferred_hour` is documented as user-local but is evaluated in UTC
- **What is unclear:** The migration comment says "0..23 in the user's local timezone" (`db/migrate/20260502170613_create_sync_schedules.rb:13-15`), but `User` has no `timezone` attribute, so `ScheduleUpserter`/`Dispatcher` always pass `"UTC"` (`app/services/auto_sync/schedule_upserter.rb:134-136`, `app/services/auto_sync/dispatcher.rb:94-96`). A Polish user choosing 8 gets 08:00 UTC (09:00/10:00 Warsaw).
- **Evidence for / against:** `spec/services/auto_sync/next_run_calculator_spec.rb:67` verifies zone handling only when a zone is passed [V]. The users table has no timezone column [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Keep UTC for parity. Add a per-user timezone later if requested.
- **Resolution:** Resolved by D-007 — instance-wide APP_TIME_ZONE (default Europe/Warsaw).

### U-121 BUG? `versions` has no tenant column and is exposed to every tenant
- **What is unclear:** The audit table has no user/tenant column, and `/admin/versions` and `/admin/versions/:id` read `PaperTrail::Version` unscoped (`app/controllers/admin/versions_controller.rb:6,10`). Versions contain other tenants' manual transactions, credential metadata and account data.
- **Evidence for / against:** [oracle](../../oracle/http/GET_admin_versions.json) case `other_tenant_sees_all_versions` → 200; [oracle](../../oracle/http/GET_admin_versions__id.json) case `other_tenant_reads_main_version` → 200 [V].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-fix; the fix shapes the Kotlin audit schema)
- **Proposed default:** Add `owner_user_id` to the Kotlin audit table (resolved from the item at write time), filter the reads by it, and backfill it during migration by joining through each item type.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-122 Inconsistent documentation of `noise.unmatched.other` kind
- **What is unclear:** `Llm::EnrichmentRunner#resolve_category_for` says unknown LLM paths fall back to `noise.unmatched.other` "(kind=ignored) - keeps the merchant … invisible to spend totals" (`app/services/llm/enrichment_runner.rb:186-191`), but the seed defines `noise.unmatched.*` as `kind: "expense"`, deliberately counted in spend (`app/services/seeders/categories.rb:182-190`). LLM merchants with an unknown category path therefore **do** count as spend.
- **Evidence for / against:** Code reading [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Follow the seed (expense), which is the current runtime behaviour.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-123 First-run setup is not atomic
- **What is unclear:** `SetupController#create` saves the user, then runs both seeders outside a transaction (`app/controllers/setup_controller.rb:17-21`). If a seeder raises, the user exists without a taxonomy and `/setup` is closed (it redirects once a user exists). Recovery is via `POST /admin/onboarding/seed_taxonomy`.
- **Evidence for / against:** Code reading [I]; `spec/requests/public_spec.rb:29` covers the happy path only [V].
- **Who/what can resolve:** developer.
- **Human question?** no
- **Proposed default:** Run user creation and seeding in one transaction in Kotlin.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

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
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

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
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

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
- **Resolution:** Resolved by D-007 — instance-wide APP_TIME_ZONE (default Europe/Warsaw).

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
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

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
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

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
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

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
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

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
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

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
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

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
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

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
- **Resolution:** Resolved by D-018 — reject inverted sync windows (400 / alert).

### U-211 PAT accepted without the `Bearer` scheme
- **What is unclear:** The authenticator strips an optional `Bearer ` prefix, so `Authorization: obrl_…` (no scheme) also
  authenticates. Specs only prove that non-`obrl_` values (e.g. `Basic …`) are rejected.
- **Evidence for / against:** `lib/api/helpers/auth_helper.rb:17-21`; `app/controllers/mcp_controller.rb:20-22`;
  `spec/support/auth_helpers.rb:64`. Rule BR-019.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** Keep it lenient for compatibility with existing clients, and document it.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-212 PAT name uniqueness: case-insensitive in the app, case-sensitive in the DB
- **What is unclear:** The application check rejects names that differ only by case. The DB index `(user_id, name)` is
  case-sensitive, so concurrent requests could slip through.
- **Evidence for / against:** `app/models/personal_access_token.rb:21,34-36`. Rule BR-017.
- **Who/what can resolve:** none needed.
- **Human question?** no.
- **Proposed default:** Enforce case-insensitive uniqueness in the DB (index on `lower(name)`).
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

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
- **Resolution:** Resolved by D-013 — keep data-exchange scope and behaviour.

### U-214 Importing a primary credential next to an existing primary fails the whole import
- **What is unclear:** `primary` is copied on insert. If the bundle contains a credential with `primary = true` under a new
  `(name, provider)` and the user already has a primary credential, validation fails ("Primary another credential is already primary
  for this user") and the whole import rolls back.
- **Evidence for / against:** `app/services/data_exchange/resources/tpp_credential_resource.rb:5-18`;
  `app/models/tpp_credential.rb:73,123-129`; `app/services/data_exchange/operations/import.rb:113-117`. Rule BR-155.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** On insert, set `primary = false` when the user already has a primary credential.
- **Resolution:** Resolved by D-013 — keep data-exchange scope and behaviour.

### U-215 Scope of data exchange (no transactions, categories, merchants…)
- **What is unclear:** Only credentials, connections and accounts are exchanged. Bank and manual transactions, categories, merchants,
  rules, enrichments, schedules and LLM settings are not. Is the bundle meant for instance migration (then it is incomplete) or only
  for moving bank wiring?
- **Evidence for / against:** `app/services/data_exchange/registry.rb:9-13`; `app/services/data_exchange/resources/base.rb:78-82`
  (comment mentions Enrichment ownership, suggesting more resources were planned). Rule BR-153.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** Rebuild exactly the three resources and format version 1 so existing bundles stay importable.
- **Resolution:** Resolved by D-013 — keep data-exchange scope and behaviour.

### U-216 Connection creation without `access` flags leads to a database error (HTTP 500)
- **What is unclear:** `access_balances` and `access_transactions` are copied from the session payload even when absent (NULL), but
  the columns are NOT NULL. The resulting database error is not a validation error, so it escapes the "Could not save records" handling
  and becomes a 500 on `/callback`.
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:42-43,27-28`;
  `app/models/bank_connection.rb:8-9`. Rule BR-075.
- **Who/what can resolve:** checking Enable Banking's `POST /sessions` contract (whether `access` is always returned).
- **Human question?** no.
- **Proposed default:** Default missing flags to `true` (the column default).
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-217 Credential deletion may report success without deleting
- **What is unclear:** The controller checks only for bank connections. The model also restricts deletion while bank accounts exist.
  If a credential had accounts but no connections, the destroy fails silently and the UI still shows "Credential deleted.".
- **Evidence for / against:** `app/controllers/admin/tpp_credentials_controller.rb:42-50`; `app/models/tpp_credential.rb:42-43`. Rule BR-054.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** Check the destroy result and show the refusal alert when it fails.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-218 "Unsupported subject" error is overwritten
- **What is unclear:** For a run whose subject is neither a user, a connection nor an account (e.g. the subject was deleted), the job
  fails the run with "Unsupported subject: …". The finaliser then runs anyway and overwrites the error with "No accounts in scope".
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:28,119-121`; `app/services/operation_run_finalizer.rb:17`. Rule BR-116.
- **Who/what can resolve:** none needed.
- **Human question?** no.
- **Proposed default:** Stop after the unsupported-subject failure and keep its message.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

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
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-220 Replaced connection's consent is left open at the provider
- **What is unclear:** When a connection is replaced, the old one is set to `replaced` locally, but `DELETE /sessions/{id}` is not
  called. Closing the connection does call it. Should replacement revoke the old consent?
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:98-100` vs
  `app/services/enable_banking/operations/close_connection.rb:20-26`. Rule BR-080.
- **Who/what can resolve:** product owner.
- **Human question?** yes.
- **Proposed default:** Best-effort close of the old remote session after a successful replacement.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-221 Circuit breaker re-trips after a single failure once the cooldown ends
- **What is unclear:** `consecutive_failures` is only reset by a success. After the 24 h pause, the next non-success makes the count 4
  (≥ 3) and pauses again immediately. A `partial` run (some accounts failed) also counts as a failure. Intended?
- **Evidence for / against:** `app/services/auto_sync/circuit_breaker.rb:22-41`. Rule BR-133.
- **Who/what can resolve:** product owner.
- **Human question?** yes.
- **Proposed default:** Keep the current behaviour (conservative).
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

### U-222 Post-sign-in redirect target
- **What is unclear:** After sign-in, Devise redirects to the last stored protected location. In the oracle this was `/api/v9/docs`,
  a URL captured earlier as anonymous, rather than `/admin`. Should the target be restricted to admin paths?
- **Evidence for / against:** [oracle](../oracle/http/POST_admin_sign_in.json) case `valid_credentials` → 303 `http://127.0.0.1:3000/api/v9/docs`;
  `spec/requests/public_spec.rb:193` expects `/admin` without a stored location. Rule BR-007.
- **Who/what can resolve:** product owner.
- **Human question?** no.
- **Proposed default:** Redirect to the stored location only if it is an internal path, otherwise to `/admin`.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-223 Password reset reveals whether an e-mail is registered
- **What is unclear:** Devise paranoid mode is off. An unknown e-mail on `POST /admin/password` returns 422 with a "not found" error,
  while a known e-mail redirects. This allows checking whether an account exists. Intended for a self-hosted single-user app?
- **Evidence for / against:** `config/initializers/devise.rb:93`; [oracle](../oracle/http/POST_admin_password.json) case
  `unknown_email` → 422, case `known_email` → 303. Rule BR-010.
- **Who/what can resolve:** product owner / security owner.
- **Human question?** yes.
- **Proposed default:** Enable paranoid behaviour: always redirect with "If your email address exists in our database, you will
  receive a password recovery link at your email address in a few minutes.".
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-300 BUG? Category tree helpers are not scoped to the user (cross-tenant leakage)
- **What is unclear:** `Category#descendants`, `#children`, `#ancestors`, `#parent`, `#self_and_descendants` and therefore `#breadcrumb_names` and `#in_use?` query the whole `categories` table without `user_id`. With two tenants holding the same paths:
  - every breadcrumb lists each ancestor once per tenant, and shows the *other* tenant's names if they were renamed;
  - `in_use?` refuses to delete a category when another tenant has a descendant under the same path;
  - `parent` can return another tenant's row.
- **Evidence for / against:** `app/models/category.rb:83-119`. Oracle: [merchant show](../oracle/ui/admin_merchants_show.html) renders `Jedzenie / Jedzenie / W domu / W domu / Supermarkety`; [merchants index](../oracle/ui/admin_merchants_index.html) and [bank transactions index](../oracle/ui/admin_bank_transactions_index.html) show the same pattern. The server log SQL `SELECT 1 … FROM "categories" WHERE (path <@ 'food.oracle_ui_category' AND path != …)` has no `user_id` predicate (`../oracle/server.log.txt` ~16565). In contrast, `Categories::Mover#rewrite_descendant_paths` *is* scoped (`spec/services/categories/mover_spec.rb:61`).
- **Who/what can resolve:** product owner (confirm it is a bug).
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** fix in Kotlin. Every tree query is filtered by `user_id`. Breadcrumbs then show each ancestor once.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-301 BUG? Creating a category from the admin form with an empty Slug field
- **What is unclear:** `Categories::Creator` uses `category.slug ||= generate_slug(name)`. The admin form always submits `category[slug]`, so an empty field arrives as `""`, which is not nil. Generation is skipped and the path becomes `"<parent>."` or `""`.
  - With a parent, the model back-fills slug = parent's last label. Validation then fails with `Slug has already been taken` and `Path must be lowercase letters, digits, underscores, dot-separated`.
  - At root it fails with `Slug can't be blank` etc.

  This would make "New category" in the UI unusable unless a slug is typed. The oracle and the specs only created categories without the `slug` key (API, MCP, synthetic POST).
- **Evidence for / against:** `app/services/categories/creator.rb:21-22`; `app/views/admin/categories/_form.html.erb:21-25` (slug field, no JS fill); `app/models/category.rb:135-140`. [oracle](../oracle/http/POST_admin_categories.json) `default` case has no slug key → 302 (works). No spec submits the real form for "new".
- **Who/what can resolve:** run a Playwright submit of `/admin/categories/new` with an empty slug field; product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** treat a blank slug as "generate" (fix).
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-302 BUG? Category move gaps: no move to root, slug/path desync, cycles not prevented
- **What is unclear:** `Categories::Mover` only recomputes `path` when `parent_path` is present. Three gaps follow:
  - **No move to root.** Picking "- top-level (new root) -" (blank) does not move the category to the root.
  - **Slug/path desync.** Changing only the slug leaves the path leaf unchanged.
  - **Cycles.** Nothing server-side prevents moving a category under its own descendant. The HTML form hides those options, the API and MCP do not. The descendant rewrite would then produce corrupted paths such as `food.cooking.food.cooking…`.

  Seeded categories have slug ≠ leaf (`food_cooking_bakery` vs `bakery`), so moving one composes `newparent.food_cooking_bakery`.
- **Evidence for / against:** `app/services/categories/mover.rb:25-37,55-61`; `app/views/admin/categories/_form.html.erb:3-9`; `lib/api/resources/categories.rb:74`.
- **Who/what can resolve:** product owner; reading/running `PATCH /api/v1/categories/:id` with `parent_path` set to a descendant.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** in Kotlin, allow an explicit "root" move, reject `parent_path` under the category's own subtree with 422, and keep the leaf label = slug for user-created categories.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-303 BUG? Deleting an unused but hidden category would violate a foreign key
- **What is unclear:** `Category#in_use?` ignores `user_hidden_categories`, and `Category` declares no `has_many :user_hidden_categories, dependent: …`. Deleting a category that is otherwise unused but hidden by the user would raise `ActiveRecord::InvalidForeignKey`, giving a 500.
- **Evidence for / against:** `app/models/category.rb:49-50,112-114`; `app/models/user_hidden_category.rb:19-22` (FK `category_id → categories.id`); `app/controllers/admin/categories_controller.rb:54-62`. Not exercised by the oracle or specs.
- **Who/what can resolve:** run the scenario; product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** delete the hidden-category rows together with the category (cascade).
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-304 BUG? Merchant edit page ignores the hidden-category guard
- **What is unclear:** `Admin::MerchantsController` defines `edit` twice. The first version redirects with `This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it.`. The second, empty definition (line 58) overrides it, so `/admin/merchants/:id/edit` renders for merchants in hidden categories and exposes name and notes. The show page *is* guarded.
- **Evidence for / against:** `app/controllers/admin/merchants_controller.rb:37-42,58-59`; `spec/requests/categorization_spec.rb:231` covers only show. Not observed in the oracle (the edited merchant was not hidden).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** apply the guard on edit as clearly intended.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-305 Slug generation does not transliterate Polish/accented letters in three of four places
- **What is unclear:** `Merchant#generate_slug` NFD-normalizes first (`Żabka` → `zabka`). `Categories::Creator`, `Merchants::Creator` and `Llm::EnrichmentRunner#slugify` do not:
  - `Żabka` → `abka`, `Mobilność` → `mobilno`, `Łódź Kebab` → `d_kebab`;
  - an all-Cyrillic name gives an empty base. For categories this means a validation error; for merchants it means the model fallback `merchant_<hex>`.

  Because the LLM runner reuses an existing merchant by slug, the non-NFD slug also determines merchant identity for LLM suggestions.
- **Evidence for / against:** `app/models/merchant.rb:86`; `app/services/categories/creator.rb:40-44`; `app/services/merchants/creator.rb:36`; `app/services/llm/enrichment_runner.rb:180`. Reproduced with pure Ruby expression evaluation. `spec/models/merchant_spec.rb:43` covers only the model path.
- **Who/what can resolve:** product owner (slugs are user-visible in URLs and exports).
- **Human question?** yes (migration choice: byte-identical slugs vs fixed transliteration)
- **Proposed default:** reproduce the exact current algorithms for parity, because existing slugs are persisted. Optionally fix for new records only.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-306 BUG? LLM suggestions overwrite existing system/user merchants (incl. default category)
- **What is unclear:** `EnrichmentRunner#upsert_merchant` finds an existing merchant by slug and overwrites `name`, `kind`, `confidence`, `model` and `default_category`, even for below-threshold (pending) suggestions. Only `source` is preserved. If the LLM names a merchant whose slug equals a seeded or user merchant, e.g. "Biedronka" for an unmatched title variant, that merchant's default category can be changed silently. This retroactively re-categorizes all of its transactions and contradicts ADR 0005 ("LLM never silently overrides a user decision").
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:148-163`; `docs/adr/0005-llm-confidence-gating.md:20-21`. Mitigation: groups matched by any existing rule are not sent (`app/services/llm/enrichable_query.rb:29-41`). Not covered by specs.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** in Kotlin, only fill attributes that are empty on an existing non-LLM merchant, and never change its `default_category`.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-307 BUG? Some LLM failures abort the whole run instead of a batch or item
- **What is unclear:** Two failure paths escape the per-batch and per-item handling. In both cases the job marks the run failed with `<Class>: <message>` and re-raises:
  - **Invalid regex.** An LLM-proposed `rule_kind = regex` with an invalid pattern raises `RegexpError` while probing the sample (`MerchantRule#matches?` → `compiled_regex`). Only `ActiveRecord::RecordInvalid` (per item) and `Llm::Client::Error` (per batch) are rescued.
  - **Client resolution.** It happens outside the batch `begin/rescue`, so `Llm::Client::NotConfiguredError` (the key was removed after queueing) also aborts.
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:41-73,115-119`; `app/models/merchant_rule.rb:79,87-89`; `app/jobs/llm_enrichment_job.rb:48-50`. Not exercised.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** treat an invalid LLM pattern as "skipped", and treat not-configured as a clean failed run.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-308 BUG? "All transactions for this merchant" assignment is not sticky
- **What is unclear:** Mode `all_for_merchant` sets `source = user_rule`, `category_overridden = false` and does not attach a rule. The row is rebuildable, so the next `rebuild!` re-runs matching. If no rule matches that transaction's fields, the merchant is replaced by the fallback or `unmatched`, and the user's choice disappears. The mode also leaves the previous `merchant_rule_id`, `confidence` and `model` on the row.
- **Evidence for / against:** `app/services/enrichment/classification_applier.rb:68-79`; `app/services/enrichment/transaction_enricher.rb:96-124`; `spec/services/enrichment/classification_applier_spec.rb:46` asserts only the immediate state.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep current semantics for parity, but flag in UI tests. Alternative: write `source = manual` with `category_overridden = false`.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-309 BUG? Classification request without `enrichment[mode]` returns 500
- **What is unclear:** `ClassificationApplier::Input#normalized_mode` calls `mode.to_sym`. A nil mode (parameter omitted) raises `NoMethodError`, which is not rescued and gives a 500. An empty string yields `Unknown propagation mode: ` instead.
- **Evidence for / against:** `app/services/enrichment/classification_applier.rb:15,35-36`; `app/controllers/admin/transaction_enrichments_controller.rb:7-13`. The oracle always sent a mode.
- **Who/what can resolve:** run `PATCH /admin/bank_transactions/:id/enrichment` with no mode.
- **Human question?** no
- **Proposed default:** treat a missing mode as unknown and redirect with alert `Unknown propagation mode: `.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-310 Archived merchants keep matching transactions
- **What is unclear:** Archiving a merchant does not disable its rules. The enricher loads all enabled rules regardless of `merchants.archived_at`, so archived merchants keep being assigned on sync and rebuild. Is "archive" meant only to hide the merchant from pickers and lists?
- **Evidence for / against:** `app/controllers/admin/merchants_controller.rb:83-86`; `app/services/enrichment/transaction_enricher.rb:135-138`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (business meaning)
- **Proposed default:** keep (parity). Document in the UI.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-311 Own-account merchant default category is `money.transfers`, not `money.transfers.own`
- **What is unclear:** `OwnAccountMerchantSyncer::OWN_TRANSFER_CATEGORY_SLUG = "money_transfers"` resolves to path `money.transfers` ("Przelewy", an intermediate node). Everything else that means "own transfer" uses `money.transfers.own` (fallback table, top-up merchant). Is the intermediate node intended?
- **Evidence for / against:** `app/services/enrichment/own_account_merchant_syncer.rb:13,55`; `app/services/enrichment/transaction_enricher.rb:25-26,47`; `app/services/seeders/merchant_rules.rb:109`.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (business meaning)
- **Proposed default:** keep `money.transfers` for parity (same kind `transfer`, so totals are unaffected).
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-312 Privacy statements about LLM payload are inaccurate
- **What is unclear:** Three statements do not match the code:
  - The AI Enrichment page says "Only the normalized `title` and `counterparty_name` are sent - no amounts, IBANs, or dates.", and `config/initializers/ruby_llm.rb` says "only normalized titles + counterparty names". The prompt actually sends the **raw** title (`title_raw`), the normalized title, the counterparty name and the user's category path list. Amounts, IBANs and dates are indeed not sent.
  - The page also says requests go "to OpenAI" and that "Each batch is a single OpenAI call" regardless of the configured provider (Gemini in the oracle).
- **Evidence for / against:** `app/views/admin/llm_enrichments/index.html.erb:42,89`; `app/views/admin/llm_enrichments/_run_progress.html.erb:45`; `app/services/llm/merchant_suggester.rb:194-205`; [runs](../oracle/operation_runs_after_capture.jsonl) ids 10-11 (raw titles in `request`); [UI](../oracle/ui/admin_llm_enrichments_index.html).
- **Who/what can resolve:** product owner / privacy owner.
- **Human question?** yes (scope/privacy wording)
- **Proposed default:** keep the payload (needed for pattern matching on the raw title) and correct the copy to name the configured provider and "raw + normalized title".
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-313 No timeout on user-defined regex rules (ReDoS)
- **What is unclear:** Regex rules are compiled with no `Regexp.timeout`, and `config/` sets none. A catastrophic pattern entered by a user, or proposed by the LLM, can stall enrichment, rebuilds and the LLM grouping. Java/Kotlin regex semantics also differ from Ruby Onigmo, e.g. possessive/atomic syntax and `\h`.
- **Evidence for / against:** `app/models/merchant_rule.rb:79,87-96`; `grep Regexp.timeout` → no hits.
- **Who/what can resolve:** architecture owner.
- **Human question?** yes (migration choice)
- **Proposed default:** in Kotlin, compile with a timeout or a safe engine (e.g. RE2/J). Validate on save. Document which Ruby-only constructs are rejected.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-314 ADR-described features absent at this commit (AI insight, recurrence facet)
- **What is unclear:**
  - ADR 0008 (facts-only AI insight card with numeric guard) has no implementation: no `AiInsight` code or view.
  - ADR 0010's Layer 2 (`recurring`, `recurrence_interval` on `TransactionEnrichment`) does not exist in the schema; `ledger_entries_v04.sql` comments say recurrence was moved out.
  - ADR 0012 mentions the "AI insight" consumer of LLM credentials.
- **Evidence for / against:** `docs/adr/0008-ai-insight-architecture.md`; `docs/adr/0010-three-layer-category-model.md:23-25`; `inventory/schema.rb`; `inventory/views_sql/ledger_entries_v04.sql:9-11`; `grep -r AiInsight` → none.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** out of scope for the rebuild (port behaviour, not ADR intent).
- **Resolution:** Resolved by D-014 — documentation-only feature, out of scope.

### U-315 Re-running the seeders overwrites user edits
- **What is unclear:** Both seeders run from first-run setup, `POST /admin/onboarding/seed_taxonomy` and the showcase.
  - `Seeders::Categories` re-assigns `name`, `kind`, `color`, `icon`, `essential`, `path` and `position` on every seeded slug. A user's renames, kind or essential edits and moves are reverted, and descendant paths are not rewritten when a moved seeded category is reset.
  - `Seeders::MerchantRules` re-enables seeded rules and resets `case_sensitive = false` and the merchants' default categories.
- **Evidence for / against:** `app/services/seeders/categories.rb:175-191`; `app/services/seeders/merchant_rules.rb:51-130`; `spec/services/seeders/categories_spec.rb:18` ("re-applies attribute changes").
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep for parity (it is the documented "escape hatch"). Warn in the UI.
- **Resolution:** Resolved by D-017 — keep overwrite-on-reseed behaviour.

### U-316 Title normalizer behaviour differs from its own documentation
- **What is unclear:** The class comments claim:
  - `RZESZOWJMP S.A. BIEDRONKA 7645PL` → `JMP S.A. BIEDRONKA`, but the actual output is `JMP S A BIEDRONKA`;
  - `RzeszoweLeclercPL` → `LECLERC`, but the actual output is `ELECLERC`.

  City prefixes are matched without a word boundary (`POZNANSKA 12` → `SKA`). `KRAKOW` is listed twice. Grouping keys and LLM hints depend on the exact output.
- **Evidence for / against:** `app/services/enrichment/title_normalizer.rb:4-7,14-19,40-50`; pure-Ruby evaluation of the file (table in BR-264); `spec/services/enrichment/title_normalizer_spec.rb:6-26`.
- **Who/what can resolve:** original author.
- **Human question?** no (parity default is clear)
- **Proposed default:** port the exact algorithm, with golden tests from BR-264's table.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-317 LLM group limit has no server-side bounds
- **What is unclear:** The form restricts `limit` to 1..200. `LlmEnrichments::Queuer` and the job accept any integer:
  - `0` or negative → `first(0)` → an empty, succeeded run;
  - a huge value → unbounded token spend.

  The API rejects only non-integers (400).
- **Evidence for / against:** `app/services/llm_enrichments/queuer.rb:8-12`; `app/views/admin/llm_enrichments/index.html.erb:93-95`; `app/jobs/llm_enrichment_job.rb:30`; [oracle](../oracle/http/POST_api__version_llm_enrichments.json) `invalid_limit` → 400.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** validate 1..200 server-side (422).
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-318 Connection test bypasses the client factory; key reuse across providers
- **What is unclear:**
  - **Factory bypass.** `Llm::ConnectionTestRunner` builds its client with `setting.build_client` directly instead of `Llm::Client.for`. In the oracle this bypassed the injected fake and made a real OpenAI request.
  - **Key reuse.** Saving preferences with a blank key keeps the old key even when the provider changes. The oracle switched gemini → openai and sent the Gemini key to OpenAI.
  - **Unrescued errors.** Only `Llm::Client::Error` is rescued. Any other exception leaves the `llm_connection_test` run in `running` and returns a 500.
- **Evidence for / against:** `app/services/llm/connection_test_runner.rb:27-49`; `app/controllers/admin/settings/preferences_controller.rb:60`; [runs](../oracle/operation_runs_after_capture.jsonl) id 14 (`Incorrect API key provided: fake-gem***-key`); investigator finding in the brief.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (bug-to-keep-or-fix: should a provider change require a new key?)
- **Proposed default:** in Kotlin, route through the factory. Require a new key when the provider changes. Fail the run on any exception.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-319 LLM prompt references category targets that do not exist
- **What is unclear:** The Polish system prompt tells the model to pick `"uncategorized"` when unsure and gives `gifts_donations` as the default for charities. Neither is a seeded path (the seeded one is `lifestyle.giving.donations`). Unknown paths silently become `noise.unmatched.other`.
- **Evidence for / against:** `app/services/llm/merchant_suggester.rb:117,137`; `app/services/llm/enrichment_runner.rb:188-194`; `app/services/seeders/categories.rb:100-102`.
- **Who/what can resolve:** original author (prompt owner).
- **Human question?** yes (keep the prompt verbatim or fix it)
- **Proposed default:** keep the prompt byte-identical for parity of model behaviour. Note it as a follow-up.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-320 `hidden_category_ids` accepts category ids of other tenants
- **What is unclear:** `PATCH /admin/settings/preferences/app` assigns `user.hidden_category_ids = [...]`. Rails' collection `ids_writer` looks ids up with `Category.where(id: ids)`, not with the user's categories. A foreign id therefore creates a `user_hidden_categories` row pointing at another tenant's category, which has no visible effect because `hidden_subtree_ids` filters by the user's own categories. A non-existent id raises `RecordNotFound` → 404.
- **Evidence for / against:** `app/controllers/admin/settings/preferences_controller.rb:107-114`; `bundle/ruby/3.4.0/gems/activerecord-8.1.3/lib/active_record/associations/collection_association.rb:62-81`; `app/models/user.rb:56-65`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** in Kotlin, accept only ids of the user's own categories and ignore or 422 the others.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-321 Re-proposed LLM rule can be re-disabled after user approval
- **What is unclear:** `upsert_rule` sets `enabled = confident?` on every upsert of the same (field, kind, pattern). A rule enabled by `Merchants::Approver` would be disabled again if a later run proposes the same pattern with a confidence below 0.85. This is rare, because groups matched by existing rules are not re-sent, but possible via a different group yielding the same pattern.
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:165-177`; `app/services/merchants/approver.rb:17-19`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** never disable a rule that has `approved_at` or was enabled by a user.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-322 "All batches failed" message for item-level failures
- **What is unclear:** `LlmEnrichmentJob` marks a run `failed` with `All batches failed. First: <error>` whenever there are errors and no auto or pending outcomes. This also happens when the only errors are item-level validation errors and every other item was skipped, so the batches themselves succeeded.
- **Evidence for / against:** `app/jobs/llm_enrichment_job.rb:41-47`; `spec/system/llm_enrichment_spec.rb:67`, `:91` (cover only the clear cases).
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** keep the status rule and the exact message for parity.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-323 Own-account merchant identity: 8-char uid prefix and shared IBANs
- **What is unclear:**
  - The merchant slug uses only the first 8 characters of the bank account uid, so two accounts whose uids share a prefix would share one merchant.
  - Multi-currency pockets sharing one IBAN (Revolut EUR/USD in the showcase) create two merchants with identical iban rules at priority 200. The match goes to the lower rule id, which is effectively arbitrary.
  - The known unscoped `find_existing_account` takeover bug can also move the merchant's account to another tenant.
- **Evidence for / against:** `app/services/enrichment/own_account_merchant_syncer.rb:70-72,82-100`; `app/services/seeders/showcase.rb:195-196`; investigator finding in the brief (`CreateConnection#find_existing_account`).
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** key the own-account merchant on the full account id in Kotlin, while keeping the slug format for display and parity.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-400 BUG? ATM top-up category lookup never matches the seeded taxonomy
- **What is unclear:** `Cash::AtmWithdrawalLinker` sets the top-up's enrichment category to `user.categories.find_by(slug: "cash_atm_topup")`, with the comment "we want it consistent immediately". The seeded taxonomy derives slugs from paths (`path.tr(".", "_")`), and the ATM category is `money.transfers.atm` → slug `money_transfers_atm`. No category has slug `cash_atm_topup`, so new top-ups get `category = NULL` (unmatched) until an enrichment **rebuild** runs (source `system_fallback` is rebuildable; fallback `[credit, cash_atm_topup] → money.transfers.atm`). Between link and rebuild the top-up credit is unmatched (not spend/income either way, but it is shown "unclassified").
- **Evidence for / against:** `app/services/cash/atm_withdrawal_linker.rb:44-50`; `app/services/seeders/categories.rb:146,175-180`; `app/services/enrichment/transaction_enricher.rb:39,81-99`. The spec `spec/services/cash/atm_withdrawal_linker_spec.rb:30` compares with the same failing lookup (NULL == NULL), so it passes vacuously. Oracle top-ups show category 101 `money.transfers.atm` only because `Seeders::Showcase` calls `TransactionEnricher.rebuild!` (`app/services/seeders/showcase.rb:281`) — [../oracle/http/GET_api__version_cash_transactions.json](../oracle/http/GET_api__version_cash_transactions.json).
- **Who/what can resolve:** original author / product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** fix in Kotlin: assign the category with path `money.transfers.atm` at link time.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-401 BUG? ATM top-ups keep counterparty_kind "unknown" instead of "self"
- **What is unclear:** `Banking::CounterpartyResolver` classifies `cash_atm_topup` as `self`, but the linker never calls it, so linked top-ups keep the DB default `unknown`. Filters such as `LedgerEntry.to_self` miss them.
- **Evidence for / against:** `app/services/banking/counterparty_resolver.rb:10-24`; `app/services/cash/atm_withdrawal_linker.rb:29-43`; oracle [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) case `manual` → `"payment_method": "cash_atm_topup", "counterparty_kind": "unknown"`. The rake task `banking.rake` backfill would correct it (`lib/tasks/banking.rake:4-20`) [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** set `self` at link time.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-402 BUG? Analytics `from > to` returns 500 (API and admin)
- **What is unclear:** `Analytics::Period` raises `ArgumentError "from must be <= to"`; nothing maps it to 400. Admin HTML has the same path, and additionally an unparseable admin date silently becomes "today", which can produce `from > to` (e.g. `from=garbage&to=2026-01-01`).
- **Evidence for / against:** `app/services/analytics/period.rb:19`; `app/services/analytics/filter.rb:176-206`; oracle [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) case `from_after_to` → 500 `{"message": "ArgumentError: from must be <= to"}` (confirms the investigator's finding). Admin variant not captured [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** API → 400 `{"message":"Invalid parameters.","details":["from must be <= to"]}`; admin → swap or fall back to month-to-date.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-403 BUG? `PATCH /api/v1/cash_transactions/:id` clears omitted fields
- **What is unclear:** The API passes only supplied params (`declared(..., include_missing: false)`) to `TransactionUpdater`, whose contract is "blank title/note/counterparty_name/transaction_date/merchant/category means clear". A PATCH with only `{"amount":"30"}` therefore wipes title, note, counterparty, transaction_date, merchant and category (and sets `category_overridden=false`).
- **Evidence for / against:** `lib/api/resources/cash_transactions.rb:92-97`; `app/services/cash/transaction_updater.rb:9-12,58-83`. Oracle PATCH samples only touched rows whose other fields were already NULL, so not observed [I].
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** in the API treat absent keys as "keep", explicit `null`/`""` as "clear"; keep admin form behaviour.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-404 BUG? Cash wallet is created even when the cash entry fails
- **What is unclear:** `TransactionCreator` resolves (find-or-create) the wallet before the DB transaction that saves the row; a failed entry (bad amount, or an unknown currency such as `XYZ` that fails the ISO inclusion validation) leaves a new wallet behind (e.g. "Cash wallet (XYZ)"), which then appears in wallet lists, currency options and `all_bank_account_ids`.
- **Evidence for / against:** `app/services/cash/transaction_creator.rb:60-64`; `app/services/cash/wallet_resolver.rb:21-30` (no currency validation on BankAccount, `app/models/bank_account.rb:66-69`). Not exercised in the oracle [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** validate currency first and create the wallet inside the same transaction.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-405 "Today" is the UTC date, not the user's local date
- **What is unclear:** No `config.time_zone` → UTC. Month-to-date, presets, default booking date of cash entries and the run-rate all use the UTC date; for Polish users the date flips 1–2 hours late. The seeder deliberately uses `Europe/Warsaw`, and auto-sync schedules carry their own zone, suggesting local time matters.
- **Evidence for / against:** `config/application.rb:32-46`; `app/services/seeders/showcase.rb:52`; `app/services/auto_sync/next_run_calculator.rb:23`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep UTC for parity; make the zone a single configuration point in Kotlin.
- **Resolution:** Resolved by D-007 — instance-wide APP_TIME_ZONE (default Europe/Warsaw).

### U-406 Refunds are neither netted against spend nor counted as income when classified as expense
- **What is unclear:** `spend` requires debit + expense kind; `income` requires credit + income kind. A credit whose effective category is an expense category (e.g. merchant default "Supermarkets") disappears from all analytics. Card refunds are routed to `income.refunds.refunds` only by the unmatched fallback; a refund from a known merchant inherits the merchant's expense category.
- **Evidence for / against:** `app/models/ledger_entry.rb:72-76`; `spec/models/ledger_entry_spec.rb:132` (explicitly excludes refunds); `app/services/enrichment/transaction_enricher.rb:36`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (business meaning)
- **Proposed default:** keep (spec-asserted behaviour).
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-407 Uncategorised manual cash expenses never count as spend
- **What is unclear:** Manual rows always get a `manual` enrichment, which the auto-enricher never overwrites; without a picked category (or a merchant with a default category) the row stays unmatched and is excluded from spend — the showcase's six cash expenses are "unclassified" and invisible in the dashboard totals. Fallback `[debit, cash] → noise.unmatched.cash` exists but is never applied to manual rows.
- **Evidence for / against:** `app/services/cash/transaction_creator.rb:91-98`; `app/services/enrichment/transaction_enricher.rb:28,98`; [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) ("Parking meter unclassified Manual").
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep for parity; consider requiring a category in the cash form.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-408 AI insight card (ADR 0008) is documented but not implemented
- **What is unclear:** ADR 0008 specifies `Analytics::AiInsight` (facts-only narration, numeric guard, notable movers `|delta_pct| ≥ 100 % AND ≥ 200 PLN`). No code, view or route exists; ADR 0012 still lists "AI insight" as an LLM consumer.
- **Evidence for / against:** `docs/adr/0008-ai-insight-architecture.md`; `docs/adr/0012-per-user-llm-credentials.md:4`; `grep -ri insight app lib` → none; `spec/system/daily_login_analytics_spec.rb:64`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** out of scope for the Kotlin parity rebuild.
- **Resolution:** Resolved by D-014 — documentation-only feature, out of scope.

### U-409 Top movers ignore categories whose spend dropped to zero; thresholds are currency-agnostic
- **What is unclear:** Movers are computed from the current-period breakdown only, so a category that went from 500 to 0 never appears as a "down" mover. Thresholds are a fixed 5000 minor units (50.00) regardless of currency (EUR 50 vs PLN 50).
- **Evidence for / against:** `app/services/analytics/top_movers.rb:16-33`; `app/services/analytics/spend_breakdown.rb:22-32`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep for parity.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-410 ATM linking ignores the bank transaction status
- **What is unclear:** A pending BLIK ATM debit is linked immediately and the top-up is created as `booked`. If the pending bank row is later dropped/cancelled by the bank, the top-up stays (no unlink logic exists). Analytics exclude the pending bank row but include the booked top-up only if categorised (transfer → no effect on spend), but the wallet balance is inflated.
- **Evidence for / against:** `app/services/cash/atm_withdrawal_linker.rb:60-63` (no status check), `:34`; no unlink code found.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep for parity; document.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-411 Hidden-category privacy is UI-only
- **What is unclear:** The admin UI redirects/masks hidden categories, but `/api/v1/analytics/categories/:slug`, `/merchants/:slug`, `/spend`, `/top_merchants` and `/api/v1/transactions` return hidden data unmasked. Is the hidden list a presentation preference or a privacy boundary?
- **Evidence for / against:** `app/controllers/admin/analytics/categories_controller.rb:10-14` vs `lib/api/resources/analytics/categories.rb:18-56`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep UI-only (PAT holder is the same user).
- **Resolution:** Resolved by D-015 — hidden categories remain UI-only.

### U-412 Misleading "awaiting classification" empty state
- **What is unclear:** When the leaf category chart is empty, the dashboard shows "<N> transactions awaiting classification" counting **all** booked debits in scope, including classified transfers (e.g. ATM withdrawals). In the oracle MTD view the only debit was a classified ATM transfer, yet the page said "1 transactions awaiting classification" (also wrong plural).
- **Evidence for / against:** `app/views/admin/analytics/dashboard/index.html.erb:380-393`; [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** count only unmatched debits (as the banner does) and pluralize.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-413 `/api/v1/analytics/spend` total differs from cash-flow spend when `depth` is used
- **What is unclear:** With `depth = d`, rows on categories shallower than `d` are dropped, and `total_cents` is the sum of returned rows, so it under-reports spend. Observed: depth=2 total 229241 vs cash-flow spend 231240 for the same range.
- **Evidence for / against:** `app/services/analytics/spend_breakdown.rb:86-93`; `lib/api/resources/analytics/spend.rb:32`; [../oracle/http/GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json) vs [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `explicit_range`.
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (intent)
- **Proposed default:** keep for parity; document that `total_cents` is the sum of rows. `depth=0` or negative values are unvalidated (behaviour unknown).
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-414 Admin bank-transaction `category_id` filter matches explicit overrides only
- **What is unclear:** `?category_id=` filters `transaction_enrichments.category_id`, i.e. only rows with an explicit category override, not rows categorised via the merchant default. The API ledger filter uses `effective_category_id` instead.
- **Evidence for / against:** `app/controllers/admin/bank_transactions_controller.rb:13` vs `lib/api/resources/transactions.rb:34`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep for parity.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-415 Minor-unit assumptions: charts divide by 100; amount input rejects thousands separators
- **What is unclear:** Chart values use `cents / 100.0` for every currency (wrong for 0- or 3-decimal currencies such as JPY/KWD, which money parsing would store correctly). Amount input replaces every `,` with `.`, so `1,234.56` and `1 234,56` are rejected as invalid.
- **Evidence for / against:** `app/views/admin/analytics/dashboard/index.html.erb:47,99-101`; `app/services/cash/transaction_creator.rb:27-29`.
- **Who/what can resolve:** product owner.
- **Human question?** no (parity default is clear)
- **Proposed default:** keep for parity; the Kotlin implementation should derive the divisor from the currency exponent if multi-decimal currencies are ever supported.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-416 Unvalidated inputs that likely produce 500
- **What is unclear:** Admin cash index `from`/`to` are interpolated as SQL parameters against a DATE column without parsing (an invalid string likely raises a Postgres error → 500); `/api/v1/analytics/top_merchants?limit=-1` passes a negative LIMIT; `/api/v1/transactions?category_path=` with an invalid ltree likely errors.
- **Evidence for / against:** `app/controllers/admin/cash_transactions_controller.rb:14-15`; `lib/api/resources/analytics/top_merchants.rb:16,20-22`; `lib/api/resources/transactions.rb:35`. None exercised by oracle/specs [I].
- **Who/what can resolve:** running these requests against the oracle server.
- **Human question?** no
- **Proposed default:** Kotlin validates and returns 400 / ignores bad filters; record as an intentional deviation.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-417 Enabling cash tracking always creates a PLN wallet
- **What is unclear:** `Cash::Tracking.enable!` is called without a currency, so a user whose accounts are all EUR still gets an empty PLN wallet; linked EUR ATM withdrawals create an EUR wallet on demand. The flash always says "Created a PLN wallet…" even if it already existed.
- **Evidence for / against:** `app/controllers/admin/settings/preferences_controller.rb:38-41`; `app/services/cash/tracking.rb:9-19`; `docs/adr/0006-cash-tracking-opt-in.md` ("auto-creates a PLN wallet").
- **Who/what can resolve:** product owner.
- **Human question?** no (ADR states PLN explicitly)
- **Proposed default:** keep for parity.
- **Resolution:** Resolved by D-009 — keep current analytics/cash semantics (parity).

### U-500 BUG? Audit log (`/admin/versions`, `/admin/versions/:id`) is not tenant-scoped
- **What is unclear:** Whether the audit log is meant to be global. Every signed-in user can list and open every PaperTrail version of every tenant, including the attribute changes of `BankAccount` (IBAN, BBAN, name, details), `BankConnection` (bank name, status, validity), `ManualTransaction` (amounts, titles, notes) and `TppCredential` (name, redirect URL, certificate; private key and application id are excluded).
- **Evidence for / against:** `app/controllers/admin/versions_controller.rb:6,10` query `PaperTrail::Version` without any user filter; `has_paper_trail` in `app/models/bank_account.rb:71`, `bank_connection.rb:61`, `manual_transaction.rb:74`, `tpp_credential.rb:57`. Observed: [oracle](../oracle/http/GET_admin_versions.json) case `other_tenant_sees_all_versions -> 200`, [oracle](../oracle/http/GET_admin_versions__id.json) case `other_tenant_reads_main_version -> 200` **[V]**. Against: ADR 0011 says deployments are "single-user-shaped", so the author may have considered it harmless; but the same ADR keeps the schema multi-tenant and every other admin route is scoped (`AGENTS.md:252`).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** fix in Kotlin: only show versions whose item belongs to the current user (resolve ownership per `item_type`), or whose `whodunnit` is the current user; 404 for others.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-501 BUG? Sidekiq dashboard `/sidekiq` is available to every signed-in user
- **What is unclear:** Whether job administration should be restricted to an operator. Any authenticated tenant sees all jobs (arguments include run ids, user ids) and can retry/delete/kill jobs and cron entries of all tenants.
- **Evidence for / against:** `config/routes.rb:12-14` (`authenticate :user` only); **[V]** [oracle](../oracle/http/GET_sidekiq.json) case `authenticated -> 200`. ADR 0011 (single user per deployment in practice) makes it low impact today.
- **Who/what can resolve:** product owner / operator.
- **Human question?** yes (scope, migration choice).
- **Proposed default:** the Kotlin service does not expose a job dashboard to tenants; if an operator UI is needed, protect it with a separate operator credential.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-502 BUG? `POST /admin/bank_connections` with an invalid form answers 204 with an empty body
- **What is unclear:** The intended behaviour is evidently "re-render the new-connection form with the validation errors" (`flash.now[:alert]` is set and `new` is called), but no template is rendered, so the browser receives `204 No Content` and nothing visible happens.
- **Evidence for / against:** `app/controllers/admin/bank_connections_controller.rb:47-50`; **[V]** [oracle](../oracle/http/POST_admin_bank_connections.json) case `invalid_blank_aspsp -> 204`; `oracle/server.log.txt:15001` "No template found for Admin::BankConnectionsController#create, rendering head :no_content". No spec covers the invalid-form branch. The HTML form normally prevents an empty bank (required select), which is why it went unnoticed **[I]**.
- **Who/what can resolve:** original author / product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** Kotlin re-renders the "Add bank connection" form with 422 and the alert "<joined errors>" (e.g. "Aspsp name can't be blank").
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-503 BUG? Unknown LLM provider on `PATCH /admin/settings/preferences/llm` -> 500
- **What is unclear:** A provider value outside the registry (only possible by tampering) raises `ArgumentError` "Unknown LLM provider: \"martian\"" while re-rendering the form instead of producing a validation error.
- **Evidence for / against:** **[V]** [oracle](../oracle/http/PATCH_admin_settings_preferences_llm.json) case `invalid_provider -> 500` (h1 "ArgumentError in Admin::Settings::Preferences#update_llm"); `app/services/llm/providers.rb:38`; `app/views/admin/settings/preferences/llm.html.erb:37`; `app/models/llm_setting.rb:41,73`. The model has an inclusion validation on provider, so the intent is clearly a 422.
- **Who/what can resolve:** reading/running; no product decision needed.
- **Human question?** no.
- **Proposed default:** Kotlin returns 422 with alert "Provider is not included in the list".
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-504 `POST /admin/settings/preferences/llm/test` bypasses the `Llm::Client.for` seam
- **What is unclear:** Whether `ConnectionTestRunner` should obtain its client through `Llm::Client.for` like the rest of the LLM code. It calls `setting.build_client` directly, so the in-memory fake installed for the capture was bypassed and a real OpenAI call was made with the fake key.
- **Evidence for / against:** `app/services/llm/connection_test_runner.rb:129`; `app/services/llm/client.rb:24-31` (`for` only adds the not-configured check, then calls `build_client`); **[V]** run 14 `llm_connection_test` failed with "OpenAI API error: RubyLLM::UnauthorizedError: Incorrect API key provided ..." in `oracle/operation_runs_after_capture.jsonl`. In production both paths build the same client, so the user-visible behaviour is identical; the impact is on testability.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** in Kotlin route all provider calls through one injectable client factory.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-505 BUG? `Admin::MerchantsController#edit` is defined twice; the hidden-category guard is dead code
- **What is unclear:** Whether `GET /admin/merchants/:id/edit` should refuse merchants in hidden categories (as `show` does).
- **Evidence for / against:** first definition with guard at `app/controllers/admin/merchants_controller.rb:37-42` (alert "This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it."), second empty definition at `:58-59` which replaces it at class-load time **[I]**. No spec covers edit of a hidden merchant. The analogous category and cash edit actions do enforce the guard.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** enforce the guard (302 to `/admin/merchants` with the alert above), consistent with `show`.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-506 BUG? OAuth callback can attach another tenant's bank account (unscoped `find_existing_account`)
- **What is unclear:** `GET /callback` -> `EnableBanking::Operations::CreateConnection#find_existing_account` looks up `BankAccount.find_by(uid:)` across all tenants and then reassigns `tpp_credential` / `current_bank_connection` to the caller's, moving the account (and, through `BankTransaction.for_user`, its whole transaction history) to the second tenant.
- **Evidence for / against:** `app/services/enable_banking/operations/create_connection.rb:55-63,85-93`; observed by the investigator while seeding two tenants (brief). Fallback lookup by IBAN is correctly scoped to the credential (`:92`).
- **Who/what can resolve:** product owner (is a shared bank account between two household users a supported case?).
- **Human question?** yes.
- **Proposed default:** scope the uid lookup to the current user's credentials; a uid owned by another tenant creates a separate account row.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-507 Password-reset request reveals whether an email is registered
- **What is unclear:** `POST /admin/password` answers 422 "Email not found" for unknown emails and 303 for known ones (Devise `paranoid` mode off), enabling account enumeration.
- **Evidence for / against:** `config/initializers/devise.rb:93` (`# config.paranoid = true`); **[V]** [oracle](../oracle/http/POST_admin_password.json) cases `unknown_email -> 422`, `known_email -> 303`; `spec/requests/public_spec.rb:224` describes the notice as "neutral", suggesting the author wanted non-enumeration.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** Kotlin always answers 303 to `/admin/sign_in` with the neutral notice "You will receive an email with instructions on how to reset your password in a few minutes." (Devise paranoid wording "If your email address exists in our database, you will receive a password recovery link at your email address in a few minutes." is an alternative).
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-508 Password-reset e-mail delivery is not really configured
- **What is unclear:** Whether e-mail password reset is a supported feature. The Devise mailer sender is the placeholder "please-change-me-at-config-initializers-devise@example.com" and ADR 0011 says "Forgot-password without SMTP is a documented `bin/rails runner` one-liner".
- **Evidence for / against:** `config/initializers/devise.rb:27`; `docs/adr/0011-first-run-setup.md` (Consequences); `inventory/mailers.json`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** keep the routes, make sender and SMTP configurable via environment; if SMTP is not configured, still answer as today (no error to the user) and log.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-509 Framework default routes (ActionMailbox ingresses, Rails Conductor, ActiveStorage) — drop in Kotlin?
- **What is unclear:** Whether anything depends on the 23 framework routes. Their tables do not exist, so they can never work: ingresses 404, Conductor index/show 500 in development (403 elsewhere), ActiveStorage 404/422.
- **Evidence for / against:** `config/application.rb:8,11,12` load the engines; no mailboxes, attachments or rich text in `app/`; `inventory/models.json` `table_exists: false` for `action_mailbox_inbound_emails`, `active_storage_*`, `action_text_rich_texts`; **[V]** oracle cases listed in A.23 (all 404/422/500 except two Conductor form pages 200).
- **Who/what can resolve:** original author (were these left from `rails new`?).
- **Human question?** no (technical scope; confirm only).
- **Proposed default:** do not implement; unknown paths answer 404 in Kotlin. Optionally remove the engines from the Rails app.
- **Resolution:** Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).

### U-510 Turbo Native historical-location routes — needed?
- **What is unclear:** Whether a Hotwire Native mobile client exists or is planned; only then are `/recede_historical_location`, `/resume_historical_location`, `/refresh_historical_location` meaningful.
- **Evidence for / against:** drawn by turbo-rails 2.0.23 automatically; the app never redirects to them (no `*_or_redirect_to` helpers in `app/`); **[V]** oracle 200 with bodies "Going back…", "Staying put…", "Refreshing…".
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** omit unless the Kotlin service keeps a Turbo/Hotwire front end with native wrappers.
- **Resolution:** Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).

### U-511 Manual override of bank connection `status` / `valid_until` (`PATCH|PUT /admin/bank_connections/:id`)
- **What is unclear:** Intended use of the edit form. It lets the user set any of `pending, authorized, expired, revoked, replaced, error, closed` and any `valid_until`, bypassing the provider (e.g. marking an expired consent as authorized). Statuses are lower-case only; the oracle's upper-case `AUTHORIZED` was rejected with 422.
- **Evidence for / against:** `app/controllers/admin/bank_connections_controller.rb:18-24,99-101`; `inventory/models.json` BankConnection inclusion list; **[V]** [oracle](../oracle/http/PATCH_admin_bank_connections__id.json) case `default -> 422`, [oracle](../oracle/http/PUT_admin_bank_connections__id.json) case `invalid_status -> 422`. No spec covers update.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (intent).
- **Proposed default:** keep as an "advanced" override with the same allowed values; consider restricting to `valid_until` and `closed`.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-512 BUG? `POST /admin/transaction_syncs` silently widens an invalid connection to a user-wide sync and accepts reversed dates
- **What is unclear:** A blank, unknown, foreign or inactive `bank_connection_id` does not fail: the run's subject becomes the user (syncs all of the user's connections). `date_from > date_to` is stored unvalidated.
- **Evidence for / against:** `app/services/transaction_syncs/queuer.rb:25,60-63`; **[V]** [oracle](../oracle/http/POST_admin_transaction_syncs.json) case `missing_connection -> 302` -> run 13 subject `User`; run 8 in `oracle/operation_runs_after_capture.jsonl` has `date_from 2026-10-21`, `date_to 2026-07-13` and still `succeeded`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix).
- **Proposed default:** blank id = sync all (keep, it is a UI option **[I]**); unknown/foreign id -> alert "Could not start sync: Bank connection not found"; `date_from > date_to` -> alert "Could not start sync: date_from must be <= date_to".
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-513 Classification form without `mode` -> 500
- **What is unclear:** `PATCH /admin/bank_transactions/:id/enrichment` without `enrichment[mode]` calls `nil.to_sym` -> `NoMethodError` -> 500; with an empty string it yields "Unknown propagation mode: ".
- **Evidence for / against:** `app/services/enrichment/classification_applier.rb:15,36`; not covered by oracle or specs **[I]**.
- **Who/what can resolve:** reading/running.
- **Human question?** no.
- **Proposed default:** Kotlin treats a missing mode as invalid: 302 back with alert "Unknown propagation mode: ".
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-514 Data import with a non-file `bundle` parameter -> 500
- **What is unclear:** `params[:bundle].read` assumes an uploaded file; a plain string field raises `NoMethodError` -> 500.
- **Evidence for / against:** `app/controllers/admin/settings/data_exchange_controller.rb:38` **[I]**.
- **Who/what can resolve:** reading/running.
- **Human question?** no.
- **Proposed default:** treat a non-file value like a missing file (alert "Bundle file is required.").
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-515 Analytics HTML pages with `from > to`
- **What is unclear:** `Analytics::Period` raises `ArgumentError` "from must be <= to"; the API variant is a known 500 (Part B). The HTML dashboard / category / merchant pages build the same filter and should also 500.
- **Evidence for / against:** `app/services/analytics/period.rb:19`; `app/services/analytics/filter.rb:38-40,176-190` **[I]**; not exercised by the oracle for HTML.
- **Who/what can resolve:** running the request.
- **Human question?** no.
- **Proposed default:** Kotlin swaps or rejects reversed ranges; for HTML show the page with an alert and the default month-to-date range.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-516 HTML error pages in Kotlin
- **What is unclear:** Whether the Kotlin service must reproduce the five static Rails error pages (400/404/406/422/500) byte-for-byte.
- **Evidence for / against:** `public/400.html`, `404.html`, `406-unsupported-browser.html`, `422.html`, `500.html`; production `consider_all_requests_local = false` (`config/environments/production.rb:13`).
- **Who/what can resolve:** product owner / UI owner.
- **Human question?** no (migration choice with obvious default).
- **Proposed default:** serve equivalent static pages with the same titles and texts (A.3); never expose stack traces outside development.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-517 CORS `origins "*"` also covers the HTML admin
- **What is unclear:** Whether the wildcard CORS policy was meant for the JSON API only.
- **Evidence for / against:** `config/initializers/cors.rb` (all resources, all methods, no credentials). Without `credentials: true` browsers do not send cookies on cross-origin XHR, so session-authenticated HTML is not readable cross-origin **[I]**.
- **Who/what can resolve:** original author.
- **Human question?** no.
- **Proposed default:** in Kotlin apply CORS only to `/api/**` (and `/mcp` if needed).
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-518 Post-sign-in redirect may target a non-page URL
- **What is unclear:** Devise stores the last GET URL that required authentication; in the capture, sign-in redirected to `/api/v9/docs` (an earlier anonymous request), i.e. to a URL that does not even exist as a page.
- **Evidence for / against:** **[V]** [oracle](../oracle/http/POST_admin_sign_in.json) case `valid_credentials -> 303` Location `/api/v9/docs`; `app/controllers/swagger_controller.rb` (Part B).
- **Who/what can resolve:** product owner (low impact).
- **Human question?** no.
- **Proposed default:** store only GET HTML navigations under `/admin/**`, `/callback`, `/sidekiq` and the API docs page; otherwise redirect to `/admin/analytics`.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-519 OAuth `state` is readable and replayable within its TTL
- **What is unclear:** Whether the bank-auth state needs confidentiality / single use. It is HMAC-signed (not encrypted) and its nonce is not stored, so it can be reused for 30 minutes by the same user.
- **Evidence for / against:** `app/services/enable_banking/state.rb:9,12-35`; **[V]** decoded payload visible in [oracle](../oracle/http/POST_admin_bank_connections.json) case `default` Location. The user-id check (`app/controllers/oauth_callbacks_controller.rb:12`) prevents cross-user use.
- **Who/what can resolve:** security reviewer.
- **Human question?** no.
- **Proposed default:** keep signed state with 30-minute TTL and user check; optionally store the nonce and reject reuse.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-520 Session lifetime parity (no timeout, 2-week remember-me)
- **What is unclear:** Whether the Kotlin service should keep "no idle timeout" sessions and a 2-week remember-me cookie.
- **Evidence for / against:** `app/models/user.rb:23` (no `:timeoutable`, no `:lockable`); `config/initializers/devise.rb:170,173,194` (defaults commented out) **[I]**.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope).
- **Proposed default:** same semantics: session cookie until browser close, remember-me 2 weeks, all remember tokens invalidated on sign-out and password change.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-521 Hidden-category guard applies to show/edit but not to update/destroy
- **What is unclear:** For cash transactions and categories the "hidden category" guard protects only the GET pages; PATCH/PUT/DELETE on a hidden record still succeed if the id is known.
- **Evidence for / against:** `app/controllers/admin/cash_transactions_controller.rb:58-67` vs `:69-87`; `app/controllers/admin/categories_controller.rb:33-38` vs `:40-72` **[I]**.
- **Who/what can resolve:** product owner (the feature is a privacy screen, not access control).
- **Human question?** yes (intent).
- **Proposed default:** keep parity (guard on GET pages only), document as privacy screen.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-522 `/up` health check does not check dependencies
- **What is unclear:** Whether deployment health checks rely on `/up` being a pure liveness probe.
- **Evidence for / against:** `config/routes.rb:21` (`rails/health#show` only verifies the app booted) **[I]**; **[V]** [oracle](../oracle/http/GET_up.json) 200 green page; `docs/adr/0014-self-hosted-deployment.md`.
- **Who/what can resolve:** operator.
- **Human question?** no.
- **Proposed default:** Kotlin `/up` = liveness (200 when the process serves requests), optional separate readiness endpoint checking PostgreSQL and Redis.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-523 Browser gate (`allow_browser versions: :modern`)
- **What is unclear:** Whether the Kotlin service must reject "legacy" browsers with 406, and with which thresholds (Rails `:modern` = browsers supporting webp, web push, badges, import maps, CSS nesting and `:has`).
- **Evidence for / against:** `app/controllers/application_controller.rb:2`; **[V]** [oracle](../oracle/http/GET_admin_analytics.json) case `legacy_browser_ua -> 406` (UA string not recorded in the oracle file).
- **Who/what can resolve:** product owner / UI owner.
- **Human question?** yes (scope).
- **Proposed default:** keep the gate for HTML routes with equivalent minimum versions (Chrome 120, Safari 17.2, Firefox 121, Opera 106, IE none; Rails 8 preset **[I]**), serving the same 406 page; requests without User-Agent pass.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-524 BUG? Foreign category ids accepted in merchant and hidden-category forms
- **What is unclear:** `merchant[default_category_id]` (`PATCH|PUT /admin/merchants/:id`, `POST /admin/merchants`) and `user[hidden_category_ids][]` (`PATCH /admin/settings/preferences/app`) are not checked to belong to the current user, so a tampered request can link a merchant to another tenant's category (whose name then shows up as the effective category) or create a hidden-category link to a foreign category.
- **Evidence for / against:** `app/controllers/admin/merchants_controller.rb:105-107`; `app/models/merchant.rb:49` (`belongs_to :default_category` without user check); `app/controllers/admin/settings/preferences_controller.rb:108-114`; `app/models/user_hidden_category.rb:28-31` **[I]** (not exercised). `User#hides_category?` re-scopes to the user's categories, limiting the second case.
- **Who/what can resolve:** reading/running.
- **Human question?** no.
- **Proposed default:** Kotlin validates that every referenced category id belongs to the user ("Default category must exist" -> 422 / ignore foreign hidden ids).
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-525 Regex dialect of user merchant rules
- **What is unclear:** Rules of kind `regex` are validated and executed with Ruby (Onigmo) regular expressions; the Kotlin (Java) engine differs in syntax details (e.g. `\h`, `\A`/`\z` supported in both, but possessive/atomic groups, named groups `(?<name>)`, `\p{...}` classes and case-insensitive Unicode behave differently), so existing patterns may change meaning or become invalid.
- **Evidence for / against:** `app/models/merchant_rule.rb:62,88-95`; error message "Pattern is not a valid regex: <RegexpError message>" exposes engine-specific text.
- **Who/what can resolve:** running all stored patterns through the Kotlin engine during migration.
- **Human question?** no.
- **Proposed default:** validate stored patterns at migration time and report incompatible ones; error message "Pattern is not a valid regex: <engine message>".
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-600 BUG? MCP `transactions.list` returns 1 row when `limit` is omitted (documented default 25)
- **What is unclear:** The tool computes `limit = min(max(args[:limit].to_i, 1), 200)` and then `limit = 25 if limit.zero?`; after the clamp the value can never be zero, so an omitted/0 limit yields 1 row.
- **Evidence for / against:** `lib/mcp/tools/transactions/list.rb:29-30`; description "default 25, max 200" (`:8`); [oracle](../oracle/http/POST_mcp.json) case `tools_call:transactions.list` (no args) → `"count":1`; `oracle/server.log.txt` shows `LIMIT 1` for the MCP call. `spec/requests/mcp/tools_spec.rb:25-41` passes because it only asserts count == size.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Fix in Kotlin: default 25 when absent or < 1, clamp to 1..200.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-601 BUG? MCP `merchants.list` returns 1 row when `limit` is omitted (documented default 50, description says max 100)
- **What is unclear:** Same clamp-before-zero-check defect as U-600; also the description says "max 100 rows" while the code clamps to 200.
- **Evidence for / against:** `lib/mcp/tools/merchants/list.rb:8,22-23`; [oracle](../oracle/http/POST_mcp.json) case `tools_call:merchants.list` → `"count":1`.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Default 50, clamp 1..200, fix the description text to "max 200".
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-602 BUG? `POST /mcp` with malformed JSON returns 500 (HTML) instead of a JSON 400
- **What is unclear:** The MCP SDK would answer `400 {"error":"Invalid JSON"}`, but the request fails in `McpController#handle` with `NoMethodError (undefined method 'each' for nil)` at the header-copy line, producing a 500 exception page (production: generic 500).
- **Evidence for / against:** [oracle](../oracle/http/POST_mcp.json) case `malformed_json` → 500 (`h1` "NoMethodError in McpController#handle"); `oracle/server.log.txt:1151`; `app/controllers/mcp_controller.rb:11-12`; SDK `parse_request_body` in `mcp-0.15.0/lib/mcp/server/transports/streamable_http_transport.rb:492-495`. Root cause (why headers are nil) not confirmed (Rails JSON params parsing of the body is a likely factor).
- **Who/what can resolve:** reading/running the controller with a debugger; product owner for the target behaviour.
- **Human question?** no
- **Proposed default:** Kotlin returns 400 `{"error":"Invalid JSON"}` (SDK behaviour); optionally a JSON-RPC parse error `-32700`.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-603 BUG? Analytics with `from > to` → 500 instead of 400 (API) / internal error (MCP)
- **What is unclear:** `Analytics::Period` raises `ArgumentError "from must be <= to"`, which the API maps to 500 `{"message":"ArgumentError: from must be <= to"}` (production: "Internal server error."). Applies to all five analytics endpoints and the three analytics MCP tools (which would return a JSON-RPC internal error).
- **Evidence for / against:** [oracle](../oracle/http/GET_api__version_analytics_cash_flow.json) case `from_after_to` → 500; `app/services/analytics/period.rb:19`; `app/services/analytics/filter.rb:38-40`; `lib/api/api.rb:32-40`. Other endpoints/tools [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** 400 `{"message":"Invalid parameters.","details":["from must be <= to"]}`; MCP tool error `isError: true`.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-604 BUG? Merchant `default_category_id` accepts another tenant's category (API + MCP)
- **What is unclear:** `POST /api/v1/merchants` / `PATCH /api/v1/merchants/:id` and MCP `merchants.create`/`merchants.update` store any category id; the response then embeds the other tenant's category (name, slug, path, colour) in `default_category`, and the foreign category would drive effective categorisation.
- **Evidence for / against:** [oracle](../oracle/http/POST_api__version_merchants.json) case `foreign_category` → 201 with `"default_category":{"id":119,…}` (119 belongs to tenant "other", `oracle/fixture.json`); `app/services/merchants/creator.rb:72-85`; `lib/api/resources/merchants.rb:80-84` (no scoping). Whether the model has any ownership validation: none observed.
- **Who/what can resolve:** product owner / security review.
- **Human question?** yes
- **Proposed default:** Reject foreign/unknown ids with 422 (`"Default category must exist"`-style message) or 404; never expose another tenant's category.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-605 BUG? `POST /api/v1/transaction_syncs` silently widens a foreign/inactive `bank_connection_id` to "all connections" and accepts `date_to < date_from`
- **What is unclear:** `TransactionSyncs::Queuer#resolve_subject` falls back to the user when the connection is not found among the user's active connections; inverted ranges are stored as-is. Same for MCP `transaction_syncs.create`.
- **Evidence for / against:** [oracle](../oracle/http/POST_api__version_transaction_syncs.json) cases `other_tenant_connection` → 201 with `"subject_type":"User"`, `date_to_before_from` → 201; `app/services/transaction_syncs/queuer.rb:44-47`. What the job does with an inverted range is documented by the sync writer.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** 404 for a foreign/unknown connection id, 422 for an inactive one, 400 for `date_to < date_from`.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-606 404 error messages leak internal SQL fragments
- **What is unclear:** RecordNotFound messages are returned verbatim, e.g. `"Couldn't find Category with 'id'=119 [WHERE \"categories\".\"user_id\" = $1]"`, including table/column names. Should Kotlin reproduce these strings?
- **Evidence for / against:** `lib/api/api.rb:12-14`; oracle `other_tenant_id` cases (e.g. [GET_api__version_categories__id.json](../oracle/http/GET_api__version_categories__id.json)). Specs only assert the presence of `message` (`spec/requests/api/v1/cross_cutting_spec.rb:22-31`).
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (migration choice)
- **Proposed default:** Keep the `{"message": …}` envelope and status, but use a neutral message `"Couldn't find <Model> with 'id'=<id>"` without the WHERE clause.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-607 Merchant `source` filter enum excludes `system`, the value used by seeded merchants
- **What is unclear:** API `GET /api/v1/merchants?source=` allows only `user|llm|seed` (400 otherwise) and the entity doc says "user / llm / seed", but seeded merchants have `source "system"`; `source=seed` matches nothing. MCP `merchants.list` allows `system`.
- **Evidence for / against:** `lib/api/resources/merchants.rb:13`; `lib/api/entities/merchant.rb:9`; `lib/mcp/tools/merchants/list.rb:13`; [oracle](../oracle/http/GET_api__version_merchants.json) `default` rows `"source":"system"`, `filtered` (`source=seed`) → empty. Model enum owned by the models doc.
- **Who/what can resolve:** product owner / models doc writer.
- **Human question?** yes
- **Proposed default:** Accept the model's full source set (`user|llm|seed|system`) in the API filter.
- **Resolution:** Resolved by D-011 — fix (recorded deviation, with a test).

### U-608 Swagger `info.version` is "0.0.1" although configured as "1.0.0"
- **What is unclear:** grape-swagger ignores `info.version` and uses its `doc_version` default.
- **Evidence for / against:** `lib/api/api.rb:65-69`; [oracle](../oracle/http/GET_api__version_swagger_doc.json) `"version":"0.0.1"`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** Publish `1.0.0` in the Kotlin OpenAPI document.
- **Resolution:** Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).

### U-609 Unmatched `/api/...` paths return Rails HTML 404, not JSON
- **What is unclear:** Unknown paths, non-integer `:id`s and unknown versions fall through Grape to Rails' routing 404 (HTML; dev exception page). Should Kotlin return a JSON 404 for everything under `/api/`?
- **Evidence for / against:** [oracle](../oracle/http/GET_api__version_merchants.json) `unknown_api_path_404` → 404 HTML; [oracle](../oracle/http/GET_api__version_categories__id.json) `non_integer_id` → 404 HTML; `spec/requests/api/v1/cross_cutting_spec.rb:77-84` (asserts only 404).
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** 404 with JSON `{"message":"Not Found"}` for any unmatched `/api/**` path; keep status 404.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-610 Pagination edge cases not guarded (negative `limit`, out-of-range `page`)
- **What is unclear:** Pagy clamps `limit` only from above (`[limit, 100].min`); a negative limit is passed to Pagy, which raises `OptionError` (→ 500 via the global handler). Page beyond the last returns an empty page.
- **Evidence for / against:** pagy 43.5.3 `lib/pagy/classes/request.rb:30-37`, `lib/pagy.rb:53-60`, `lib/pagy/modules/abilities/rangeable.rb:6-11`; not exercised by oracle/specs.
- **Who/what can resolve:** running `GET /api/v1/transactions?limit=-5`.
- **Human question?** no
- **Proposed default:** Treat `limit < 1` as default 10; page beyond range → empty `data` with correct `count/pages`.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-611 API `GET /api/v1/analytics/top_merchants` `limit` is unbounded (MCP clamps 1..50)
- **What is unclear:** API passes `params[:limit]` (default 10) straight to SQL `LIMIT`; huge values are allowed and negative values would raise a DB error (500). MCP clamps to 1..50.
- **Evidence for / against:** `lib/api/resources/analytics/top_merchants.rb:16,21`; `lib/mcp/tools/analytics/top_merchants.rb:24`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** Clamp to 1..50 in both surfaces.
- **Resolution:** Preserved behaviour (valid input) per D-002 unless it crashes; no 500 observed.

### U-612 Analytics ignore a single date bound
- **What is unclear:** `from`/`to` are applied only when both are present; a request with only `from` (or only `to`) silently returns month-to-date data.
- **Evidence for / against:** `app/services/analytics/filter.rb:176-190`. Not exercised.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Keep behaviour for compatibility (document it), or default the missing bound (`to` = today, `from` = first of `to`'s month).
- **Resolution:** Preserved behaviour (valid input) per D-002 unless it crashes; no 500 observed.

### U-613 POST action endpoints return 201 Created although nothing is created
- **What is unclear:** Grape's POST default (201) applies to `/archive`, `/unarchive`, `/approve`, `/refresh*`, `/make_primary`, `/test_connection`, `/classification`. Clients may depend on it.
- **Evidence for / against:** oracle `default` cases of those endpoints → 201; specs accept 200 or 201 (e.g. `spec/requests/api/v1/banking_spec.rb:81,207`, `categorization_spec.rb:109`, `transactions_spec.rb:208`).
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (migration choice)
- **Proposed default:** Keep 201 for wire compatibility.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-614 MCP tools crash (JSON-RPC internal error) on unexpected argument keys
- **What is unclear:** `cash.create_transaction`, `cash.update_transaction`, `transaction_syncs.create` pass `**args` into keyword Structs (unknown key → `ArgumentError`), and `merchants.create/update`, `categories.create/update` pass args into model attributes (unknown attribute → `ActiveModel::UnknownAttributeError`). The input schemas do not set `additionalProperties: false`, so such calls pass schema validation and fail as JSON-RPC errors instead of `isError` tool results.
- **Evidence for / against:** `lib/mcp/tools/cash/create_transaction.rb:29`, `cash/update_transaction.rb:33`, `operations/queue_transaction_sync.rb:22`, `merchants/create.rb:24`, `merchants/update.rb:28`, `categories/create.rb:26-30`; SDK `server.rb:596-601`. Not exercised.
- **Who/what can resolve:** running a `tools/call` with an extra key.
- **Human question?** no
- **Proposed default:** Ignore unknown keys (or return an `isError` result "Unknown argument: <key>").
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-615 409 StaleObjectError mapping is unreachable
- **What is unclear:** The API maps `ActiveRecord::StaleObjectError` to 409 `{"message":"Resource was modified by another request, try again."}`, but no table has a `lock_version` column, so optimistic locking never triggers.
- **Evidence for / against:** `lib/api/api.rb:20-22`; `inventory/schema.rb` (no `lock_version`); no spec references it.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** Keep the 409 mapping and message for any future optimistic-locking conflict; no locking columns required.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-616 Category PATCH cannot move a category to the top level
- **What is unclear:** `Categories::Mover` only recomputes the path when `parent_path` is present; sending `""`/null leaves the category under its current parent, though the Swagger param description for create says "null/empty = top-level".
- **Evidence for / against:** `app/services/categories/mover.rb:23-31`; `lib/api/resources/categories.rb:32,74`. Not exercised.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Keep current behaviour (blank = no move); document it.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-617 Swagger UI page depends on the public unpkg CDN
- **What is unclear:** `GET /api/:version/docs` loads `swagger-ui-dist@5` (floating major version) from `https://unpkg.com`; self-hosted/offline deployments get a blank page, and the floating version is a supply-chain risk.
- **Evidence for / against:** `app/views/swagger/index.html.erb:7,11`; ADR 0014 self-hosted deployment (`docs/adr/0014-self-hosted-deployment.md`).
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Bundle a pinned Swagger UI with the Kotlin service.
- **Resolution:** Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).

### U-700 BUG? Category ancestry is not tenant-scoped (duplicated breadcrumbs, cross-tenant name leak)
- **What is unclear:** `Category#ancestors`, `#descendants`, `#self_and_descendants` and `#children` query `Category` by ltree path **without** `user_id`. With two tenants sharing the seeded taxonomy, every breadcrumb label contains each ancestor twice ("Jedzenie / Jedzenie / W domu / W domu / Supermarkety", "Lifestyle / Lifestyle / Narzędzia cyfrowe / Narzędzia cyfrowe / SaaS / AI"), and a tenant who renames a category leaks the new name into the other tenant's labels. Side effects: `Category#in_use?` (`descendants.exists?`) can refuse deletion because of another tenant's sub-categories; analytics category pages (`@category.descendants.any?`, custom breadcrumbs from `ancestors`) mix tenants; the category form's parent-exclusion list includes foreign ids.
- **Evidence for / against:** [V] `../oracle/ui/admin_bank_transactions_index.png` and the category `<select>` options in `../oracle/ui/admin_cash_transactions_new.html` (13 doubled labels), `admin_merchants_new.html`, `admin_settings_app.html`; [I] `app/models/category.rb:83-99,113,116-119`, `app/controllers/admin/analytics/categories_controller.rb:19,35`. Against: `spec/system/cross_user_isolation_spec.rb:68-81` only checks the categories index list, which does not use ancestry.
- **Who/what can resolve:** original author / product owner (confirm it is a bug); 10-domain-model owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** fix in the Kotlin port — scope every ltree query by `user_id`; labels then read "Jedzenie / W domu / Supermarkety".
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-701 BUG? Hidden-category guard on merchant edit is dead code
- **What is unclear:** `Admin::MerchantsController` defines `edit` twice; the second empty definition (line 58) replaces the first (lines 37-42) that redirected with "This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it." So the edit page of a merchant in a hidden category opens normally (name shown in the form), unlike every other drill-down.
- **Evidence for / against:** [I] `app/controllers/admin/merchants_controller.rb:37-42,58-59` (Ruby method redefinition). No spec covers it (`spec/requests/categorization_spec.rb` only tests `show` for hidden merchants, :231-242).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** implement the guard (redirect to `/admin/merchants` with the alert above).
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-702 BUG? Invalid "Add bank" form answers 204 with empty body
- **What is unclear:** `Admin::BankConnectionsController#create` handles an invalid `BankConnectionRequestForm` with `flash.now[:alert] = …; return new`, but no template is rendered for the `create` action, so Rails replies **204 No Content**. The form is submitted with Turbo disabled, so the browser stays on the page with no feedback; the alert is lost.
- **Evidence for / against:** [V] `../oracle/http/POST_admin_bank_connections.json` case `invalid_blank_aspsp → 204`, empty body; [I] `app/controllers/admin/bank_connections_controller.rb:43-50`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** re-render the "Add bank connection" page with 422, the alert (joined form errors) and the submitted values.
- **Resolution:** Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.

### U-703 BUG? Cash-transaction "Delete" button is a form nested inside the edit form
- **What is unclear:** `_form` renders `button_to … method: :delete` (its own `<form>` with `_method=delete` and a CSRF token) inside the outer `form_with` (PATCH). Nested forms are invalid HTML; browsers drop the inner `<form>` tag, so clicking "Delete" submits the **outer** form with both `_method=patch` and `_method=delete` fields (Rack keeps the last → probably destroy) plus all edit fields; Turbo's confirm comes from the button's `data-turbo-confirm`. The actual browser outcome was not observed.
- **Evidence for / against:** [I] `app/views/admin/cash_transactions/_form.html.erb:15-18,123-130`; the oracle never captured the edit form (U-706); request specs call `DELETE` directly (`spec/requests/cash_spec.rb:243-268`). Contrast: the LLM settings view explicitly avoids nesting (`app/views/admin/settings/preferences/llm.html.erb:63`).
- **Who/what can resolve:** run a real browser against the edit page.
- **Human question?** no
- **Proposed default:** Kotlin UI renders Delete as a separate form outside the edit form, `DELETE /admin/cash_transactions/:id` with confirm "Delete this transaction?".
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-704 Bundle download under Turbo Drive
- **What is unclear:** The export form (`POST …/data_exchange/export`) is not marked `data-turbo="false"`; Turbo intercepts form submissions via `fetch` and expects HTML, so in a real browser the `application/octet-stream` attachment may not trigger a download. The system spec uses the non-JS `rack_test` driver, which follows the plain form post.
- **Evidence for / against:** [I] `app/views/admin/settings/data_exchange/show.html.erb:3-6`; [V] `spec/system/data_exchange_round_trip_spec.rb:29-49` (rack_test, `spec/support/system_spec_helper.rb:15`); oracle only exercised the HTTP endpoint (`../oracle/http/POST_admin_settings_preferences_data_exchange_export.json` → 200).
- **Who/what can resolve:** manual browser test.
- **Human question?** no
- **Proposed default:** in the port submit the export as a normal (non-Turbo) form post so the browser downloads `obr-export-<UTC yyyymmdd-HHMMSS>.obrbundle`.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-705 Non-English developer copy in the UI
- **What is unclear:** The repo rule says all developer-written UI copy is English (`AGENTS.md` "Language"), yet code contains Polish strings: chart tooltip lines "Udział:", "Transakcji:", "Δ vs poprz.:" and `pl-PL` currency formatting (`app/javascript/controllers/chart_controller.js:33,136-140`); multi-select search placeholder "Szukaj…" and "Brak wyników" (`multi_select_controller.js:97,116`); bank-account label "Alternate IBAN-y (np. Revolut PL+LT):" (`app/views/admin/bank_accounts/show.html.erb:53`); styleguide demo labels ("Saldo", "Wydatki", "Wpływy", "Top sprzedawca", "30 dni", "Brak transakcji w tym okresie"). Seeded Polish category/merchant names are data and are not affected.
- **Evidence for / against:** [I] files above; `AGENTS.md` lines 7-23.
- **Who/what can resolve:** product owner.
- **Human question?** yes (translate in the port or keep parity)
- **Proposed default:** translate to English ("Share:", "Transactions:", "Δ vs prev.:", "Search…", "No results", "Alternate IBANs (e.g. Revolut PL+LT):") and keep amounts formatted per the reporting currency.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-706 Several oracle UI captures do not show their intended state
- **What is unclear:** `admin_command_palette_open`, `admin_privacy_mask_toggled`, `mobile_admin_analytics_dashboard`, `mobile_admin_bank_transactions_index`, `first_run_after_setup_dashboard` show the sign-in page (session lost); `admin_cash_transactions_show`/`_edit` show the cash index with "This transaction was auto-generated and isn't editable here." (an ATM-link row was used); `admin_cash_transactions_new_invalid_submit` shows the filled form without the 422 error state. Command palette, privacy mode, mobile layout, the cash edit form and the cash validation re-render are therefore documented from code only.
- **Evidence for / against:** [V] titles/H1/flash of the listed `../oracle/ui/*.html`; the HTTP oracle does contain the 422 (`../oracle/http/POST_admin_cash_transactions.json` case `invalid_amount`).
- **Who/what can resolve:** re-run the UI capture signed in, with a `source=manual` cash row.
- **Human question?** no
- **Proposed default:** treat 40-ui.md code-derived descriptions as the contract for these screens.
- **Update (investigator, oracle run 3):** root causes were a capture-script defect (the invalid-submit step clicked the sidebar sign-out button, the first `[type=submit]` on the page) and an ATM-link fixture row. Both fixed; all listed captures except `first_run_after_setup_dashboard` (browser not signed in by design) now show the intended state. `GET /admin/cash_transactions/:id` for an editable row lands on the edit form [V].
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-707 Unused UI components and controllers — port or drop?
- **What is unclear:** Components/wrappers used only by the styleguide: `_bulk_action_bar`, `_category_picker`, `_confirm_dialog` (confirm button not wired), `_skeleton`, `_tabs`, `_toast`, form `_ajax_select` (expects a JSON search endpoint that does not exist), `_checkbox_group`, `_color_picker` (value span never filled), `_date_range_picker`, `_file_upload`, `_tags_input`, `_time_picker`; Stimulus `bulk_select_controller.js` is referenced nowhere; `file_upload`, `tabs`, `tags_input` controllers only via those partials. `_category_picker`'s comment claims usage that does not exist.
- **Evidence for / against:** [I] grep of `app/views` excluding the styleguide (no render calls); `app/views/admin/styleguide/index.html.erb`.
- **Who/what can resolve:** product owner / migration lead.
- **Human question?** yes (scope)
- **Proposed default:** do not port unused components; keep the styleguide only for components the Kotlin UI actually uses.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-708 BUG? Page `<title>` concatenates when a page renders several page headers
- **What is unclear:** `_page_header` calls `content_for :title, …`, which appends. The styleguide's title becomes "Styleguide · Open BankingTitle only · Open BankingWith subtitle · …". Real pages render one header, so only the styleguide is affected; also the merchant edit page shows "Edit:  · Open Banking" after a blank-name validation error (uses the unsaved value).
- **Evidence for / against:** [V] `../oracle/ui/admin_styleguide.html` `<title>`, `../oracle/http/PUT_admin_merchants__id.json` case `invalid_blank_name` (title "Edit:  · Open Banking"); [I] `app/views/admin/shared/components/_page_header.html.erb:3`.
- **Who/what can resolve:** n/a (cosmetic).
- **Human question?** no
- **Proposed default:** set the title once per page (last/first header wins); use the persisted name in the edit title.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-709 Copy/count inconsistencies on dashboard and AI enrichment pages
- **What is unclear:** (a) Dashboard empty state "<n> transactions awaiting classification" is not pluralised ("1 transactions …") while the banner uses `pluralize`. (b) AI Enrichment "What's left": the hint under "Without a merchant" says "The numbers below add up to this", but "Ready to send to LLM" counts **groups** (distinct normalized title+counterparty) not transactions, and "Awaiting approval" counts merchants, so 24 ≠ 0 + 3 + 13 in the oracle. (c) Auto-sync empty state says "Add one in Settings → Bank connections" although connections live under "Bank Integrations".
- **Evidence for / against:** [V] `../oracle/ui/admin_analytics_dashboard.png` ("1 transactions awaiting classification"), `../oracle/ui/admin_llm_enrichments_index.html` (24/0/3/13); [I] `app/views/admin/analytics/dashboard/index.html.erb:389-394`, `app/views/admin/llm_enrichments/index.html.erb:32-45`, `app/views/admin/transaction_syncs/_auto_sync_panel.html.erb:13-16`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (which numbers the panel should show)
- **Proposed default:** pluralise; show transaction counts in all four rows (or drop the "add up" claim); point the empty state at "Bank Integrations → Bank Connections".
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-710 Spend-change KPI colours: more spend shown green, less spend red
- **What is unclear:** The dashboard "Spend change" card passes `trend: :up` for a delta ≥ 0; `_stat_card` colours `:up` green and anything else red, so spending more looks positive and spending less negative (the oracle shows "-100%" with a red pill). Top movers use the opposite (increase red). Intent unclear.
- **Evidence for / against:** [V] `../oracle/ui/admin_analytics_dashboard.png`; [I] `app/views/admin/analytics/dashboard/index.html.erb:334-341`, `app/views/admin/shared/components/_stat_card.html.erb:19-27`, `:640-683` (movers).
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** invert for spend (increase red, decrease green), consistent with top movers and the chart's `delta_sign_inverse` flag.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-711 Does the TPP credential edit page re-display the stored private key?
- **What is unclear:** `_form` renders `form.text_area :private_key_pem` (and `application_id` text field), which in Rails outputs the current decrypted value into the page, contradicting the copy "Never logged or shown after save." The oracle HTML shows `application_id` filled ("fake-app-pko") but an **empty** private-key textarea although the showcase seeds an RSA PEM, so either the capture scrubbed textarea content or the value is not rendered for a reason not visible in the view.
- **Evidence for / against:** [I] `app/views/admin/tpp_credentials/_form.html.erb:33-47`, `app/services/seeders/showcase.rb:166-183`; [V] `../oracle/ui/admin_tpp_credentials_edit.html` (empty textarea, filled application id input).
- **Who/what can resolve:** inspect the raw HTTP response of `GET /admin/tpp_credentials/:id/edit`; security owner.
- **Human question?** yes (security: should secrets be re-rendered on edit?)
- **Proposed default:** never render stored secrets; leave secret fields blank with a "leave blank to keep" hint (as the LLM API-key field does) and keep the stored value when blank.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-712 Breadcrumb record labels are resolved without tenant scope
- **What is unclear:** `breadcrumb_label_for_id` derives a model from the URL segment and calls `Model.find_by(id:)` unscoped. It only runs while rendering pages whose controller already authorized the record, so no foreign label is shown today; but the Audit Log (`/admin/versions/:id`, itself unscoped) and any future page with an unscoped id segment would expose other tenants' record names.
- **Evidence for / against:** [I] `app/helpers/admin/base_helper.rb:174-190`; [V] breadcrumbs "Admin › Bank Connections › PKO BP" in `../oracle/ui/admin_bank_connections_show.html`.
- **Who/what can resolve:** n/a.
- **Human question?** no
- **Proposed default:** in Kotlin, compute breadcrumb labels from the already-loaded, user-scoped record.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-800 BUG? TransactionSyncJob Sidekiq retries re-run the circuit breaker
- **What is unclear:** When an exception escapes `TransactionSyncJob#perform`, the run is marked failed and the exception is re-raised, so Sidekiq retries up to 3 times. Each retry hits `return if run.terminal?`, but the `ensure` block still calls `AutoSync::CircuitBreaker.observe` for scheduled runs. One failed scheduled run could therefore add up to 4 to `consecutive_failures`, which trips the 24 h pause (threshold 3) after a single incident.
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:10`, `:16`, `:31-36`, `:41-46`; `app/services/auto_sync/circuit_breaker.rb:36-41`; `app/models/sync_schedule.rb:35`. There is no job spec. Specs only cover the breaker in isolation (`spec/services/auto_sync/circuit_breaker_spec.rb:44`, `:57`). Per-account API failures are caught and do not raise, so only "infrastructure" exceptions (DB errors, `RecordNotUnique`, bugs) trigger this.
- **Who/what can resolve:** original author; a spec that raises inside the job with Sidekiq retries enabled.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** In Kotlin, observe the breaker exactly once per run, when it reaches a terminal state, and do not retry runs that are already terminal.
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

### U-801 Retry policy of LlmEnrichmentJob and TransactionSyncJob is ineffective
- **What is unclear:** Both jobs mark the run failed before re-raising, and both return immediately when the run is terminal. Sidekiq retries (25 for LlmEnrichmentJob, 3 for TransactionSyncJob) therefore never redo the work; they only create noise and, for LlmEnrichmentJob, finally put the job in the Dead set. A `RecordNotFound` for a deleted run is retried 25 times.
- **Evidence for / against:** `app/jobs/llm_enrichment_job.rb:9-10`, `:48-50`; `app/jobs/transaction_sync_job.rb:6-10`, `:15-16`, `:31-33`; `inventory/jobs.json`.
- **Who/what can resolve:** original author.
- **Human question?** yes (intent: should a failed run ever be retried automatically?)
- **Proposed default:** No automatic retry of business work. The user re-queues a new run. Infrastructure-level retry only before the run has started.
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

### U-802 FailingJob behaviour and whether to keep the debug tooling
- **What is unclear:** The Sidekiq worker log was not captured, so the exact retry sequence of `FailingJob` is not observed. The dashboard about 96 s after the enqueue showed 53 processed, 3 failed, 1 retry, 0 dead. The likely explanation: ActiveJob made 3 attempts (`retry_on ... attempts: 3`, wait 3 s), then Sidekiq retries ran. This is inferred. Also open: whether the dev-only debug page (`/admin/debug*`) and FailingJob should exist in Kotlin at all.
- **Evidence for / against:** `app/jobs/failing_job.rb:6`; `config/routes.rb:33-42`; `oracle/server.log.txt:15708`; [oracle UI](../../oracle/ui/sidekiq_dashboard.html); [oracle](../../oracle/http/POST_admin_debug_enqueue_failing_job.json) -> 204.
- **Who/what can resolve:** run Sidekiq with log capture; product owner on scope.
- **Human question?** yes (scope)
- **Proposed default:** Drop it from the functional scope. If kept, make it a dev-profile-only endpoint that enqueues a job which always throws.
- **Resolution:** Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).

### U-803 BUG? Runs can get stuck in queued/running (no reaper)
- **What is unclear:** The dispatcher and queuers create the run, then enqueue the job after commit. If the enqueue fails (Redis down), the run stays `queued` forever. For scheduled runs the schedule has already advanced to the next slot. If a worker dies mid-job, the run stays `running`. Nothing sweeps stale runs.
- **Evidence for / against:** `app/services/auto_sync/dispatcher.rb:59-79`; `app/services/transaction_syncs/queuer.rb:27-36`; `app/services/llm_enrichments/queuer.rb:32-41`; no sweeper job in `app/jobs` or `config/schedule.yml`.
- **Who/what can resolve:** original author / product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Use a transactional outbox, or enqueue in the same transaction (DB-backed queue), plus a periodic reaper that fails runs stuck longer than N minutes with a clear error.
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

### U-804 No locking between concurrent syncs of the same account
- **What is unclear:** Two transaction syncs for the same connection/account can run at once (oracle runs 8 and 9 overlapped). If both insert the same new `external_id`, the unique index `(bank_account_id, external_id)` raises `RecordNotUnique`. That exception is not a `SyncAccountTransactions::Failed`, so it escapes and fails the whole run instead of one account.
- **Evidence for / against:** [operation_runs](../../oracle/operation_runs_after_capture.jsonl) runs 8 (started 12:50:56.187) and 9 (started 12:50:56.233, finished 12:50:58.377); `inventory/schema.rb:103`; `app/services/enable_banking/operations/sync_account_transactions.rb:55-77`; `sync_connection_transactions.rb:38`.
- **Who/what can resolve:** original author.
- **Human question?** no
- **Proposed default:** Take a per-account (or per-connection) lock (advisory lock) during sync and use insert-on-conflict-do-nothing semantics.
- **Resolution:** Resolved by D-008 — fix scheduling/retry/reaper/locking defects.

### U-805 BUG? Inverted sync window accepted
- **What is unclear:** `POST /api/v1/transaction_syncs` with `date_from` after `date_to` is accepted (201), and the run succeeds with 0 rows. Nobody validates the window. Open: is this intended?
- **Evidence for / against:** [oracle](../../oracle/http/POST_api__version_transaction_syncs.json) case date_to_before_from -> 201; run 8 in [operation_runs](../../oracle/operation_runs_after_capture.jsonl) `status: succeeded`, `inserted/updated/skipped 0`; `app/services/transaction_syncs/queuer.rb:7-11`. Compare the analytics endpoint, which raises "from must be <= to" (known finding).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Reject with 400/422 "date_from must be on or before date_to".
- **Resolution:** Resolved by D-018 — reject inverted sync windows (400 / alert).

### U-806 Unknown/foreign bank_connection_id silently widens the sync to all connections
- **What is unclear:** `TransactionSyncs::Queuer#resolve_subject` falls back to the user when the connection id is not one of the user's active connections. A typo or a foreign id therefore triggers a full user-wide sync instead of an error.
- **Evidence for / against:** `app/services/transaction_syncs/queuer.rb:44-47`; [oracle](../../oracle/http/POST_api__version_transaction_syncs.json) case other_tenant_connection -> 201, run 9 `subject_type: "User"`. There is no data leak.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Return 404 for an id that does not belong to the caller. Fall back to a user-wide sync only when the id is omitted.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-807 Mail sender addresses are placeholders and not configurable
- **What is unclear:** Devise mails go out from `please-change-me-at-config-initializers-devise@example.com`, and `ApplicationMailer` defaults to `from@example.com`. No ENV var exists to set a real sender, so production reset mails will likely be rejected or marked as spam.
- **Evidence for / against:** `config/initializers/devise.rb:27`; `app/mailers/application_mailer.rb:2`; `oracle/server.log.txt:194-195`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Add a `MAIL_FROM` setting (default `no-reply@<APP_HOST>`).
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-808 BUG? No brute-force protection; password reset allows account enumeration
- **What is unclear:** There is no lockout (`lockable` off), no rate limiting (no rack-attack, no `rate_limit`) on sign-in, password reset, setup, API or MCP. Devise paranoid mode is off: an unknown email gets a 422 re-render, a known email a 303 plus an email.
- **Evidence for / against:** `app/models/user.rb:2`; `config/initializers/devise.rb:93`; `Gemfile`; [oracle](../../oracle/http/POST_admin_password.json) cases unknown_email -> 422, known_email -> 303.
- **Who/what can resolve:** product owner / security review.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Kotlin adds per-IP and per-account throttling on auth endpoints and returns the same neutral response for password reset requests.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-809 Referenced password-reset "rake-task escape hatch" does not exist
- **What is unclear:** `config/environments/production.rb:71-72` says "password reset has a rake-task escape hatch". No such task is in `lib/tasks` (`inventory/rake_tasks.json`). ADR 0011 instead mentions a "documented `bin/rails runner` one-liner".
- **Evidence for / against:** `lib/tasks/*.rake`; `docs/adr/0011-first-run-setup.md` "Consequences".
- **Who/what can resolve:** original author.
- **Human question?** yes (scope)
- **Proposed default:** Provide an admin CLI command `reset-password --email ...` in Kotlin.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-810 BUG? Sidekiq Web is available to every signed-in user
- **What is unclear:** `/sidekiq` is mounted behind `authenticate :user` only. Any tenant can see every queue and job argument and can retry, delete or kill jobs, including those of other tenants.
- **Evidence for / against:** `config/routes.rb:12-14`; [oracle](../../oracle/http/GET_sidekiq.json) case authenticated -> 200 (there is no other-tenant case, but the guard does not distinguish users).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Do not expose a raw queue dashboard in Kotlin, or restrict it to an operator role or a separate port.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-811 BUG? /admin/versions exposes all tenants' audit trail (verified)
- **What is unclear:** `Admin::VersionsController` reads `PaperTrail::Version` without any user filter. Other tenants see IBANs, account names, manual-transaction amounts and notes. `raw_balances` appears only as ciphertext because PaperTrail serialises the encrypted value.
- **Evidence for / against:** `app/controllers/admin/versions_controller.rb:5-11`; [oracle](../../oracle/http/GET_admin_versions.json) case other_tenant_sees_all_versions -> 200; [oracle](../../oracle/http/GET_admin_versions__id.json) case other_tenant_reads_main_version -> 200; `oracle/server.log.txt:1719-1766`. Also, `BankAccount` has `has_paper_trail` without `skip: [:raw_balances]` (`app/models/bank_account.rb:71`), which contradicts ADR 0004 "PaperTrail skips them".
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Scope versions to items owned by the current user and exclude encrypted columns from audit payloads.
- **Resolution:** Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.

### U-812 CORS allows any origin on every path
- **What is unclear:** `Rack::Cors` allows origin `*` with all methods for all resources, including the admin HTML. Credentials are not allowed, so cookies are not sent cross-origin, but the intent (API-only? MCP clients in browsers?) is undocumented.
- **Evidence for / against:** `config/initializers/cors.rb:1-6`; [oracle](../../oracle/http/OPTIONS_api__version_merchants.json) -> `access-control-allow-origin: *`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** Allow `*` only for `/api/**` and `/mcp` (bearer-token endpoints) and send no CORS headers elsewhere.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-813 No Content-Security-Policy; third-party CDNs loaded at runtime
- **What is unclear:** No CSP is configured. Pages load Google Fonts, jsDelivr (Chart.js) and unpkg (Swagger UI) at runtime without SRI. For a self-hosted finance app this leaks visits to third parties and fails when offline. Open: should Kotlin self-host these assets?
- **Evidence for / against:** `config/initializers/content_security_policy.rb:7-29`; `app/views/layouts/admin.html.erb:19-21`; `config/importmap.rb:12-13`; `app/views/swagger/index.html.erb:7`, `:11`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Self-host fonts and JS and add a strict CSP (`default-src 'self'`).
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-814 OpenTelemetry defaults in production
- **What is unclear:** The production compose sets no `OTEL_*` variables, so the SDK starts with default OTLP exporters pointing at `localhost:4318` inside the container, where nothing listens. The effect (error log noise, memory) is unobserved: the oracle had the SDK disabled. The observability stack is dev-only.
- **Evidence for / against:** `config/initializers/opentelemetry.rb:5-8`; `docker-compose.prod.yml:15-32`; `oracle/server.log.txt:4`.
- **Who/what can resolve:** running the prod image; product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Telemetry export off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-815 No alerts defined
- **What is unclear:** `docker/prometheus/rules/alerts.yaml` is empty, and Prometheus loads only `rules/*.yml` (a `.yaml` file would be ignored anyway). Alertmanager routes to a `null` receiver. Open: were alerts planned, and which ones?
- **Evidence for / against:** `docker/prometheus/prometheus.yaml:5-6`; `docker/prometheus/rules/alerts.yaml` (0 bytes); `docker/alertmanager/alertmanager.yaml:4-12`.
- **Who/what can resolve:** original author.
- **Human question?** yes (scope)
- **Proposed default:** No alerting in scope. Optionally add a basic HTTP 5xx-rate and job-failure alert.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-816 LLM privacy statement vs data actually sent
- **What is unclear:** `config/initializers/ruby_llm.rb:9-10` claims "only normalized titles + counterparty names are ever sent". `MerchantSuggester` actually sends `title_raw`, sometimes `title_normalized`, `counterparty_name`, and the user's whole list of active leaf category paths. No amounts or IBANs are sent. The prompts are Polish. Open: is sending raw titles acceptable, and is the Polish prompt fixed product behaviour?
- **Evidence for / against:** `app/services/llm/merchant_suggester.rb:58-64`, `:76-214`; [operation_runs](../../oracle/operation_runs_after_capture.jsonl) run 10 `request` contains raw titles.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Keep the current payload (raw + normalized title, counterparty name, category paths) and the prompt text verbatim, and correct the documentation.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-817 First-run setup is unauthenticated and not race-safe
- **What is unclear:** On a fresh instance, whoever reaches `/setup` first becomes the owner; there is no setup token. `SetupController#create` checks `User.exists?` and then saves without a lock, so two concurrent POSTs with different emails could create two users.
- **Evidence for / against:** `app/controllers/setup_controller.rb:12-25`; `app/controllers/application_controller.rb:9-15`; `docs/adr/0011-first-run-setup.md`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Keep the UX, but serialise creation (advisory lock or single-row guard). Optionally require a one-time setup token printed to the container log.
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-818 Compatibility with existing Rails-encrypted data
- **What is unclear:** Existing databases hold AR-encryption ciphertext (`{"p","h":{"iv","at"}}`, AES-256-GCM, key derived from `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY` + salt). The Kotlin service must either reproduce Rails' key derivation and envelope format or run a one-time re-encryption migration. Backups, exports and the data-exchange fingerprint depend on these keys.
- **Evidence for / against:** `config/initializers/active_record_encryption.rb:15-24`; encrypted attributes in `inventory/models.json`; `oracle/server.log.txt` raw_balances insert; `app/services/data_exchange/operations/export.rb:94-100`.
- **Who/what can resolve:** migration architect.
- **Human question?** yes (migration choice)
- **Proposed default:** Implement a Rails-compatible decryptor (PBKDF2-SHA256 key derivation, AES-256-GCM, JSON envelope), re-encrypt lazily, and keep the same three ENV secrets.
- **Resolution:** Resolved by D-005 (in-place compatibility: Flyway baseline from schema.rb, Rails AR-encryption format, PaperTrail YAML kept).

### U-819 Production compose defaults disable TLS enforcement; no session timeout
- **What is unclear:** Code defaults `FORCE_SSL=true` and `APP_PROTOCOL=https`, but `docker-compose.prod.yml` defaults to `FORCE_SSL=false` and `APP_PROTOCOL=http`. Default deployments therefore send session cookies without `Secure` and without HSTS. Sessions also never time out (no `timeoutable`), and remember-me lasts 2 weeks. Open: are these the intended defaults?
- **Evidence for / against:** `config/environments/production.rb:27-31`, `:66`; `docker-compose.prod.yml:20`, `:22`; `config/initializers/devise.rb:170`, `:194`; `.env.example:31-34`.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Mirror the compose defaults (HTTP behind a user-provided proxy) but document them prominently. Add an idle timeout (for example 30 min, configurable).
- **Resolution:** Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.

### U-820 LLM_MERCHANT_AUTO_APPROVE_THRESHOLD is undocumented and read at class load
- **What is unclear:** The threshold is read once when `Llm::EnrichmentRunner` loads, so changing it needs a restart. It is absent from `.env.example` and compose. `MerchantSuggester::Result#confident?` has its own default of 0.85, but the runner always passes its threshold. Invalid values (`"abc"`) become 0.0, which auto-approves everything.
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:9`, `:101`, `:160`, `:174`; `app/services/llm/merchant_suggester.rb:10-12`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** A validated config property in [0,1], default 0.85; fail at startup when the value is invalid.
- **Resolution:** Resolved by D-010 — keep exact LLM behaviour (parity).

### U-821 TransactionSyncJob error message overwritten for unsupported or deleted subjects
- **What is unclear:** For a subject that is neither User, BankConnection nor BankAccount (or was deleted), the job calls `fail!("Unsupported subject: ...")`. `OperationRunFinalizer` then runs on an empty summary and overwrites the error with `"No accounts in scope"`.
- **Evidence for / against:** `app/jobs/transaction_sync_job.rb:26-28`, `:119-121`; `app/services/operation_run_finalizer.rb:17`.
- **Who/what can resolve:** original author.
- **Human question?** no
- **Proposed default:** Stop after the unsupported-subject failure and keep that message.
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).

### U-822 BUG? SMTP configuration pitfalls in production
- **What is unclear:** (a) Without `SMTP_ADDRESS`, Rails falls back to SMTP on localhost:25 with the production default `raise_delivery_errors = true`, so `POST /admin/password` would probably answer 500 (not observed). (b) The compose file passes `SMTP_PORT`, `SMTP_AUTHENTICATION` and `SMTP_STARTTLS` as empty strings when unset. `ENV.fetch` returns `""` rather than the default, which gives port 0, authentication `:""` and STARTTLS off when an operator sets only `SMTP_ADDRESS`. Delivery is synchronous in the request.
- **Evidence for / against:** `config/environments/production.rb:55-57`, `:69-83`; `docker-compose.prod.yml:26-32`; synchronous delivery in `oracle/server.log.txt:192-214`.
- **Who/what can resolve:** running the prod image with and without SMTP vars.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Treat empty strings as unset. Send mail asynchronously and do not fail the reset request on SMTP errors (log them instead).
- **Resolution:** Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise).
