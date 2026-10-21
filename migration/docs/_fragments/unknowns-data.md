# Unknowns and findings - data / domain model (U-100..U-149)

### U-100 BUG? Category tree helpers are not tenant-scoped (duplicated breadcrumbs, cross-tenant leaks)
- **What is unclear:** `Category#ancestors`, `#descendants`, `#self_and_descendants`, `#children`, `#parent`, `#in_use?` and `#breadcrumb_names` query `Category` by ltree path without `user_id` (`app/models/category.rb:83-119`). Since migration `20260507180000`, paths are only unique per user, and every user gets the same seeded paths. The effects: (a) breadcrumbs list each ancestor once per tenant; (b) the other tenant's category **names** are shown (information leak, e.g. a renamed category); (c) `in_use?` returns true when another tenant has descendants, which blocks deletion; (d) `parent` may return the other tenant's row; (e) the analytics category page's subtree/ancestor lists mix tenants (`app/controllers/admin/analytics/categories_controller.rb:19,35`, `lib/api/resources/analytics/categories.rb:26`).
- **Evidence for / against:** Oracle with two tenants: [oracle](../../oracle/ui/admin_cash_transactions_new.html) contains "Jedzenie / Jedzenie / W domu / W domu / Supermarkety" and "Jedzenie / Jedzenie / Oracle API Category Renamed" [V]. The spec `spec/models/category_spec.rb:103` covers a single user only. By contrast, `Categories::Mover` scopes its rewrite to the user (`spec/services/categories/mover_spec.rb:61`).
- **Who/what can resolve:** product owner (confirm the bug), developer.
- **Human question?** yes (fix vs keep; the fix is almost certainly wanted)
- **Proposed default:** In Kotlin, scope every tree query by `user_id` of the category (`WHERE user_id = :uid AND path <@ :p`).

### U-101 BUG? BankAccount uid is globally unique and account lookup is not scoped to the tenant
- **What is unclear:** `bank_accounts.uid` has a global unique index (`db/schema.rb:49`), and `CreateConnection#find_existing_account` does `BankAccount.find_by(uid:)` unscoped (`app/services/enable_banking/operations/create_connection.rb:85-93`). The upsert then reassigns `tpp_credential` and `current_bank_connection` to the new credential (`:55-73`). If a second tenant's bank returns the same uid, that tenant takes over the first tenant's account and its whole transaction history.
- **Evidence for / against:** Code reading [I]. The investigator observed it while seeding two tenants (brief). I did not reproduce it independently. Wallet uids embed the user id (`cash_<user_id>_<cur>`, `app/services/cash/wallet_resolver.rb:35-37`), so wallets are unaffected.
- **Who/what can resolve:** product owner; running two tenants against a bank returning identical uids.
- **Human question?** yes (bug-to-fix and the uniqueness scope for the new schema)
- **Proposed default:** Make the uid unique per `tpp_credential_id` (or per user) and scope the lookup to the credential.

### U-102 BUG? LedgerEntryConcern delegates `enrichment_source` / `enrichment_confidence` to methods that do not exist
- **What is unclear:** `delegate :merchant, :category, :enrichment_source, :enrichment_confidence, to: :enrichment, allow_nil: true` (`app/models/concerns/ledger_entry_concern.rb:14-15`). `TransactionEnrichment` has `source` and `confidence`, but no `enrichment_source`/`enrichment_confidence`. Calling these on a transaction that has an enrichment would raise NoMethodError. With no enrichment they return nil (`spec/models/concerns/ledger_entry_concern_spec.rb:6,19` [V]).
- **Evidence for / against:** grep finds no callers in app/lib (only `params[:enrichment_source]` and helpers named `enrichment_source_*`) [I].
- **Who/what can resolve:** developer.
- **Human question?** no
- **Proposed default:** Expose `enrichmentSource`/`enrichmentConfidence` on the Kotlin ledger entity as `enrichment?.source` / `enrichment?.confidence`.

### U-103 Enum values that no code path ever produces
- **What is unclear:** Several allowed values are never written: `TransactionEnrichment.source = "llm_pending"` (only UI labels, `app/helpers/admin/enrichment_helper.rb:9,19`); `BankConnection.status = "pending"` (DB default only; connections are created `authorized`, `create_connection.rb:38`); `BankAccount.status = "inactive"/"revoked"`; `OperationRun.kind = balance_refresh / connection_refresh / account_details_refresh` (no `OperationRun.create!` with those kinds, grep of app/lib); `ManualTransaction.source = csv_import / recurring` ("reserved", `db/migrate/20260430120001_create_manual_transactions.rb:31-33`).
- **Evidence for / against:** grep of `app/`, `lib/` [I]. Oracle runs contain only transaction_sync, llm_enrichment, llm_connection_test, data_export (`oracle/operation_runs_after_capture.jsonl`) [V].
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope: keep the reserved values in Kotlin enums?)
- **Proposed default:** Keep all values in the Kotlin enums (data import/export and filters accept them) but implement no producers.

