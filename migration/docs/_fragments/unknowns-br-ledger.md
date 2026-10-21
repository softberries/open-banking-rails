### U-400 BUG? ATM top-up category lookup never matches the seeded taxonomy
- **What is unclear:** `Cash::AtmWithdrawalLinker` sets the top-up's enrichment category to `user.categories.find_by(slug: "cash_atm_topup")`, with the comment "we want it consistent immediately". The seeded taxonomy derives slugs from paths (`path.tr(".", "_")`), and the ATM category is `money.transfers.atm` → slug `money_transfers_atm`. No category has slug `cash_atm_topup`, so new top-ups get `category = NULL` (unmatched) until an enrichment **rebuild** runs (source `system_fallback` is rebuildable; fallback `[credit, cash_atm_topup] → money.transfers.atm`). Between link and rebuild the top-up credit is unmatched (not spend/income either way, but it is shown "unclassified").
- **Evidence for / against:** `app/services/cash/atm_withdrawal_linker.rb:44-50`; `app/services/seeders/categories.rb:146,175-180`; `app/services/enrichment/transaction_enricher.rb:39,81-99`. The spec `spec/services/cash/atm_withdrawal_linker_spec.rb:30` compares with the same failing lookup (NULL == NULL), so it passes vacuously. Oracle top-ups show category 101 `money.transfers.atm` only because `Seeders::Showcase` calls `TransactionEnricher.rebuild!` (`app/services/seeders/showcase.rb:281`) — [../oracle/http/GET_api__version_cash_transactions.json](../oracle/http/GET_api__version_cash_transactions.json).
- **Who/what can resolve:** original author / product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** fix in Kotlin: assign the category with path `money.transfers.atm` at link time.

