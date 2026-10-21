### U-300 BUG? Category tree helpers are not scoped to the user (cross-tenant leakage)
- **What is unclear:** `Category#descendants`, `#children`, `#ancestors`, `#parent`, `#self_and_descendants` and therefore `#breadcrumb_names` and `#in_use?` query the whole `categories` table without `user_id`. With two tenants holding the same paths:
  - every breadcrumb lists each ancestor once per tenant, and shows the *other* tenant's names if they were renamed;
  - `in_use?` refuses to delete a category when another tenant has a descendant under the same path;
  - `parent` can return another tenant's row.
- **Evidence for / against:** `app/models/category.rb:83-119`. Oracle: [merchant show](../oracle/ui/admin_merchants_show.html) renders `Jedzenie / Jedzenie / W domu / W domu / Supermarkety`; [merchants index](../oracle/ui/admin_merchants_index.html) and [bank transactions index](../oracle/ui/admin_bank_transactions_index.html) show the same pattern. The server log SQL `SELECT 1 … FROM "categories" WHERE (path <@ 'food.oracle_ui_category' AND path != …)` has no `user_id` predicate (`../oracle/server.log.txt` ~16565). In contrast, `Categories::Mover#rewrite_descendant_paths` *is* scoped (`spec/services/categories/mover_spec.rb:61`).
- **Who/what can resolve:** product owner (confirm it is a bug).
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** fix in Kotlin. Every tree query is filtered by `user_id`. Breadcrumbs then show each ancestor once.

### U-301 BUG? Creating a category from the admin form with an empty Slug field
- **What is unclear:** `Categories::Creator` uses `category.slug ||= generate_slug(name)`. The admin form always submits `category[slug]`, so an empty field arrives as `""`, which is not nil. Generation is skipped and the path becomes `"<parent>."` or `""`.
  - With a parent, the model back-fills slug = parent's last label. Validation then fails with `Slug has already been taken` and `Path must be lowercase letters, digits, underscores, dot-separated`.
  - At root it fails with `Slug can't be blank` etc.

  This would make "New category" in the UI unusable unless a slug is typed. The oracle and the specs only created categories without the `slug` key (API, MCP, synthetic POST).
- **Evidence for / against:** `app/services/categories/creator.rb:21-22`; `app/views/admin/categories/_form.html.erb:21-25` (slug field, no JS fill); `app/models/category.rb:135-140`. [oracle](../oracle/http/POST_admin_categories.json) `default` case has no slug key → 302 (works). No spec submits the real form for "new".
- **Who/what can resolve:** run a Playwright submit of `/admin/categories/new` with an empty slug field; product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** treat a blank slug as "generate" (fix).

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

### U-303 BUG? Deleting an unused but hidden category would violate a foreign key
- **What is unclear:** `Category#in_use?` ignores `user_hidden_categories`, and `Category` declares no `has_many :user_hidden_categories, dependent: …`. Deleting a category that is otherwise unused but hidden by the user would raise `ActiveRecord::InvalidForeignKey`, giving a 500.
- **Evidence for / against:** `app/models/category.rb:49-50,112-114`; `app/models/user_hidden_category.rb:19-22` (FK `category_id → categories.id`); `app/controllers/admin/categories_controller.rb:54-62`. Not exercised by the oracle or specs.
- **Who/what can resolve:** run the scenario; product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** delete the hidden-category rows together with the category (cascade).

### U-304 BUG? Merchant edit page ignores the hidden-category guard
- **What is unclear:** `Admin::MerchantsController` defines `edit` twice. The first version redirects with `This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it.`. The second, empty definition (line 58) overrides it, so `/admin/merchants/:id/edit` renders for merchants in hidden categories and exposes name and notes. The show page *is* guarded.
- **Evidence for / against:** `app/controllers/admin/merchants_controller.rb:37-42,58-59`; `spec/requests/categorization_spec.rb:231` covers only show. Not observed in the oracle (the edited merchant was not hidden).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** apply the guard on edit as clearly intended.