### U-104 BUG? ATM top-up enrichment looks up a category slug that is never seeded
- **What is unclear:** `Cash::AtmWithdrawalLinker` builds the top-up's enrichment with `category: user.categories.find_by(slug: "cash_atm_topup")` (`app/services/cash/atm_withdrawal_linker.rb:46-50`). The seeded taxonomy has no such slug (seed slugs are full paths with underscores, e.g. `money_transfers_atm`, `app/services/seeders/categories.rb:171,203`). The top-up is therefore stored with `source = system_fallback` and `category_id = NULL`, which makes it unmatched in analytics until a later `rebuild!` re-enriches it through the payment-method fallback (`credit, cash_atm_topup → money.transfers.atm`, `app/services/enrichment/transaction_enricher.rb:39`).
- **Evidence for / against:** The spec `spec/services/cash/atm_withdrawal_linker_spec.rb:30` compares against the same nil lookup, so it passes vacuously [I].
- **Who/what can resolve:** developer / product owner.
- **Human question?** no (the intent is clear from the comments: the pair is a transfer)
- **Proposed default:** Use the category at path `money.transfers.atm` (the enricher's fallback) for the top-up.

### U-105 PaperTrail history: `whodunnit` never recorded; YAML with Ruby tags
- **What is unclear:** No controller sets `whodunnit`, so every `versions.whodunnit` is NULL, even though the UI shows a "By" column (`app/views/admin/versions/index.html.erb:62,86`). `object`/`object_changes` are Psych YAML containing `!ruby/object:ActiveSupport::TimeWithZone` tags and anchors. Should the Kotlin service record the actor, and must historical versions be converted?
- **Evidence for / against:** oracle `server.log.txt` INSERT INTO "versions" … whodunnit NULL; YAML bodies [V]. grep of app finds no `whodunnit` assignment [I].
- **Who/what can resolve:** product owner (audit requirements); migration owner.
- **Human question?** yes (migration choice)
- **Proposed default:** The Kotlin audit log records the acting user id. Convert historical rows once to JSON (parse the YAML with a Ruby-tag-tolerant parser, or export from Rails before cut-over), keeping `whodunnit` NULL for history.

### U-106 Encrypted-at-rest data: Rails ActiveRecord-encryption compatibility
- **What is unclear:** 8 columns plus copies in `versions` (BankAccount `raw_balances`) hold Rails AR-encryption envelopes `{"p","h":{"iv","at"[,"c"]}}` (AES-256-GCM, key derived from env primary key + salt, optional zlib compression). A Kotlin service must either implement a Rails-compatible decryptor/encryptor or re-encrypt the data during migration. ADR 0004 also states that "PaperTrail skips them", which is false for `BankAccount.raw_balances` (`app/models/bank_account.rb:71`).
- **Evidence for / against:** `docs/adr/0004-encryption-at-rest.md:15-23`; `config/initializers/active_record_encryption.rb:15-32`; envelopes observed in oracle `server.log.txt` (including inside BankAccount versions) [V]. KDF/cipher details are Rails defaults, not verified by execution [I].
- **Who/what can resolve:** migration owner; a spike decrypting a sample with the JVM.
- **Human question?** yes (migration choice)
- **Proposed default:** A one-off Rails-side export that decrypts and re-encrypts with the Kotlin scheme (e.g. AES-GCM via Tink), plus stripping or re-encrypting `raw_balances` inside migrated versions.

### U-107 Migrations cannot be replayed on an empty database
- **What is unclear:** `20260430230000_scope_categories_merchants_rules_to_user` raises "Cannot backfill - no User exists. Create one first." when `users` is empty (`db/migrate/20260430230000_scope_categories_merchants_rules_to_user.rb:19-20`), so a fresh install depends on `db:schema:load`, not `db:migrate`. Migration #15 also calls application code (`EnableBanking::PaymentMethodInferer`).
- **Evidence for / against:** Code reading [I]. The oracle DB was built from the schema (33 schema_migrations rows) [V].
- **Who/what can resolve:** none needed.
- **Human question?** no
- **Proposed default:** The Flyway baseline is generated from the final `db/schema.rb` (see 50-data §5). Do not port individual migrations.

### U-108 `categories.path` is nullable in the DB but mandatory in the model
- **What is unclear:** Migration 24 added `path` without a backfill or NOT NULL (`db/migrate/20260501140000_layered_categories_foundation.rb:60-62`). The model requires presence (`app/models/category.rb:56`). Rows with NULL path would be invisible to every ltree query and to the view's `category_path`.
- **Evidence for / against:** `db/schema.rb:118` [I]. The oracle has seeded rows only (all with paths).
- **Who/what can resolve:** migration owner (check production for NULL paths).
- **Human question?** yes (migration choice)
- **Proposed default:** `path ltree NOT NULL` in the Kotlin baseline, after verifying that no NULLs exist (or after reseeding).

### U-109 Re-running the seeders overwrites user customisations of seeded rows
- **What is unclear:** `Seeders::Categories` re-assigns `name`, `kind`, `color`, `icon`, `essential`, `path`, `position` on every seeded slug (`app/services/seeders/categories.rb:200-216`). `Seeders::MerchantRules` re-assigns merchant `name`, `kind`, `source`, `default_category` and rule `kind`/`enabled` (`app/services/seeders/merchant_rules.rb:270-349`). The admin button `POST /admin/onboarding/seed_taxonomy` and `db:seed` therefore revert renames, moves (the path is reset while descendants are not), kind changes and disabled system rules. ADR 0010 says renames are safe because only `name` changes (`docs/adr/0010-three-layer-category-model.md:38-40`).
- **Evidence for / against:** `spec/services/seeders/categories_spec.rb:18` asserts "re-applies attribute changes" [V], so this is intended for definition edits. Whether user edits should survive is not stated.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Replicate as-is (idempotent upsert keyed by slug that overwrites), and document the button as "reset baseline taxonomy".

### U-110 User deletion semantics are undefined
- **What is unclear:** There is no UI/API to delete a user. Through `dependent: :destroy` chains, deletion would fail when a credential has connections or accounts (`restrict_with_error`, `app/models/tpp_credential.rb:42-43`), and order-dependent FK errors are possible (e.g. `manual_transactions.created_by_user_id` pointing at another user). ADR 0009 assumes "cascade-on-user-delete" for operation runs.
- **Evidence for / against:** `app/models/user.rb:27-45`; `docs/adr/0009-operation-run-tracker.md:32` [I]. Only token cascade is spec'd (`spec/models/personal_access_token_spec.rb:120` [V]).
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** Out of scope for parity. If implemented, do a full tenant purge in one transaction, in FK order.

### U-115 Bank transaction edge cases: zero amounts and pending rows that change id on booking
- **What is unclear:** (a) `bank_transactions.amount_cents` has no positivity rule (the manual table requires > 0), so a 0.00 bank entry is stored and counts as a debit (signed `-0`). (b) Sync updates a pending row only when the booked version keeps the same `external_id`. If the bank issues a new id at booking, the stale pending row remains forever (no cleanup) (`app/services/enable_banking/operations/sync_account_transactions.rb:66-76`).
- **Evidence for / against:** Code reading [I]. No spec covers either case.
- **Who/what can resolve:** bank data analysis / product owner.
- **Human question?** yes (bug-to-keep-or-fix for b)
- **Proposed default:** Keep the behaviour (parity). Log a follow-up to purge pending rows older than N days that were not seen in the latest sync window.

### U-116 Three different slug algorithms for merchants
- **What is unclear:** `Merchant#generate_slug` NFD-normalises before stripping marks ("Żabka" → `zabka`, `app/models/merchant.rb:83-88`). `Merchants::Creator#generate_slug` and `Llm::EnrichmentRunner#slugify` strip `\p{M}` **without** NFD normalisation, so precomposed letters like "Ż" become `_` and are trimmed (`abka`) (`app/services/merchants/creator.rb:35-45`, `app/services/llm/enrichment_runner.rb:178-181`). The Creator also adds `_2`, `_3` suffixes. The LLM runner can therefore create a second merchant for a seeded one (`zabka` vs `abka`). Categories::Creator uses the non-NFD variant too.
- **Evidence for / against:** Code reading [I]; `spec/models/merchant_spec.rb:43` covers only the model path [V].
- **Who/what can resolve:** developer.
- **Human question?** no
- **Proposed default:** One slug function in Kotlin (NFD + strip marks + `[^a-z0-9]+`→`_` + trim), with `_n` dedupe where the Creator does it.

### U-118 Category `slug` vs path leaf are inconsistent by construction
- **What is unclear:** The model comment and ADR 0010 say `slug` is the leaf segment, but seeded slugs are the full path with underscores (`food_cooking_supermarket` for leaf `supermarket`), and the model accepts any slug that differs from the leaf (`ensure_path_ends_with_slug` only fills a blank slug, `app/models/category.rb:135-140`). User-created categories get `slug` = name-derived and `path = parent + "." + slug` (`app/services/categories/creator.rb:19-22`). A slug containing `-` (allowed by the slug format) makes the path invalid ("must be lowercase letters, digits, underscores, dot-separated").
- **Evidence for / against:** `spec/models/category_spec.rb:76` [V] (an explicit slug is left alone).
- **Who/what can resolve:** product owner / developer.
- **Human question?** no
- **Proposed default:** Replicate: slug and path are independent keys, and both are unique per user. Do not derive one from the other except on create.

### U-119 BUG? Deleting a category that some user has hidden raises a FK error
- **What is unclear:** `Category` declares no association to `user_hidden_categories`, and the FK is NO ACTION (`db/schema.rb:397`). `in_use?` ignores hidden-category rows, so `DELETE /admin/categories/:id` (or the API) on an unused but hidden category hits `PG::ForeignKeyViolation`, which surfaces as a 500 [I].
- **Evidence for / against:** `app/models/category.rb:48-50,112-114`; `app/controllers/admin/categories_controller.rb:54-62` [I]. Not exercised in the oracle.
- **Who/what can resolve:** running the scenario; developer.
- **Human question?** no
- **Proposed default:** Delete the user_hidden_categories rows together with the category (nullify/destroy cascade).

### U-120 `preferred_hour` is documented as user-local but is evaluated in UTC
- **What is unclear:** The migration comment says "0..23 in the user's local timezone" (`db/migrate/20260502170613_create_sync_schedules.rb:13-15`), but `User` has no `timezone` attribute, so `ScheduleUpserter`/`Dispatcher` always pass `"UTC"` (`app/services/auto_sync/schedule_upserter.rb:134-136`, `app/services/auto_sync/dispatcher.rb:94-96`). A Polish user choosing 8 gets 08:00 UTC (09:00/10:00 Warsaw).
- **Evidence for / against:** `spec/services/auto_sync/next_run_calculator_spec.rb:67` verifies zone handling only when a zone is passed [V]. The users table has no timezone column [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Keep UTC for parity. Add a per-user timezone later if requested.

### U-121 BUG? `versions` has no tenant column and is exposed to every tenant
- **What is unclear:** The audit table has no user/tenant column, and `/admin/versions` and `/admin/versions/:id` read `PaperTrail::Version` unscoped (`app/controllers/admin/versions_controller.rb:6,10`). Versions contain other tenants' manual transactions, credential metadata and account data.
- **Evidence for / against:** [oracle](../../oracle/http/GET_admin_versions.json) case `other_tenant_sees_all_versions` → 200; [oracle](../../oracle/http/GET_admin_versions__id.json) case `other_tenant_reads_main_version` → 200 [V].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-fix; the fix shapes the Kotlin audit schema)
- **Proposed default:** Add `owner_user_id` to the Kotlin audit table (resolved from the item at write time), filter the reads by it, and backfill it during migration by joining through each item type.

### U-122 Inconsistent documentation of `noise.unmatched.other` kind
- **What is unclear:** `Llm::EnrichmentRunner#resolve_category_for` says unknown LLM paths fall back to `noise.unmatched.other` "(kind=ignored) - keeps the merchant … invisible to spend totals" (`app/services/llm/enrichment_runner.rb:186-191`), but the seed defines `noise.unmatched.*` as `kind: "expense"`, deliberately counted in spend (`app/services/seeders/categories.rb:182-190`). LLM merchants with an unknown category path therefore **do** count as spend.
- **Evidence for / against:** Code reading [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Follow the seed (expense), which is the current runtime behaviour.

### U-123 First-run setup is not atomic
- **What is unclear:** `SetupController#create` saves the user, then runs both seeders outside a transaction (`app/controllers/setup_controller.rb:17-21`). If a seeder raises, the user exists without a taxonomy and `/setup` is closed (it redirects once a user exists). Recovery is via `POST /admin/onboarding/seed_taxonomy`.
- **Evidence for / against:** Code reading [I]; `spec/requests/public_spec.rb:29` covers the happy path only [V].
- **Who/what can resolve:** developer.
- **Human question?** no
- **Proposed default:** Run user creation and seeding in one transaction in Kotlin.