### U-401 BUG? ATM top-ups keep counterparty_kind "unknown" instead of "self"
- **What is unclear:** `Banking::CounterpartyResolver` classifies `cash_atm_topup` as `self`, but the linker never calls it, so linked top-ups keep the DB default `unknown`. Filters such as `LedgerEntry.to_self` miss them.
- **Evidence for / against:** `app/services/banking/counterparty_resolver.rb:10-24`; `app/services/cash/atm_withdrawal_linker.rb:29-43`; oracle [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) case `manual` → `"payment_method": "cash_atm_topup", "counterparty_kind": "unknown"`. The rake task `banking.rake` backfill would correct it (`lib/tasks/banking.rake:4-20`) [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** set `self` at link time.

### U-402 BUG? Analytics `from > to` returns 500 (API and admin)
- **What is unclear:** `Analytics::Period` raises `ArgumentError "from must be <= to"`; nothing maps it to 400. Admin HTML has the same path, and additionally an unparseable admin date silently becomes "today", which can produce `from > to` (e.g. `from=garbage&to=2026-01-01`).
- **Evidence for / against:** `app/services/analytics/period.rb:19`; `app/services/analytics/filter.rb:176-206`; oracle [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) case `from_after_to` → 500 `{"message": "ArgumentError: from must be <= to"}` (confirms the investigator's finding). Admin variant not captured [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** API → 400 `{"message":"Invalid parameters.","details":["from must be <= to"]}`; admin → swap or fall back to month-to-date.

### U-403 BUG? `PATCH /api/v1/cash_transactions/:id` clears omitted fields
- **What is unclear:** The API passes only supplied params (`declared(..., include_missing: false)`) to `TransactionUpdater`, whose contract is "blank title/note/counterparty_name/transaction_date/merchant/category means clear". A PATCH with only `{"amount":"30"}` therefore wipes title, note, counterparty, transaction_date, merchant and category (and sets `category_overridden=false`).
- **Evidence for / against:** `lib/api/resources/cash_transactions.rb:92-97`; `app/services/cash/transaction_updater.rb:9-12,58-83`. Oracle PATCH samples only touched rows whose other fields were already NULL, so not observed [I].
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** in the API treat absent keys as "keep", explicit `null`/`""` as "clear"; keep admin form behaviour.

### U-404 BUG? Cash wallet is created even when the cash entry fails
- **What is unclear:** `TransactionCreator` resolves (find-or-create) the wallet before the DB transaction that saves the row; a failed entry (bad amount, or an unknown currency such as `XYZ` that fails the ISO inclusion validation) leaves a new wallet behind (e.g. "Cash wallet (XYZ)"), which then appears in wallet lists, currency options and `all_bank_account_ids`.
- **Evidence for / against:** `app/services/cash/transaction_creator.rb:60-64`; `app/services/cash/wallet_resolver.rb:21-30` (no currency validation on BankAccount, `app/models/bank_account.rb:66-69`). Not exercised in the oracle [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** validate currency first and create the wallet inside the same transaction.

### U-405 "Today" is the UTC date, not the user's local date
- **What is unclear:** No `config.time_zone` → UTC. Month-to-date, presets, default booking date of cash entries and the run-rate all use the UTC date; for Polish users the date flips 1–2 hours late. The seeder deliberately uses `Europe/Warsaw`, and auto-sync schedules carry their own zone, suggesting local time matters.
- **Evidence for / against:** `config/application.rb:32-46`; `app/services/seeders/showcase.rb:52`; `app/services/auto_sync/next_run_calculator.rb:23`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep UTC for parity; make the zone a single configuration point in Kotlin.

### U-406 Refunds are neither netted against spend nor counted as income when classified as expense
- **What is unclear:** `spend` requires debit + expense kind; `income` requires credit + income kind. A credit whose effective category is an expense category (e.g. merchant default "Supermarkets") disappears from all analytics. Card refunds are routed to `income.refunds.refunds` only by the unmatched fallback; a refund from a known merchant inherits the merchant's expense category.
- **Evidence for / against:** `app/models/ledger_entry.rb:72-76`; `spec/models/ledger_entry_spec.rb:132` (explicitly excludes refunds); `app/services/enrichment/transaction_enricher.rb:36`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (business meaning)
- **Proposed default:** keep (spec-asserted behaviour).

### U-407 Uncategorised manual cash expenses never count as spend
- **What is unclear:** Manual rows always get a `manual` enrichment, which the auto-enricher never overwrites; without a picked category (or a merchant with a default category) the row stays unmatched and is excluded from spend — the showcase's six cash expenses are "unclassified" and invisible in the dashboard totals. Fallback `[debit, cash] → noise.unmatched.cash` exists but is never applied to manual rows.
- **Evidence for / against:** `app/services/cash/transaction_creator.rb:91-98`; `app/services/enrichment/transaction_enricher.rb:28,98`; [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) ("Parking meter unclassified Manual").
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep for parity; consider requiring a category in the cash form.

### U-408 AI insight card (ADR 0008) is documented but not implemented
- **What is unclear:** ADR 0008 specifies `Analytics::AiInsight` (facts-only narration, numeric guard, notable movers `|delta_pct| ≥ 100 % AND ≥ 200 PLN`). No code, view or route exists; ADR 0012 still lists "AI insight" as an LLM consumer.
- **Evidence for / against:** `docs/adr/0008-ai-insight-architecture.md`; `docs/adr/0012-per-user-llm-credentials.md:4`; `grep -ri insight app lib` → none; `spec/system/daily_login_analytics_spec.rb:64`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (scope)
- **Proposed default:** out of scope for the Kotlin parity rebuild.

### U-409 Top movers ignore categories whose spend dropped to zero; thresholds are currency-agnostic
- **What is unclear:** Movers are computed from the current-period breakdown only, so a category that went from 500 to 0 never appears as a "down" mover. Thresholds are a fixed 5000 minor units (50.00) regardless of currency (EUR 50 vs PLN 50).
- **Evidence for / against:** `app/services/analytics/top_movers.rb:16-33`; `app/services/analytics/spend_breakdown.rb:22-32`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep for parity.

### U-410 ATM linking ignores the bank transaction status
- **What is unclear:** A pending BLIK ATM debit is linked immediately and the top-up is created as `booked`. If the pending bank row is later dropped/cancelled by the bank, the top-up stays (no unlink logic exists). Analytics exclude the pending bank row but include the booked top-up only if categorised (transfer → no effect on spend), but the wallet balance is inflated.
- **Evidence for / against:** `app/services/cash/atm_withdrawal_linker.rb:60-63` (no status check), `:34`; no unlink code found.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep for parity; document.

### U-411 Hidden-category privacy is UI-only
- **What is unclear:** The admin UI redirects/masks hidden categories, but `/api/v1/analytics/categories/:slug`, `/merchants/:slug`, `/spend`, `/top_merchants` and `/api/v1/transactions` return hidden data unmasked. Is the hidden list a presentation preference or a privacy boundary?
- **Evidence for / against:** `app/controllers/admin/analytics/categories_controller.rb:10-14` vs `lib/api/resources/analytics/categories.rb:18-56`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** keep UI-only (PAT holder is the same user).

### U-412 Misleading "awaiting classification" empty state
- **What is unclear:** When the leaf category chart is empty, the dashboard shows "<N> transactions awaiting classification" counting **all** booked debits in scope, including classified transfers (e.g. ATM withdrawals). In the oracle MTD view the only debit was a classified ATM transfer, yet the page said "1 transactions awaiting classification" (also wrong plural).
- **Evidence for / against:** `app/views/admin/analytics/dashboard/index.html.erb:380-393`; [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** count only unmatched debits (as the banner does) and pluralize.

### U-413 `/api/v1/analytics/spend` total differs from cash-flow spend when `depth` is used
- **What is unclear:** With `depth = d`, rows on categories shallower than `d` are dropped, and `total_cents` is the sum of returned rows, so it under-reports spend. Observed: depth=2 total 229241 vs cash-flow spend 231240 for the same range.
- **Evidence for / against:** `app/services/analytics/spend_breakdown.rb:86-93`; `lib/api/resources/analytics/spend.rb:32`; [../oracle/http/GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json) vs [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `explicit_range`.
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (intent)
- **Proposed default:** keep for parity; document that `total_cents` is the sum of rows. `depth=0` or negative values are unvalidated (behaviour unknown).

### U-414 Admin bank-transaction `category_id` filter matches explicit overrides only
- **What is unclear:** `?category_id=` filters `transaction_enrichments.category_id`, i.e. only rows with an explicit category override, not rows categorised via the merchant default. The API ledger filter uses `effective_category_id` instead.
- **Evidence for / against:** `app/controllers/admin/bank_transactions_controller.rb:13` vs `lib/api/resources/transactions.rb:34`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug-to-keep-or-fix)
- **Proposed default:** keep for parity.

### U-415 Minor-unit assumptions: charts divide by 100; amount input rejects thousands separators
- **What is unclear:** Chart values use `cents / 100.0` for every currency (wrong for 0- or 3-decimal currencies such as JPY/KWD, which money parsing would store correctly). Amount input replaces every `,` with `.`, so `1,234.56` and `1 234,56` are rejected as invalid.
- **Evidence for / against:** `app/views/admin/analytics/dashboard/index.html.erb:47,99-101`; `app/services/cash/transaction_creator.rb:27-29`.
- **Who/what can resolve:** product owner.
- **Human question?** no (parity default is clear)
- **Proposed default:** keep for parity; the Kotlin implementation should derive the divisor from the currency exponent if multi-decimal currencies are ever supported.

### U-416 Unvalidated inputs that likely produce 500
- **What is unclear:** Admin cash index `from`/`to` are interpolated as SQL parameters against a DATE column without parsing (an invalid string likely raises a Postgres error → 500); `/api/v1/analytics/top_merchants?limit=-1` passes a negative LIMIT; `/api/v1/transactions?category_path=` with an invalid ltree likely errors.
- **Evidence for / against:** `app/controllers/admin/cash_transactions_controller.rb:14-15`; `lib/api/resources/analytics/top_merchants.rb:16,20-22`; `lib/api/resources/transactions.rb:35`. None exercised by oracle/specs [I].
- **Who/what can resolve:** running these requests against the oracle server.
- **Human question?** no
- **Proposed default:** Kotlin validates and returns 400 / ignores bad filters; record as an intentional deviation.

### U-417 Enabling cash tracking always creates a PLN wallet
- **What is unclear:** `Cash::Tracking.enable!` is called without a currency, so a user whose accounts are all EUR still gets an empty PLN wallet; linked EUR ATM withdrawals create an EUR wallet on demand. The flash always says "Created a PLN wallet…" even if it already existed.
- **Evidence for / against:** `app/controllers/admin/settings/preferences_controller.rb:38-41`; `app/services/cash/tracking.rb:9-19`; `docs/adr/0006-cash-tracking-opt-in.md` ("auto-creates a PLN wallet").
- **Who/what can resolve:** product owner.
- **Human question?** no (ADR states PLN explicitly)
- **Proposed default:** keep for parity.