### U-305 Slug generation does not transliterate Polish/accented letters in three of four places
- **What is unclear:** `Merchant#generate_slug` NFD-normalizes first (`Żabka` → `zabka`). `Categories::Creator`, `Merchants::Creator` and `Llm::EnrichmentRunner#slugify` do not:
  - `Żabka` → `abka`, `Mobilność` → `mobilno`, `Łódź Kebab` → `d_kebab`;
  - an all-Cyrillic name gives an empty base. For categories this means a validation error; for merchants it means the model fallback `merchant_<hex>`.

  Because the LLM runner reuses an existing merchant by slug, the non-NFD slug also determines merchant identity for LLM suggestions.
- **Evidence for / against:** `app/models/merchant.rb:86`; `app/services/categories/creator.rb:40-44`; `app/services/merchants/creator.rb:36`; `app/services/llm/enrichment_runner.rb:180`. Reproduced with pure Ruby expression evaluation. `spec/models/merchant_spec.rb:43` covers only the model path.
- **Who/what can resolve:** product owner (slugs are user-visible in URLs and exports).
- **Human question?** yes (migration choice: byte-identical slugs vs fixed transliteration)
- **Proposed default:** reproduce the exact current algorithms for parity, because existing slugs are persisted. Optionally fix for new records only.

### U-306 BUG? LLM suggestions overwrite existing system/user merchants (incl. default category)
- **What is unclear:** `EnrichmentRunner#upsert_merchant` finds an existing merchant by slug and overwrites `name`, `kind`, `confidence`, `model` and `default_category`, even for below-threshold (pending) suggestions. Only `source` is preserved. If the LLM names a merchant whose slug equals a seeded or user merchant, e.g. "Biedronka" for an unmatched title variant, that merchant's default category can be changed silently. This retroactively re-categorizes all of its transactions and contradicts ADR 0005 ("LLM never silently overrides a user decision").
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:148-163`; `docs/adr/0005-llm-confidence-gating.md:20-21`. Mitigation: groups matched by any existing rule are not sent (`app/services/llm/enrichable_query.rb:29-41`). Not covered by specs.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** in Kotlin, only fill attributes that are empty on an existing non-LLM merchant, and never change its `default_category`.

### U-307 BUG? Some LLM failures abort the whole run instead of a batch or item
- **What is unclear:** Two failure paths escape the per-batch and per-item handling. In both cases the job marks the run failed with `<Class>: <message>` and re-raises:
  - **Invalid regex.** An LLM-proposed `rule_kind = regex` with an invalid pattern raises `RegexpError` while probing the sample (`MerchantRule#matches?` → `compiled_regex`). Only `ActiveRecord::RecordInvalid` (per item) and `Llm::Client::Error` (per batch) are rescued.
  - **Client resolution.** It happens outside the batch `begin/rescue`, so `Llm::Client::NotConfiguredError` (the key was removed after queueing) also aborts.
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:41-73,115-119`; `app/models/merchant_rule.rb:79,87-89`; `app/jobs/llm_enrichment_job.rb:48-50`. Not exercised.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** treat an invalid LLM pattern as "skipped", and treat not-configured as a clean failed run.

### U-308 BUG? "All transactions for this merchant" assignment is not sticky
- **What is unclear:** Mode `all_for_merchant` sets `source = user_rule`, `category_overridden = false` and does not attach a rule. The row is rebuildable, so the next `rebuild!` re-runs matching. If no rule matches that transaction's fields, the merchant is replaced by the fallback or `unmatched`, and the user's choice disappears. The mode also leaves the previous `merchant_rule_id`, `confidence` and `model` on the row.
- **Evidence for / against:** `app/services/enrichment/classification_applier.rb:68-79`; `app/services/enrichment/transaction_enricher.rb:96-124`; `spec/services/enrichment/classification_applier_spec.rb:46` asserts only the immediate state.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep current semantics for parity, but flag in UI tests. Alternative: write `source = manual` with `category_overridden = false`.

### U-309 BUG? Classification request without `enrichment[mode]` returns 500
- **What is unclear:** `ClassificationApplier::Input#normalized_mode` calls `mode.to_sym`. A nil mode (parameter omitted) raises `NoMethodError`, which is not rescued and gives a 500. An empty string yields `Unknown propagation mode: ` instead.
- **Evidence for / against:** `app/services/enrichment/classification_applier.rb:15,35-36`; `app/controllers/admin/transaction_enrichments_controller.rb:7-13`. The oracle always sent a mode.
- **Who/what can resolve:** run `PATCH /admin/bank_transactions/:id/enrichment` with no mode.
- **Human question?** no
- **Proposed default:** treat a missing mode as unknown and redirect with alert `Unknown propagation mode: `.

### U-310 Archived merchants keep matching transactions
- **What is unclear:** Archiving a merchant does not disable its rules. The enricher loads all enabled rules regardless of `merchants.archived_at`, so archived merchants keep being assigned on sync and rebuild. Is "archive" meant only to hide the merchant from pickers and lists?
- **Evidence for / against:** `app/controllers/admin/merchants_controller.rb:83-86`; `app/services/enrichment/transaction_enricher.rb:135-138`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (business meaning)
- **Proposed default:** keep (parity). Document in the UI.

### U-311 Own-account merchant default category is `money.transfers`, not `money.transfers.own`
- **What is unclear:** `OwnAccountMerchantSyncer::OWN_TRANSFER_CATEGORY_SLUG = "money_transfers"` resolves to path `money.transfers` ("Przelewy", an intermediate node). Everything else that means "own transfer" uses `money.transfers.own` (fallback table, top-up merchant). Is the intermediate node intended?
- **Evidence for / against:** `app/services/enrichment/own_account_merchant_syncer.rb:13,55`; `app/services/enrichment/transaction_enricher.rb:25-26,47`; `app/services/seeders/merchant_rules.rb:109`.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (business meaning)
- **Proposed default:** keep `money.transfers` for parity (same kind `transfer`, so totals are unaffected).

### U-312 Privacy statements about LLM payload are inaccurate
- **What is unclear:** Three statements do not match the code:
  - The AI Enrichment page says "Only the normalized `title` and `counterparty_name` are sent - no amounts, IBANs, or dates.", and `config/initializers/ruby_llm.rb` says "only normalized titles + counterparty names". The prompt actually sends the **raw** title (`title_raw`), the normalized title, the counterparty name and the user's category path list. Amounts, IBANs and dates are indeed not sent.
  - The page also says requests go "to OpenAI" and that "Each batch is a single OpenAI call" regardless of the configured provider (Gemini in the oracle).
- **Evidence for / against:** `app/views/admin/llm_enrichments/index.html.erb:42,89`; `app/views/admin/llm_enrichments/_run_progress.html.erb:45`; `app/services/llm/merchant_suggester.rb:194-205`; [runs](../oracle/operation_runs_after_capture.jsonl) ids 10-11 (raw titles in `request`); [UI](../oracle/ui/admin_llm_enrichments_index.html).
- **Who/what can resolve:** product owner / privacy owner.
- **Human question?** yes (scope/privacy wording)
- **Proposed default:** keep the payload (needed for pattern matching on the raw title) and correct the copy to name the configured provider and "raw + normalized title".

### U-313 No timeout on user-defined regex rules (ReDoS)
- **What is unclear:** Regex rules are compiled with no `Regexp.timeout`, and `config/` sets none. A catastrophic pattern entered by a user, or proposed by the LLM, can stall enrichment, rebuilds and the LLM grouping. Java/Kotlin regex semantics also differ from Ruby Onigmo, e.g. possessive/atomic syntax and `\h`.
- **Evidence for / against:** `app/models/merchant_rule.rb:79,87-96`; `grep Regexp.timeout` → no hits.
- **Who/what can resolve:** architecture owner.
- **Human question?** yes (migration choice)
- **Proposed default:** in Kotlin, compile with a timeout or a safe engine (e.g. RE2/J). Validate on save. Document which Ruby-only constructs are rejected.

### U-314 ADR-described features absent at this commit (AI insight, recurrence facet)
- **What is unclear:**
  - ADR 0008 (facts-only AI insight card with numeric guard) has no implementation: no `AiInsight` code or view.
  - ADR 0010's Layer 2 (`recurring`, `recurrence_interval` on `TransactionEnrichment`) does not exist in the schema; `ledger_entries_v04.sql` comments say recurrence was moved out.
  - ADR 0012 mentions the "AI insight" consumer of LLM credentials.
- **Evidence for / against:** `docs/adr/0008-ai-insight-architecture.md`; `docs/adr/0010-three-layer-category-model.md:23-25`; `inventory/schema.rb`; `inventory/views_sql/ledger_entries_v04.sql:9-11`; `grep -r AiInsight` → none.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** out of scope for the rebuild (port behaviour, not ADR intent).

### U-315 Re-running the seeders overwrites user edits
- **What is unclear:** Both seeders run from first-run setup, `POST /admin/onboarding/seed_taxonomy` and the showcase.
  - `Seeders::Categories` re-assigns `name`, `kind`, `color`, `icon`, `essential`, `path` and `position` on every seeded slug. A user's renames, kind or essential edits and moves are reverted, and descendant paths are not rewritten when a moved seeded category is reset.
  - `Seeders::MerchantRules` re-enables seeded rules and resets `case_sensitive = false` and the merchants' default categories.
- **Evidence for / against:** `app/services/seeders/categories.rb:175-191`; `app/services/seeders/merchant_rules.rb:51-130`; `spec/services/seeders/categories_spec.rb:18` ("re-applies attribute changes").
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep for parity (it is the documented "escape hatch"). Warn in the UI.

### U-316 Title normalizer behaviour differs from its own documentation
- **What is unclear:** The class comments claim:
  - `RZESZOWJMP S.A. BIEDRONKA 7645PL` → `JMP S.A. BIEDRONKA`, but the actual output is `JMP S A BIEDRONKA`;
  - `RzeszoweLeclercPL` → `LECLERC`, but the actual output is `ELECLERC`.

  City prefixes are matched without a word boundary (`POZNANSKA 12` → `SKA`). `KRAKOW` is listed twice. Grouping keys and LLM hints depend on the exact output.
- **Evidence for / against:** `app/services/enrichment/title_normalizer.rb:4-7,14-19,40-50`; pure-Ruby evaluation of the file (table in BR-264); `spec/services/enrichment/title_normalizer_spec.rb:6-26`.
- **Who/what can resolve:** original author.
- **Human question?** no (parity default is clear)
- **Proposed default:** port the exact algorithm, with golden tests from BR-264's table.

### U-317 LLM group limit has no server-side bounds
- **What is unclear:** The form restricts `limit` to 1..200. `LlmEnrichments::Queuer` and the job accept any integer:
  - `0` or negative → `first(0)` → an empty, succeeded run;
  - a huge value → unbounded token spend.

  The API rejects only non-integers (400).
- **Evidence for / against:** `app/services/llm_enrichments/queuer.rb:8-12`; `app/views/admin/llm_enrichments/index.html.erb:93-95`; `app/jobs/llm_enrichment_job.rb:30`; [oracle](../oracle/http/POST_api__version_llm_enrichments.json) `invalid_limit` → 400.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** validate 1..200 server-side (422).

### U-318 Connection test bypasses the client factory; key reuse across providers
- **What is unclear:**
  - **Factory bypass.** `Llm::ConnectionTestRunner` builds its client with `setting.build_client` directly instead of `Llm::Client.for`. In the oracle this bypassed the injected fake and made a real OpenAI request.
  - **Key reuse.** Saving preferences with a blank key keeps the old key even when the provider changes. The oracle switched gemini → openai and sent the Gemini key to OpenAI.
  - **Unrescued errors.** Only `Llm::Client::Error` is rescued. Any other exception leaves the `llm_connection_test` run in `running` and returns a 500.
- **Evidence for / against:** `app/services/llm/connection_test_runner.rb:27-49`; `app/controllers/admin/settings/preferences_controller.rb:60`; [runs](../oracle/operation_runs_after_capture.jsonl) id 14 (`Incorrect API key provided: fake-gem***-key`); investigator finding in the brief.
- **Who/what can resolve:** product owner / original author.
- **Human question?** yes (bug-to-keep-or-fix: should a provider change require a new key?)
- **Proposed default:** in Kotlin, route through the factory. Require a new key when the provider changes. Fail the run on any exception.

### U-319 LLM prompt references category targets that do not exist
- **What is unclear:** The Polish system prompt tells the model to pick `"uncategorized"` when unsure and gives `gifts_donations` as the default for charities. Neither is a seeded path (the seeded one is `lifestyle.giving.donations`). Unknown paths silently become `noise.unmatched.other`.
- **Evidence for / against:** `app/services/llm/merchant_suggester.rb:117,137`; `app/services/llm/enrichment_runner.rb:188-194`; `app/services/seeders/categories.rb:100-102`.
- **Who/what can resolve:** original author (prompt owner).
- **Human question?** yes (keep the prompt verbatim or fix it)
- **Proposed default:** keep the prompt byte-identical for parity of model behaviour. Note it as a follow-up.

### U-320 `hidden_category_ids` accepts category ids of other tenants
- **What is unclear:** `PATCH /admin/settings/preferences/app` assigns `user.hidden_category_ids = [...]`. Rails' collection `ids_writer` looks ids up with `Category.where(id: ids)`, not with the user's categories. A foreign id therefore creates a `user_hidden_categories` row pointing at another tenant's category, which has no visible effect because `hidden_subtree_ids` filters by the user's own categories. A non-existent id raises `RecordNotFound` → 404.
- **Evidence for / against:** `app/controllers/admin/settings/preferences_controller.rb:107-114`; `bundle/ruby/3.4.0/gems/activerecord-8.1.3/lib/active_record/associations/collection_association.rb:62-81`; `app/models/user.rb:56-65`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** in Kotlin, accept only ids of the user's own categories and ignore or 422 the others.

### U-321 Re-proposed LLM rule can be re-disabled after user approval
- **What is unclear:** `upsert_rule` sets `enabled = confident?` on every upsert of the same (field, kind, pattern). A rule enabled by `Merchants::Approver` would be disabled again if a later run proposes the same pattern with a confidence below 0.85. This is rare, because groups matched by existing rules are not re-sent, but possible via a different group yielding the same pattern.
- **Evidence for / against:** `app/services/llm/enrichment_runner.rb:165-177`; `app/services/merchants/approver.rb:17-19`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** never disable a rule that has `approved_at` or was enabled by a user.

### U-322 "All batches failed" message for item-level failures
- **What is unclear:** `LlmEnrichmentJob` marks a run `failed` with `All batches failed. First: <error>` whenever there are errors and no auto or pending outcomes. This also happens when the only errors are item-level validation errors and every other item was skipped, so the batches themselves succeeded.
- **Evidence for / against:** `app/jobs/llm_enrichment_job.rb:41-47`; `spec/system/llm_enrichment_spec.rb:67`, `:91` (cover only the clear cases).
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** keep the status rule and the exact message for parity.

### U-323 Own-account merchant identity: 8-char uid prefix and shared IBANs
- **What is unclear:**
  - The merchant slug uses only the first 8 characters of the bank account uid, so two accounts whose uids share a prefix would share one merchant.
  - Multi-currency pockets sharing one IBAN (Revolut EUR/USD in the showcase) create two merchants with identical iban rules at priority 200. The match goes to the lower rule id, which is effectively arbitrary.
  - The known unscoped `find_existing_account` takeover bug can also move the merchant's account to another tenant.
- **Evidence for / against:** `app/services/enrichment/own_account_merchant_syncer.rb:70-72,82-100`; `app/services/seeders/showcase.rb:195-196`; investigator finding in the brief (`CreateConnection#find_existing_account`).
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** key the own-account merchant on the full account id in Kotlin, while keeping the slug format for display and parity.
