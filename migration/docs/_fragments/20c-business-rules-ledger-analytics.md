## Part C — Cash, ledger, analytics, money, time, presentation rules

Scope: the unified ledger read model (`LedgerEntry` view), analytics aggregation (`app/services/analytics/*`), cash
bookkeeping (`app/services/cash/*`, `ManualTransaction`, cash wallets, `User#track_cash`), money storage/formatting,
time zone and period logic, pagination, Ransack and the formatting/privacy helpers in `app/helpers/admin/*`.
All source paths are relative to the source checkout (`src/`). Oracle links are relative to `docs/`.
Oracle "today" was **2026-10-21** (UTC); tenant "main" is the Showcase seed.

Conventions used below:
- "cents" = integer minor units (`bigint`) of the ISO-4217 currency stored in the sibling `currency` column.
- "round()" = Ruby `Float#round` = round half **away from zero** to the stated number of digits.
- Spec references point to `inventory/specs.json` entries; the full suite passed (825 examples, 0 failures, `inventory/specs_run.json`), so a cited spec means **[V]** for what it asserts.

---

### Ledger read model

### BR-300 Unified ledger: one row per bank or manual transaction
**Rule.** Analytics and the `/api/v1/transactions` list read one relation, `ledger_entries` (Postgres VIEW, current
version v04), which is `UNION ALL` of two branches: every `bank_transactions` row (`source_type = 'BankTransaction'`)
and every `manual_transactions` row (`source_type = 'ManualTransaction'`). Natural key = (`source_type`, `source_id`);
`source_id` alone is not unique. Projected columns: `source_type, source_id, bank_account_id, amount_cents, currency,
direction, signed_amount_cents, status, booking_date, transaction_date, payment_method, title, counterparty_name,
counterparty_kind, enrichment_id, merchant_id, effective_category_id, category_path, essential, enrichment_source`.
Not projected: notes, raw payloads, IBANs, external ids. The relation is read-only (any update/save/destroy raises).
Version history (for context): v01 base projection; v02 added `category_path`, `essential`, `recurring`,
`recurrence_interval`; v03 added `counterparty_kind`; v04 dropped `recurring`/`recurrence_interval`.
Kotlin: implement as a DB view or an equivalent query; there is no materialisation and no cache — always fresh.
**Evidence.** `db/views/ledger_entries_v04.sql:13-77`; `db/views/ledger_entries_v01.sql:1-26` (invariants);
`db/views/ledger_entries_v02.sql:1-20`; `db/views/ledger_entries_v03.sql:1-14`; `app/models/ledger_entry.rb:33-41`;
`docs/adr/0003-postgres-view-for-analytics.md`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:31` exists as a database view; `:57` exactly one ledger row per source row (no leaks, no duplicates); `:35` sum-integrity invariant for mixed bank + manual rows; `:196` raises ReadOnlyRecord on update/save/destroy; `:243` round-trips source_record.
**Oracle.** [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) cases `default` (BankTransaction/1) and `manual` (ManualTransaction/1) → 200, entity shape incl. `category_path`.

### BR-301 Amount and sign conventions
**Rule.** `amount_cents` is always a **positive magnitude** on both source tables (bank amounts are stored as the
absolute value; manual amounts must be > 0). Direction is the separate field `direction ∈ {credit, debit}`.
`signed_amount_cents = +amount_cents` when `direction = 'credit'`, otherwise `-amount_cents` (any non-credit value is
treated as debit). API entities expose `amount {cents, currency}` (positive) and `signed_amount {cents, currency}`.
**Evidence.** `db/views/ledger_entries_v04.sql:20-23,54-57`; `app/services/enable_banking/transaction_normalizer.rb:106`
(`.abs`); `app/models/manual_transaction.rb:64` (`greater_than: 0`), `:103-105` (`signed_amount`);
`lib/api/entities/ledger_entry.rb:8-13`; `lib/api/entities/money.rb:5-14`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:74` signed_amount_cents positive for credits, negative for debits regardless of source; `spec/models/manual_transaction_spec.rb:90` positive Money for credits and negation for debits; `spec/models/manual_transaction_spec.rb:46` rejects zero/negative amount_cents.
**Oracle.** [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) case `default` → `amount.cents 2550`, `signed_amount.cents -2550` (debit); case `currency_eur_lowercase` → `101 / 101` (credit).

### BR-302 Effective category resolution
**Rule.** For each ledger row: `effective_category_id = enrichment.category_id` if set (explicit override), else the
enrichment merchant's `default_category_id`, else NULL. `category_path` = ltree path of that effective category (NULL
when unmatched); `essential` = that category's `essential`, **false** when unmatched. `merchant_id`,
`enrichment_source` come from the enrichment (NULL when the row has no enrichment). Changing a category's `kind` or
`essential` re-classifies all rows immediately (no re-enrichment needed). Archived categories are still joined (no
filter on `archived_at`) [I].
**Evidence.** `db/views/ledger_entries_v04.sql:31-36,37-43`; `app/models/concerns/ledger_entry_concern.rb:18-21` (same
rule on the write side).
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:92` override wins over merchant default; `:107` falls back to merchant default; `:121` NULL when neither; `:209` mirrors category_path; `:285` re-categorizes on the fly when a Category's kind changes; `spec/models/concerns/ledger_entry_concern_spec.rb:89` concern agrees with the view across override / merchant-default / unmatched.
**Oracle.** [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json) case `default` → unmatched rows show `effective_category_id: null, category_path: "", essential: false`.

### BR-303 Kind partitioning: spend, income, transfers, savings, ignored, unmatched
**Rule.** Category kinds are `expense | income | transfer | savings | ignored`. Partitions over ledger rows:
- **spend** = `direction = 'debit'` AND effective category kind = `expense`.
- **income** = `direction = 'credit'` AND effective category kind = `income`.
- **transfers** = kind `transfer` (any direction); **savings** = kind `savings` (any direction).
- **ignored** = kind `ignored` — appears in no analytics aggregate.
- **unmatched** = `effective_category_id IS NULL` — appears in no aggregate except the unmatched banner (BR-324).
Consequences: a **credit on an expense category (e.g. a refund) is in neither spend nor income** — it is not netted
against spend; a debit on an income category is in neither. Transfers, savings and ignored never enter cash flow,
spend, net, or savings rate. A BLIK ATM withdrawal is a transfer (category `money.transfers.atm`, kind `transfer`) and
never counts as spend (see U-406).
**Evidence.** `app/models/category.rb:39`; `app/models/ledger_entry.rb:72-78`; `app/services/analytics/cash_flow.rb:4-5`;
`app/services/seeders/categories.rb:146`; `docs/adr/0006-cash-tracking-opt-in.md` (Consequences).
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:132` spend narrows to debits on expense categories, excluding refunds, transfers, and unmatched rows; `:157` income narrows to credits on income categories; `spec/services/analytics/cash_flow_spec.rb:42` excludes transfers from spend and income.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) case `default`: October has a 200.00 PLN BLIK ATM debit (transfer) but `spend_cents: 0`.

### BR-304 Booked-only analytics; pending visible only in lists
**Rule.** Every analytics aggregate (dashboard, drilldowns, `/api/v1/analytics/*`) uses only `status = 'booked'` rows
(rationale: pending rows would double count once they settle). The ledger list `GET /api/v1/transactions` returns
**both** booked and pending unless `status=booked|pending` is passed.
**Evidence.** `app/services/analytics/filter.rb:68-74,76-82,113-121`; `app/services/analytics/spend_breakdown.rb:72-76`;
`lib/api/resources/transactions.rb:27-31`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:273` keeps pending rows visible in all but excludes them from booked.
**Oracle.** n/a (showcase data is all booked).

### BR-305 Single-currency aggregation and currency selection
**Rule.** Analytics never sums across currencies and never converts (no FX). Each request picks exactly one currency:
1. If param `currency` is present, upper-cased, and is one of the user's **available currencies** (distinct
   `currency` values among ledger rows on the user's owned accounts, any status, all time) → that currency (explicit).
2. Otherwise → **dominant currency** = the currency with the most ledger rows (count, any status, all time) on the
   user's owned accounts; ties broken by the database (unspecified order) [I]; if the user has no rows → `"PLN"`.
An unknown/unused currency param (e.g. `USD` with no USD rows) is silently ignored → dominant currency.
All aggregate scopes add `currency = <selected>`. The selected currency is echoed in every analytics API response as
`currency`. Raw `LedgerEntry` sums *can* mix currencies (literal cents addition) — only the Filter prevents it.
**Evidence.** `app/services/analytics/filter.rb:50-66,166-174`; `docs/adr/0003-postgres-view-for-analytics.md`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:52` picks dominant currency by ledger count and respects an explicit known currency override (bogus USD → PLN); `spec/requests/api/v1/analytics_spec.rb:117` honors a currency override that exists in the user's data; `spec/models/ledger_entry_spec.rb:302` raw sums add cents across currencies without conversion; `:313` per-currency grouping.
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) currency chips "EUR", "PLN" only (a USD account exists but has no rows); [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `default` → `"currency": "PLN"`.

### BR-306 Account scoping and the explicit-empty state
**Rule.** Owned accounts = synced accounts under the user's TPP credentials **plus** the user's cash wallets
(`manual_owner_id = user`). Analytics account set:
- `accounts=none` → empty set (every aggregate is 0; "explicit zero state").
- else `account_ids[]` → each value cast to integer, zeros dropped, **intersected with owned ids** (foreign ids silently
  dropped); if the intersection is empty → all owned accounts (default).
- `all_accounts?` = not `none` and no valid explicit ids.
`AccountBreakdown` intersects again with owned ids (defence in depth). Cash-wallet rows therefore participate in
analytics like any account (if categorised, see BR-345).
**Evidence.** `app/services/analytics/filter.rb:13-36`; `app/models/user.rb:74-78`; `app/services/analytics/account_breakdown.rb:15-18`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:26` defaults to full owned list and rejects forged ids; `:37` accounts=none is the explicit zero state, distinct from all_accounts?; `spec/requests/analytics_spec.rb:43` totals ignore another user's data.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) account chips link to `account_ids[]=…` lists (all owned minus the clicked one).

### BR-307 Category subtree filter (`under_path` / `category_path`)
**Rule.** A path filter keeps rows whose `category_path` is equal to or a descendant of the given ltree path
(`category_path <@ path`). Several paths are OR-ed. An empty list yields **no rows** (never widens). Analytics:
`under_path` param narrows both current and previous scopes; drill depth `aggregation_depth = 1` without
`under_path`, else `(number of dots in under_path) + 2`. If `under_path` matches no category of the user the page still
renders (drill chip absent). API `/api/v1/transactions?category_path=` uses the same subtree semantics.
**Evidence.** `app/models/ledger_entry.rb:62-67`; `app/services/analytics/filter.rb:73,81,134-145`;
`app/controllers/admin/analytics/dashboard_controller.rb:54`; `lib/api/resources/transactions.rb:35`.
**Status.** [V]
**Covered by.** `spec/models/ledger_entry_spec.rb:222` filters under_path to subtree containment, none for empty input; `spec/requests/analytics_spec.rb:24` under_path resolves @drill_category; `:34` unknown under_path still renders.
**Oracle.** n/a.

---

### Time and periods

### BR-310 Time zone and "today"
**Rule.** No `config.time_zone` is configured, so the application zone is **UTC**. "Today" everywhere in this part
is `Date.current` = the current **UTC** calendar date (e.g. 2026-10-21 00:30 Europe/Warsaw is still 2026-10-20).
Ledger dates (`booking_date`, `transaction_date`) are SQL `DATE` (no time component, no conversion). All period
bounds are **inclusive** on both ends (`booking_date BETWEEN from AND to`). Week start is **Monday** (Rails default
`beginning_of_week`, Postgres `DATE_TRUNC('week')` also Monday). Only the showcase seeder uses Europe/Warsaw explicitly.
Whether UTC is intended is open (see U-405).
**Evidence.** `config/application.rb:32-46` (no `time_zone`); `app/models/ledger_entry.rb:57`; `app/services/analytics/period.rb:42-44,49`;
`app/services/seeders/showcase.rb:52`.
**Status.** [V] for Monday weeks and inclusive bounds (oracle); [I] for UTC (no oracle run straddling midnight).
**Covered by.** `spec/services/analytics/period_spec.rb:25` week buckets start at beginning_of_week.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `default` → `period.to = "2026-10-21"`; dashboard week labels start "13 Jul" (2026-07-13 is a Monday) in [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html).

### BR-311 Default period and date-param handling
**Rule.** Analytics period:
- Only when **both** `from` and `to` are present are they used; otherwise (none or just one) the period is
  **month-to-date**: `from = first day of the current month`, `to = today` (BR-310).
- Admin (HTML) params are parsed leniently; an unparseable date becomes **today** (no error).
- API params are typed `Date`; an invalid date → **400** `{"message":"Invalid parameters.","details":["from is invalid"]}`
  (wording per Grape, e.g. for `/api/v1/transactions`).
- `from > to` raises `ArgumentError("from must be <= to")` → **HTTP 500** in the API (JSON
  `{"message":"ArgumentError: from must be <= to"}`) and, by the same code path, in the admin dashboard [I] (see U-402).
- `length_days = (to − from) + 1` (inclusive).
**Evidence.** `app/services/analytics/filter.rb:176-190,202-206`; `app/services/analytics/period.rb:17-24`;
`lib/api/resources/analytics/cash_flow.rb:10-17`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:15` defaults to month-to-date; `spec/services/analytics/period_spec.rb:6` rejects from > to with ArgumentError; `:11` length_days inclusive; `spec/requests/api/v1/analytics_spec.rb:129` rejects an invalid date with 400.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `default` → period 2026-10-01..2026-10-21; `from_after_to` → 500 `{"message": "ArgumentError: from must be <= to"}`; [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json) `invalid_params` → 400 `["from is invalid", "direction does not have a valid value"]`.

### BR-312 Bucket granularity selection
**Rule.** Buckets are `day | week | month`. If param `bucket` is one of these it is used ("explicit"); any other value
is ignored in the admin UI (auto), while the API validates it → 400 `{"message":"Invalid parameters.","details":["bucket does not have a valid value"]}`.
Auto bucket by `days = length_days`: `1..31 → day`, `32..180 → week`, otherwise `month`.
**Evidence.** `app/services/analytics/filter.rb:42-48,193-200`; `lib/api/resources/analytics/cash_flow.rb:13`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:69` smart bucket default ≤31d day, ≤180d week, else month.
**Oracle.** [../oracle/http/GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json) 101-day range → `"bucket": "week"`; [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `invalid_bucket` (`bucket=year`) → 400.

### BR-313 Bucket boundaries and gap filling
**Rule.** Series bucket keys:
- `day`: every date from `from` to `to` inclusive.
- `week`: Mondays, starting at the Monday on/before `from`, stepping 7 days while `≤ to`.
- `month`: first-of-month dates, starting at the first of `from`'s month, stepping one month while `≤ to`.
The first week/month bucket key may lie **before** `from`, but only rows inside `[from, to]` are summed into it
(partial first/last buckets). Rows are grouped by `DATE_TRUNC(<bucket>, booking_date)::date`. Missing buckets are
filled with 0 (gap-fill in application code).
**Evidence.** `app/services/analytics/period.rb:30-66`; `app/services/analytics/cash_flow.rb:16-23,35-39`.
**Status.** [V]
**Covered by.** `spec/services/analytics/period_spec.rb:19` one date per day; `:25` week/month stepping; `:34` fill maps a sparse series onto every bucket; `spec/services/analytics/cash_flow_spec.rb:55` one Point per bucket gap-filled with zero.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `explicit_range` (`from=2026-07-13&to=2026-10-21&bucket=month`) → series dates `2026-07-01, 2026-08-01, 2026-09-01, 2026-10-01` (July bucket 0).

### BR-314 Comparison ("previous") period and its label
**Rule.** Previous range for deltas:
1. **Full calendar month** (`from` = 1st of a month and `to` = last day of that month): previous = the whole previous
   calendar month. Label: `"vs <Mon YYYY>"` of the previous month (e.g. `vs Sep 2026`).
2. Else **month-to-date** (`from` = 1st of current month and `to` = today): `prev_from` = 1st of previous month,
   `prev_to = min(prev_from + (length_days − 1), last day of previous month)`. Label: `"vs <Mon> <d1>–<d2>"` with an
   en dash (e.g. `vs Sep 1–21`).
3. Else: same-length window immediately before: `[from − length_days, from − 1]`. Label: `"vs previous <N> days"`.
Rule 1 is checked first (so the last day of a month counts as a full month). The previous scope uses the same
accounts, currency, booked filter and `under_path`.
**Evidence.** `app/services/analytics/filter.rb:76-132`; `app/services/analytics/period.rb:26-28`.
**Status.** [V]
**Covered by.** `spec/services/analytics/period_spec.rb:11` previous is the same-length window ending the day before from.
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) (MTD 1–21 Oct) → "less than Sep 1–21"; [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) (101 days) → "biggest swings · vs previous 101 days".

### BR-315 Period presets (dashboard filter strip)
**Rule.** Month presets (relative to today T): **This month** = 1st of T's month..T; **Last month** = previous calendar
month; **Last 3M / 6M / 12M** = 1st of the month 3/6/12 months before T .. last day of the previous month (complete
months only). Day presets **Today, 3d, 7d, 14d, 30d, 60d, 90d, 180d, 365d**: `from = T − (N − 1)`, `to = T`. Preset
links drop `bucket` (auto re-applies) and keep accounts/currency/under_path. A day preset is highlighted when
`length_days = N` and no month preset is active.
**Evidence.** `app/views/admin/analytics/shared/_filter_strip.html.erb:5-55,99-124`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) links: Last month `from=2026-09-01&to=2026-09-30`, Last 3M `2026-07-01..2026-09-30`, Last 12M `2025-10-01..2026-09-30`, 3d `2026-10-19..2026-10-21`, 365d `2025-10-22..2026-10-21`.

### BR-316 Filter state in URLs
**Rule.** Links between analytics views carry: `from`, `to` (ISO dates, always), `bucket` only if explicit,
`currency` only if explicit and valid, `under_path` if set, and either `accounts=none` (zero state) or
`account_ids[]` (explicit narrowing) or neither (default all accounts). Toggling an account chip: from the default
state removes that account (all others explicit); if the resulting set equals all owned accounts, no account param is
emitted; if empty, `accounts=none`. "Reset" removes the account params.
**Evidence.** `app/services/analytics/filter.rb:147-162`; `app/views/admin/analytics/shared/_filter_strip.html.erb:56-84,187-195`.
**Status.** [V]
**Covered by.** `spec/services/analytics/filter_spec.rb:81` to_query_params omits accounts and bucket when at default state.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) links `?bucket=week&from=…`, `?currency=EUR&from=…`, `?account_ids[]=5&account_ids[]=4…`.

---

### Totals and KPIs

### BR-320 Cash-flow totals, net and series
**Rule.** Over the filtered scope (BR-304..BR-307, BR-311):
`spend_cents = Σ amount_cents of spend rows`; `income_cents = Σ amount_cents of income rows`;
`net_cents = income_cents − spend_cents` (may be negative). Series: per bucket (BR-313) the same three numbers.
API `GET /api/v1/analytics/cash_flow` returns `{currency, period:{from,to,bucket}, totals:{spend_cents,income_cents,net_cents}, series:[{date,spend_cents,income_cents,net_cents}]}`.
A series point is "quiet" when spend and income are both 0; if all points are quiet the dashboard shows "All quiet" /
"No transaction in the selected period changed the balance.". "Biggest <bucket>" = point with max `|net_cents|`.
**Evidence.** `app/services/analytics/cash_flow.rb:7-33`; `lib/api/resources/analytics/cash_flow.rb:18-34`;
`app/views/admin/analytics/dashboard/index.html.erb:494-516`.
**Status.** [V]
**Covered by.** `spec/services/analytics/cash_flow_spec.rb:28` totals split spend and income, net = income − spend; `spec/requests/api/v1/analytics_spec.rb:6` returns totals + a date-bucketed series.
**Oracle.** [../oracle/http/GET_api__version_analytics_cash_flow.json](../oracle/http/GET_api__version_analytics_cash_flow.json) `explicit_range` → totals `231240 / 1950000 / 1718760`; dashboard range "Net flow +zł17,187.60", "Biggest week +zł6,286.50 · 3 Aug".

### BR-321 Spend change percentage
**Rule.** `prev_spend = spend_cents` of the previous range (BR-314). If `prev_spend = 0` → no value (card shows "-",
hint "no prior period to compare"). Else `spend_delta_pct = round((spend − prev_spend) / prev_spend × 100)` (integer).
Display `+N%` when positive, `N%` otherwise; hint `more than <label>` / `less than <label>` / `same as <label>` where
`<label>` is the previous label without the leading `vs `.
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:12-17,80-83`; `app/views/admin/analytics/dashboard/index.html.erb:316-341`.
**Status.** [V]
**Covered by.** untested (only render 200 in `spec/requests/analytics_spec.rb:6`).
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) → "-100% Spend change less than Sep 1–21" (spend 0 vs >0); [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "- Spend change no prior period to compare".

### BR-322 Savings rate
**Rule.** If `income_cents = 0` → no value ("-", hint "no income in period"). Else
`savings_rate_pct = round((income − spend) / income × 100)` (integer, may be negative). Hint "of income kept" when ≥ 0,
"spent more than earned" when < 0.
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:18,85-88`; `app/views/admin/analytics/dashboard/index.html.erb:343-357`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "88% Savings rate of income kept" ((1950000−231240)/1950000 = 88.14 %); MTD page → "100%".

### BR-323 Average daily spend and month-end run-rate
**Rule.** `avg_daily_spend_cents = spend_cents div length_days` (integer division, truncation).
Run-rate only when the period is month-to-date (BR-314 case 2) **and** `days_elapsed = length_days ≥ 3`:
`run_rate_cents = round(spend_cents × days_in_current_month / days_elapsed)`. When run-rate exists the card
"Run-rate" replaces "Avg daily spend". In MTD, `prev_full_month_spend_cents` = spend of the whole previous calendar
month (same accounts/currency/under_path); hint `vs <amount> last month` (else "projected end of month").
Tone: `run_rate_delta_pct = round((run_rate − prev_full) / prev_full × 100)` only if `prev_full > 0`;
`> 5` → destructive, `< −5` → success, otherwise/none → info. Avg card hint: `per day · <N> account(s)`.
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:20-34`; `app/services/analytics/filter.rb:113-121`;
`app/views/admin/analytics/dashboard/index.html.erb:290-314`.
**Status.** [V]
**Covered by.** `spec/requests/analytics_spec.rb:15` computes month-to-date run rate when ≥ 3 days elapsed (asserts 200 only).
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) → "zł0 Run-rate vs zł1,309.95 last month" (Sep spend 130995 matches cash_flow Sep bucket); [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "zł22.89 Avg daily spend per day · 6 accounts" (231240 div 101 = 2289).

### BR-324 Unmatched-debit warning
**Rule.** `unmatched = booked debits in scope with effective_category_id IS NULL`. If `count > 0` show banner
`"<N> transaction(s) awaiting classification"` (Rails pluralize) with description
`"<amount>[ · <P>% of detected spend] - these don't appear in totals below until classified."`, action "Classify now"
→ AI enrichment page. `P = round(unmatched_cents / (spend_cents + unmatched_cents) × 100)`; the "· P%" fragment only
when `P > 0`. Separately, when the leaf category chart is empty: no active categories → "Taxonomy not set up"; else if
**any** booked debit in scope exists (including classified transfers) → `"<N> transactions awaiting classification"` /
"Raw debits exist in the period but none have been mapped to a category yet. Run AI enrichment or classify them
manually."; else "No spend" / "No spending in the selected period/accounts." (see U-412).
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:65-75`; `app/views/admin/analytics/dashboard/index.html.erb:259-275,376-401` (banner from line 261).
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "2 transactions awaiting classification zł37 · 2% of detected spend - these don't appear in totals below until classified." (3700/(231240+3700) = 1.6 % → 2); [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html) → "1 transactions awaiting classification" empty state while the only debit is a classified ATM transfer.

### BR-325 Spend breakdown by category
**Rule.** Over **spend** rows with non-NULL `category_path`:
- `depth = nil` (leaf mode): one row per distinct full `category_path`.
- `depth = d`: rows with `nlevel(category_path) ≥ d`, grouped by the first `d` labels (`subpath(path,0,d)`); rows on
  shallower categories are **dropped** (so the total can be less than cash-flow spend, see U-413).
Row = `{path, name, amount_cents = Σ, count, prev_amount_cents, delta_pct}`; sorted by amount desc. `name` = the
user's category with that exact path, else the last path label with `_`→space, title-cased. `slug` = path with `.`→`_`.
With a previous scope: `prev_amount_cents` = same grouping over the previous range (0 if absent). Rows that exist
**only** in the previous range are not returned. `delta_pct = round((amount − prev) / prev × 100)` or null if prev is
0/nil. Dashboard: leaf chart (depth nil) and domain chart (`depth = aggregation_depth`, BR-307).
API `GET /api/v1/analytics/spend` (params from,to,bucket,currency,account_ids,under_path,depth) →
`{currency, period:{from,to,bucket}, total_cents = Σ rows.amount_cents, rows:[{path,slug,name,amount_cents,prev_amount_cents,count,delta_pct}]}`.
**Evidence.** `app/services/analytics/spend_breakdown.rb:5-32,84-106`; `lib/api/resources/analytics/spend.rb:19-45`;
`app/controllers/admin/analytics/dashboard_controller.rb:37-52`.
**Status.** [V]
**Covered by.** `spec/requests/api/v1/analytics_spec.rb:20` returns category-grouped rows with previous-period delta fields.
**Oracle.** [../oracle/http/GET_api__version_analytics_spend.json](../oracle/http/GET_api__version_analytics_spend.json) `depth=2` → `total_cents 229241` vs cash-flow spend 231240 for the same range (difference 1999 = one row categorised directly on `food`, visible as "Jedzenie 19.99" in the leaf chart of [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html)); `prev_amount_cents: 0, delta_pct: null`.

### BR-326 Top movers
**Rule.** Input = leaf breakdown with previous amounts (BR-325). For each row: `delta = current − prev`; keep only if
`|delta| ≥ 5000` cents **and** `max(current, prev) ≥ 5000` cents (fixed 50.00 in any currency). Sort by `|delta|`
desc, take 5. `direction = up` if `delta ≥ 0` else `down`; `new_spend` = `prev = 0 and current > 0` (badge "new",
text "new this period"); otherwise show `±delta_pct%` and `"+<|delta|> vs prev"` / `"−<|delta|> vs prev"`. Card
subtitle `"biggest swings · <previous label>"`. Shown only if any mover. Categories whose spend fell to 0 cannot appear
(see U-409).
**Evidence.** `app/services/analytics/top_movers.rb:6-34`; `app/controllers/admin/analytics/dashboard_controller.rb:58`;
`app/views/admin/analytics/dashboard/index.html.erb:642-680`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → five movers all "new" (zł1,100 … zł62.50); "Drogerie" 44.95 and "Jedzenie" 19.99 excluded (< 50.00).

### BR-327 Top merchants
**Rule.** Spend rows with non-NULL `merchant_id`, grouped by merchant, `Σ amount_cents` desc, limited (dashboard 8,
API default 10, param `limit`), only merchants belonging to the user. Ties: database order [I]. API
`GET /api/v1/analytics/top_merchants` → `{currency, period:{from,to}, rows:[{merchant:{id,name,slug,default_category_id}, amount_cents, count}]}`.
No upper bound on `limit` [I].
**Evidence.** `app/services/analytics/top_merchants.rb:9-24`; `lib/api/resources/analytics/top_merchants.rb:9-40`;
`app/controllers/admin/analytics/dashboard_controller.rb:43`.
**Status.** [V]
**Covered by.** `spec/services/analytics/top_merchants_spec.rb:6` ordered by SUM desc limited; `:29` respects limit; `:46` Money wrapper; `spec/requests/api/v1/analytics_spec.rb:32` top spend merchants for the period.
**Oracle.** [../oracle/http/GET_api__version_analytics_top_merchants.json](../oracle/http/GET_api__version_analytics_top_merchants.json) `limit=5` → Decathlon 110000 (5) … McDonald's 6250 (5).

### BR-328 Account share of spend
**Rule.** Spend grouped by `bank_account_id`, `Σ desc`, owned accounts only; donut total = Σ rows; clicking an
account links to the dashboard with `account_ids[] = [that id]`. Empty → "No data" / "No spend on any of the
selected accounts.".
**Evidence.** `app/services/analytics/account_breakdown.rb:9-25`; `app/views/admin/analytics/dashboard/index.html.erb:146-153,518-528`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "Total zł2,312.40 1 account"; MTD page → "No data".

### BR-329 Essentials vs discretionary
**Rule.** Over spend rows: Essential = `essential = true`, Discretionary = `essential = false` (unmatched rows are not
spend, so not included). `total = ess + dis`; `share% = round(part / total × 100, 1)`, 0 when total = 0 (the two
shares are rounded independently and may not sum to 100.0). Card shown only when `spend_cents > 0`; subtitle
`"<left_share>% of spend covers needs"`; counts as `pluralize(n, "tx")`.
**Evidence.** `app/services/analytics/facet_breakdown.rb:9-24`; `app/views/admin/analytics/dashboard/index.html.erb:469-489`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) → "48.9% of spend covers needs Essential zł1,129.91 48.9% · 19 txes Discretionary zł1,182.49 51.1% · 11 txes".

### BR-330 Category drilldown
**Rule.** Category looked up by `slug` among the **user's** categories (unknown or other user's slug → 404).
Admin only: if the category (or an ancestor) is hidden → redirect to the dashboard (filter params kept) with alert
`"This category is private. Remove it from the hidden list in preferences to open it."`.
Merchants list = spend rows in the category **subtree** (BR-307) grouped by `merchant_id` (a NULL-merchant group is
included as `merchant: null`), Σ desc. `total_cents = Σ merchants` (= whole-subtree spend). Sub-category rows (only if
the category has descendants) = subtree spend grouped by the next level (`depth = dots + 2`); rows booked directly on
the category itself are excluded from the sub-category list. API `GET /api/v1/analytics/categories/:slug` →
`{category:{id,name,slug,path,kind}, currency, period:{from,to}, total_cents, merchants:[{merchant:{id,name,slug}|null, amount_cents, count}], subtree:[{path,slug,name,amount_cents,count}]}`.
The API applies **no** hidden-category gate (see U-411).
**Evidence.** `app/controllers/admin/analytics/categories_controller.rb:6-26`; `lib/api/resources/analytics/categories.rb:18-56`;
`app/services/analytics/spend_breakdown.rb:34-64`.
**Status.** [V]
**Covered by.** `spec/requests/analytics_spec.rb:55` 200 happy path; `:65` 404 unknown slug; `:74` 404 another user's category; `:85` redirects when hidden; `spec/requests/api/v1/analytics_spec.rb:64` category drilldown shape; `:44`, `:53` 404s; `spec/system/daily_login_analytics_spec.rb:48` drills into a category by slug.
**Oracle.** [../oracle/http/GET_api__version_analytics_categories__slug.json](../oracle/http/GET_api__version_analytics_categories__slug.json) `food` → `total_cents 38745` (merchants) while subtree rows sum to 36746 (the 1999 row on `food` itself is excluded from `subtree`); `unknown_slug` → 404 `{"message": "Couldn't find Category with [WHERE \"categories\".\"user_id\" = $1 AND \"categories\".\"slug\" = $2]"}`.

### BR-331 Merchant drilldown and 12-month trend
**Rule.** Merchant by `slug` among the user's merchants (else 404). Admin only: if the merchant's **default category**
is hidden → redirect with alert `"This merchant is in a hidden category. Remove it from the hidden list in preferences to open it."`.
Period figures: spend rows of that merchant in the filtered scope → `total_cents`, `count`, and a paginated list
ordered by `booking_date desc` (BR-367). **Monthly trend** ignores the selected period and accounts: always the last
12 calendar months including the current one (`from` = 1st of the month 11 months ago, `to` = today), all owned
accounts, selected currency, booked spend of that merchant, month buckets gap-filled with 0. API
`GET /api/v1/analytics/merchants/:slug` → `{merchant:{id,name,slug,default_category_id}, currency, period:{from,to}, total_cents, count, monthly_trend:[{period, amount_cents}], transactions:[LedgerEntry], pagination:{page,limit,count,pages}}`.
**Evidence.** `app/controllers/admin/analytics/merchants_controller.rb:6-39`; `app/services/analytics/spend_breakdown.rb:66-82`;
`lib/api/resources/analytics/merchants.rb:20-53`.
**Status.** [V]
**Covered by.** `spec/requests/analytics_spec.rb:97` zero totals for merchant without transactions; `:107` 404 unknown; `:116` 404 other user's; `:127` redirects when default category hidden; `spec/requests/api/v1/analytics_spec.rb:77`, `:86`, `:97`.
**Oracle.** [../oracle/http/GET_api__version_analytics_merchants__slug.json](../oracle/http/GET_api__version_analytics_merchants__slug.json) `biedronka` (range 07-13..10-21) → `total_cents 9995, count 5`, `monthly_trend` 2025-11-01 … 2026-10-01 (12 entries).

### BR-332 Dashboard lists and chart value conversion
**Rule.** Leaf category chart: first 20 rows, remaining rows collapsed into `"Other (<n>)"` with their summed amount.
Domain chart: first 10 rows; clicking narrows the dashboard via `under_path`. "Biggest transactions": top 5 spend rows by
`amount_cents desc` (ties in DB order). Chart values are `round(cents / 100.0, 2)` major units for **every** currency
(assumes 2-decimal currencies, see U-415). Date labels: day/week `"%-d %b"` (e.g. `13 Jul`), month `"%b %y"`.
Period hint: MTD `"<N> day(s) of <Mon>"`, else `"<N> day(s)"`.
**Evidence.** `app/views/admin/analytics/dashboard/index.html.erb:9-21,38-59,99-101,407-411`; `app/controllers/admin/analytics/dashboard_controller.rb:60-63`.
**Status.** [V]
**Covered by.** `spec/system/daily_login_analytics_spec.rb:16` renders the key stat cards; `:34` zero amounts for a brand-new user.
**Oracle.** [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) chart config `"data":[1100.0,780.0,225.0,79.96,62.5,44.95,19.99]`, labels `13 Jul, 20 Jul, …`; "Spend 21 days of Oct" on the MTD page.

### BR-333 Hidden categories in analytics
**Rule.** A category is hidden for a user if it or any ancestor is in the user's hidden list, unless the user has
`reveal_hidden_categories` on. Hidden rows are **still counted** in all totals; only labels are replaced with `•••`
and drill links removed (category bars, top merchants whose default category is hidden, top movers, cash and bank
transaction rows). Admin drilldowns redirect (BR-330, BR-331). No masking in the JSON API (see U-411).
**Evidence.** `app/models/user.rb:49-64`; `app/views/admin/analytics/dashboard/index.html.erb:42-51,184-190,648-650`;
`app/helpers/admin/hide_private_helper.rb:7-20`.
**Status.** [I] (no hidden expense category in the oracle data)
**Covered by.** `spec/requests/analytics_spec.rb:85`, `:127` (redirects only).
**Oracle.** n/a.

### BR-334 AI insight card (ADR 0008) is not implemented
**Rule.** ADR 0008 describes `Analytics::AiInsight` (facts struct: spend total, delta vs previous, top category/merchant
with delta, 0–2 notable movers with `|delta_pct| ≥ 100 % AND amount ≥ 200 PLN`; LLM writes 3 sentences; a guard
rejects any digit sequence not present in the facts; failures degrade to a muted callout). **No such class, view or
route exists** in the checked-out code; the dashboard renders no AI card. Kotlin must not implement it unless decided
(see U-408).
**Evidence.** `docs/adr/0008-ai-insight-architecture.md`; absence: `grep -ri insight app lib` → no matches.
**Status.** [V] (absence confirmed by search; oracle dashboard has no AI card)
**Covered by.** `spec/system/daily_login_analytics_spec.rb:64` renders the dashboard with no LlmSetting (no AI insight callout).
**Oracle.** [../oracle/ui/admin_analytics_dashboard.html](../oracle/ui/admin_analytics_dashboard.html).

---

### Cash bookkeeping

### BR-340 Cash tracking opt-in (`User#track_cash`)
**Rule.** `users.track_cash` boolean, default **false**. Manual cash entries can be created regardless of the flag;
the flag only gates **automatic ATM linking** (BR-349). When the App preferences update changes the flag from off to
on: (1) ensure a **PLN** wallet (always PLN, BR-341); (2) backfill: for every bank transaction of the user with
`payment_method = 'blik_atm'` and `direction = 'debit'`, run the linker; `linked` = number of newly created top-ups.
Flash: `"App settings saved. Created a PLN wallet and linked <N> historical ATM withdrawal(s)."` (the wallet sentence
appears even when the wallet already existed). Without the off→on transition: `"App settings saved."`. Turning the
flag off deletes nothing; only future links stop.
**Evidence.** `app/controllers/admin/settings/preferences_controller.rb:33-47`; `app/services/cash/tracking.rb:6-30`;
`docs/adr/0006-cash-tracking-opt-in.md`.
**Status.** [V] (service behaviour via specs); flash text [I] (oracle user already had the flag on).
**Covered by.** `spec/services/cash/tracking_spec.rb:6` backfills every eligible BLIK ATM debit and reports the count; `:21` second enable! reports 0; `:36` only blik_atm debits; `:52` creates the wallet but the linker no-ops when track_cash false; `:67` scoped to the requesting user; `spec/system/cash_with_atm_link_spec.rb:60` cash index renders without track_cash.
**Oracle.** [../oracle/http/PATCH_admin_settings_preferences_app.json](../oracle/http/PATCH_admin_settings_preferences_app.json) `default` → 302 to `/admin/settings/preferences/app`.

### BR-341 Cash wallet resolution (one wallet per user and currency)
**Rule.** A cash wallet is a `bank_accounts` row with `manual = true`, `manual_owner_id = user`, `tpp_credential_id = NULL`.
Lookup/creation key: `uid = "cash_<user_id>_<currency lower-case>"` (globally unique). If absent it is created with
`currency = <upper-case ISO>`, `cash_account_type = "CASH"`, `status = "active"`, `name = "Cash wallet (<ISO>)"`,
`all_account_ids = []`. Errors: no user → `ArgumentError "user required"`; blank currency → `"currency required"`.
Balances stay native per currency (no FX). The wallet is created **before** and outside the transaction that saves the
cash row, so it persists even if the row fails validation (see U-404).
**Evidence.** `app/services/cash/wallet_resolver.rb:4-41`; `app/models/bank_account.rb:54-57,134-138`; `app/services/cash/transaction_creator.rb:61-64`.
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:30` ' eur ' → EUR wallet uid `cash_<id>_eur`; `:79` two creates reuse the same wallet.
**Oracle.** [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `currency_eur_lowercase` → new wallet `bank_account_id 11`; [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) shows "Cash wallet (EUR)", "Cash wallet (PLN)".

### BR-342 Cash amount parsing and rounding
**Rule.** Input `amount` (string):
1. `to_string → trim → replace every "," with "."`.
2. Blank → create: `amount_cents = NULL` (validation error); update: **keep** the current amount.
3. Parse as exact decimal; any parse failure (letters, `"-"`, thousands separators such as `"1,234.56"` or
   `"1 234,56"`) → `amount_cents = NULL` → validation error.
4. `amount_cents = round(decimal × 10^exponent(currency), HALF_UP)` using the row currency (create: normalised input
   currency; update: the existing row currency — currency cannot change).
5. Negative or zero values parse but fail validation (`> 0`).
Rounding mode is money gem default `ROUND_HALF_UP` (money 7.0.2).
**Evidence.** `app/services/cash/transaction_creator.rb:26-32`; `app/services/cash/transaction_updater.rb:19-25`;
`bundle/.../money-7.0.2/lib/money/money.rb:235-237` (default rounding).
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:40` "12,34" → 1234 and blank → presence failure; `:89` junk amount → presence failure on amount_cents; `spec/services/cash/transaction_updater_spec.rb:49` "10,00" on EUR wallet → 1000; `:98` junk amount rolls back.
**Oracle.** [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `currency_eur_lowercase` (`amount "1.005"`, `currency "eur"`, `direction "credit"`) → 201, stored `amount.cents 101`, `currency "EUR"`, `signed_amount 101`, `booking_date "2026-10-21"` (today), `payment_method "cash"`, `counterparty_kind "unknown"`, `source "manual"`, enrichment `{source:"manual", category_id:null, category_overridden:false}`, new EUR wallet id 11 — i.e. 1.005 rounds **half-up** to 1.01; `invalid_amount` (`"12,3x"`) → 422 `{"message": "Amount cents is not a number, Amount is not a number, Amount cents can't be blank", "details": ["Amount cents is not a number", "Amount is not a number", "Amount cents can't be blank"]}`; [../oracle/http/PUT_admin_cash_transactions__id.json](../oracle/http/PUT_admin_cash_transactions__id.json) amount `"-"` → 422.

### BR-343 Cash create defaults and normalisation
**Rule.** `currency = trim(upper(input))`, blank → `"PLN"` (API param default is also `"PLN"`); `direction` blank →
`"debit"`; `payment_method` blank → `"cash"`; `booking_date` blank **or unparseable** → today (BR-310, silently);
`transaction_date` blank/unparseable → NULL; `title`, `note`, `counterparty_name` blank → NULL; `status = "booked"`;
`source = "manual"`; `created_by_user = current user`. API: `amount` required (missing → 400
`{"message":"Invalid parameters.","details":["amount is missing"]}`), `direction ∈ {credit, debit}`, dates typed.
Success: admin redirects to `/admin/cash_transactions` with notice `"Saved <expense|income> <formatted amount>."`
(`income` when credit) — e.g. `Saved expense zł25.00.` [I for exact rendering, BR-361]; API → 201 with the
ManualTransaction entity. Failure: admin re-renders the form with **422** and alert = messages joined by `", "` or
`"Could not save the transaction."`; API → 422 `{message, details[]}`.
**Evidence.** `app/services/cash/transaction_creator.rb:16-21,34-35,60-106`; `app/controllers/admin/cash_transactions_controller.rb:42-56,139-143`;
`lib/api/resources/cash_transactions.rb:35-59`.
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:11` persists in the PLN wallet with manual enrichment; `:54` defaults direction=debit, payment_method=cash, booking_date=today; `spec/requests/cash_spec.rb:96` expense notice; `:119` income notice; `:135` 422 re-render; `:150` falls back to a new record; `spec/requests/api/v1/transactions_spec.rb:84` 201; `:102` 422 with details.
**Oracle.** [../oracle/http/POST_admin_cash_transactions.json](../oracle/http/POST_admin_cash_transactions.json) `default` → 302 `/admin/cash_transactions`, `invalid_amount` → 422 form; [../oracle/http/POST_api__version_cash_transactions.json](../oracle/http/POST_api__version_cash_transactions.json) `default` → 201, `missing_amount` → 400.

### BR-344 ManualTransaction validation rules and messages
**Rule.** Required: `amount_cents`, `currency`, `booking_date`. `amount_cents > 0` (numeric). `currency` ∈ all ISO
codes known to the money library. `direction ∈ {credit, debit}`; `status ∈ {booked, pending}`; `payment_method ∈
{cash, cash_atm_topup, cash_deposit, cash_fx_conversion, cash_adjustment}` or NULL; `source ∈ {manual, atm_link,
csv_import, recurring}`; `counterparty_kind ∈ {self, external, unknown}`. Account must be a wallet: error on
`bank_account` `"must be a manual cash wallet"` (full: "Bank account must be a manual cash wallet"); currency must
equal wallet currency: `"must match wallet currency (<ISO>)"`. At most one manual row per linked bank transaction
(DB partial unique index on `linked_bank_transaction_id`). Every change is audited (paper trail).
**Evidence.** `app/models/manual_transaction.rb:46-72,113-122`; annotation `:28` (unique index).
**Status.** [V]
**Covered by.** `spec/models/manual_transaction_spec.rb:46` amount > 0; `:61` wallet error; `:72` currency_matches_wallet; `:122` RecordNotUnique on a second link; `:110` for_user scoping.
**Oracle.** see BR-342 (`Amount cents can't be blank` etc.).

### BR-345 Enrichment written for manual rows
**Rule.** Create and update always (re)write the row's enrichment with `source = "manual"`, `enriched_at = now`,
`merchant` = the user's **active** merchant with `merchant_id` (else NULL), `category` = the user's **active** category
with `category_id` (else NULL), and `category_overridden = true` **iff a category_id was supplied** — even when the id
was foreign/archived and dropped (documented quirk). Because the source is `manual`, the automatic enricher never
touches these rows: a cash row with neither category nor merchant (or a merchant without default category) stays
**unmatched** forever, so it is excluded from spend/income and only shows in the unmatched banner (debits) — see U-407.
**Evidence.** `app/services/cash/transaction_creator.rb:91-98,110-118`; `app/services/cash/transaction_updater.rb:76-84,96-104`;
`app/services/enrichment/transaction_enricher.rb:96-99`.
**Status.** [V]
**Covered by.** `spec/services/cash/transaction_creator_spec.rb:11`; `:67` drops another user's category_id but flips category_overridden; `spec/services/cash/transaction_updater_spec.rb:18` rewrites as manual with overridden=true; `:60` clearing category_id → overridden false, category NULL; `:73` foreign category quirk; `:85` builds a missing enrichment.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) seeded cash expenses show "unclassified Manual".

### BR-346 Counterparty kind on manual rows
**Rule.** On manual create/update: `payment_method ∈ {cash_atm_topup, cash_deposit, cash_fx_conversion, cash_adjustment}`
→ `self`; else `counterparty_name` blank → `unknown`; else upper-cased/trimmed name equal to one of the user's own
account holder names → `self`; else `external`. (IBAN is never available for manual rows.) The ATM linker does **not**
run this resolver, so linked top-ups keep the DB default `unknown` (see U-401).
**Evidence.** `app/services/banking/counterparty_resolver.rb:10-35`; `app/services/cash/transaction_creator.rb:80-85`;
`app/services/cash/transaction_updater.rb:67-72`; `app/services/cash/atm_withdrawal_linker.rb:29-43`.
**Status.** [V]
**Covered by.** untested for manual rows specifically.
**Oracle.** [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) `manual` → ATM top-up (`payment_method "cash_atm_topup"`) has `counterparty_kind "unknown"`.

### BR-347 Cash update semantics (keep vs clear, currency lock)
**Rule.** Fields and blank handling on update:
| Field | Blank/absent input means |
|---|---|
| amount | keep |
| direction | keep |
| payment_method | keep |
| booking_date | keep (also when unparseable) |
| transaction_date | **clear** (NULL) |
| title, note, counterparty_name | **clear** (stored as given, `""` or NULL) |
| merchant_id, category_id | **clear** (and `category_overridden = false`) |
| currency | not accepted (admin strips it; API has no param) — row keeps its wallet currency |
The API `PATCH /api/v1/cash_transactions/:id` passes only supplied params, so **omitted** title/note/counterparty_name/
transaction_date/merchant/category are cleared (see U-403). Admin success → redirect with `"Updated <expense|income> <amount>."`;
failure → 422 with alert or `"Could not update the transaction."`.
**Evidence.** `app/services/cash/transaction_updater.rb:4-12,53-92`; `app/controllers/admin/cash_transactions_controller.rb:69-82`;
`lib/api/resources/cash_transactions.rb:80-103`.
**Status.** [V] (specs); API omission clearing [I].
**Covered by.** `spec/services/cash/transaction_updater_spec.rb:33` blank title/counterparty clear, blank direction/booking_date keep; `:49` currency lock; `spec/requests/cash_spec.rb:188` drops :currency; `:210` 422 re-render; `spec/requests/api/v1/transactions_spec.rb:134` updates via TransactionUpdater.
**Oracle.** [../oracle/http/PATCH_api__version_cash_transactions__id.json](../oracle/http/PATCH_api__version_cash_transactions__id.json) `default` (`amount "30"`) → `amount.cents 3000`; `invalid_direction` → 400 `["direction does not have a valid value"]`; [../oracle/http/PATCH_admin_cash_transactions__id.json](../oracle/http/PATCH_admin_cash_transactions__id.json) → 302.

### BR-348 Which cash rows are editable
**Rule.** Lookup is always scoped to wallets owned by the current user (else 404). Only `source = "manual"` rows can be
edited/updated/deleted: admin → redirect to the index with alert `"This transaction was auto-generated and isn't editable here."`;
API PATCH/DELETE → 422 `{"message":"This transaction was auto-generated and isn't editable here."}`. Admin `show` always
redirects to `edit`. Admin `edit` of a row in a hidden category → redirect with alert
`"This transaction is in a hidden category. Remove it from the hidden list in preferences to edit it."` (update/delete
do not check this). Delete → `"Transaction deleted."` (admin) / 204 empty (API).
**Evidence.** `app/controllers/admin/cash_transactions_controller.rb:7-8,28-30,58-67,84-99`; `lib/api/resources/cash_transactions.rb:61-110`.
**Status.** [V]
**Covered by.** `spec/requests/cash_spec.rb:81` show → edit; `:163` editable row; `:173` ATM-link edit alert; `:225` PATCH non-manual; `:243` delete; `:255` delete non-manual keeps row; `spec/requests/api/v1/transactions_spec.rb:147` 422 for ATM-link; `:161` 204; `:114`, `:123` 404s.
**Oracle.** [../oracle/http/GET_admin_cash_transactions__id_edit.json](../oracle/http/GET_admin_cash_transactions__id_edit.json) (row 1 is an ATM link) → 302; [../oracle/http/GET_admin_cash_transactions__id.json](../oracle/http/GET_admin_cash_transactions__id.json) `other_tenant_id` → 404; [../oracle/http/DELETE_api__version_cash_transactions__id.json](../oracle/http/DELETE_api__version_cash_transactions__id.json) → 204 / other tenant 404.

### BR-349 ATM withdrawal ↔ cash wallet linking
**Rule.** For a bank transaction T, create a cash top-up iff all hold:
1. `T.payment_method = "blik_atm"` and `T.direction = "debit"` (BLIK ATM credits/refunds are never linked);
2. no manual row exists with `linked_bank_transaction_id = T.id`;
3. T's owner has `track_cash = true`.
There is **no fuzzy matching window**: pairing is 1:1 by identity of T (no amount/date matching against existing manual
rows). T's status is not checked (a pending ATM debit is linked too, see U-410). Created row (in the wallet for
`T.currency`, created if missing): `amount_cents = T.amount_cents`, `currency = T.currency`, `direction = "credit"`,
`status = "booked"`, `booking_date = T.booking_date`, `transaction_date = T.transaction_date`,
`title = "ATM withdrawal (<label>)"` where label = current bank connection's bank name, else the TPP credential name,
else `"Bank"`; `counterparty_name = T.counterparty_name`; `payment_method = "cash_atm_topup"`; `source = "atm_link"`;
`linked_bank_transaction_id = T.id`; plus an enrichment `source = "system_fallback"` with category = user's category
with slug `cash_atm_topup` — which does not exist in the seeded taxonomy, so the category is NULL until the next
enrichment rebuild assigns `money.transfers.atm` (see U-400). Concurrent duplicate → unique violation swallowed, returns
"nothing linked". The pair moves money between own accounts: the bank debit and the wallet credit are both kind
`transfer`, so neither is spend nor income.
**Evidence.** `app/services/cash/atm_withdrawal_linker.rb:4-74`; `app/services/seeders/categories.rb:146,175-180`;
`app/services/enrichment/transaction_enricher.rb:29,39,96-99`.
**Status.** [V]
**Covered by.** `spec/services/cash/atm_withdrawal_linker_spec.rb:14` creates linked credit, source atm_link, cash_atm_topup, matching cents/currency (its category assertion compares NULL with NULL); `:33` idempotent; `:44` ineligible method; `:54` credit not linkable; `:62` track_cash false; `:72` race swallowed; `spec/system/cash_with_atm_link_spec.rb:47` index lists the linked top-up.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) six rows "ATM withdrawal (PKO BP) … Atm link +200.00 PLN"; [../oracle/http/GET_api__version_cash_transactions.json](../oracle/http/GET_api__version_cash_transactions.json) → `linked_bank_transaction_id 36`, enrichment `system_fallback`, `category_id 101` (assigned later by the showcase rebuild).

### BR-350 When linking runs
**Rule.** Linking is attempted (each attempt idempotent per BR-349): (a) when `track_cash` is switched on (BR-340,
synchronous, all of the user's BLIK ATM debits); (b) after every transaction sync, after enrichment, if the subject
user has `track_cash` — scope: User subject → all their BLIK ATM debits; BankAccount → that account; BankConnection →
its current accounts; per-transaction failures are logged and skipped; if enrichment raised, linking is skipped for
that run; (c) rake `cash:backfill_atm_links` for every user with `track_cash = true` (prints per-user linked /
already-linked-or-noop counts).
**Evidence.** `app/jobs/transaction_sync_job.rb:55-90`; `lib/tasks/cash.rake:3-30`; `app/services/cash/tracking.rb:26-30`.
**Status.** [I] (sync path); [V] (enable path via specs).
**Covered by.** `spec/services/cash/tracking_spec.rb:6`.
**Oracle.** n/a.

### BR-351 Cash wallet balances (cash index)
**Rule.** Per wallet of the user (ordered by currency): `balance_cents = Σ amount_cents(credit) − Σ amount_cents(debit)`
over **all** manual rows of that wallet (all dates, booked and pending, every source). Shown in the wallet currency
(BR-361). Negative balance → warning "Negative balance - you've logged more expenses than top-ups. Likely missing a
cash income entry.". Not FX-converted, no cross-wallet total.
**Evidence.** `app/controllers/admin/cash_transactions_controller.rb:24-25,127-137`; `app/views/admin/cash_transactions/index.html.erb:22-43`.
**Status.** [V]
**Covered by.** untested (balances); `spec/system/cash_with_atm_link_spec.rb:16` updates the list after a 50 PLN expense.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) → "Cash wallet (PLN) zł1,125.00" (6 × 200.00 top-ups − 75.00 cash expenses) and "Cash wallet (EUR) €1.01".

### BR-352 Cash index filters and new-form defaults
**Rule.** Index scope = manual rows on the user's wallets; filters: `wallet_id` (exact), `direction`, `from`
(`booking_date ≥`), `to` (`booking_date ≤`), plus Ransack `q[...]` (BR-368); default sort `booking_date desc`;
paginated (BR-367). New form defaults: `direction = param or "debit"`, `currency` = currency of the user's oldest
wallet or `"PLN"`, `booking_date = today`, `payment_method = "cash"`. Currency options = `{"PLN"} ∪ wallet currencies ∪
synced account currencies`, upper-cased, unique, sorted. Merchant options: active merchants by name (max 500);
category options: active categories by position, name.
**Evidence.** `app/controllers/admin/cash_transactions_controller.rb:10-40,101-125`.
**Status.** [V]
**Covered by.** `spec/requests/cash_spec.rb:6` only own rows; `:20` wallet_id; `:35` direction; `:48` from/to; `:61` default debit/current date; `:71` `?direction=credit`.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) "Showing 1–10 of 13 results", dates descending; [../oracle/http/GET_admin_cash_transactions_new.json](../oracle/http/GET_admin_cash_transactions_new.json) `default` / `credit` → 200.

---

### Money, formatting, presentation

### BR-360 Money storage and default currency
**Rule.** Every money value is stored as `<name>_cents` (bigint, minor units) + ISO-4217 `currency` column (3 chars).
Default currency PLN (`MoneyRails default_currency = :pln`). Conversion from a decimal uses the currency's subunit
(`Money.from_amount`), so 0-decimal currencies would store whole units, but analytics charts always divide by 100
(BR-332, see U-415). No FX conversion anywhere.
**Evidence.** `config/initializers/money.rb:3-10`; `app/models/ledger_entry.rb:43-44`; `app/models/manual_transaction.rb:61`.
**Status.** [V]
**Covered by.** `spec/services/analytics/top_merchants_spec.rb:46` wraps amount_cents in Money.
**Oracle.** all API amounts are `{cents, currency}`, e.g. [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json).

### BR-361 Money display format
**Rule.** UI locale is `en`; money formatting uses Rails `en` number-currency settings: thousands separator `,`,
decimal mark `.`, symbol **before** the number with no space (`%u%n`), symbol from the currency (PLN `zł`, EUR `€`).
Variants used:
- default (`no_cents_if_whole = false` globally): `zł1,125.00`;
- analytics cards/charts (`no_cents_if_whole: true`): `zł6,500`, `zł22.89`;
- tables (`symbol: false`): number then the ISO code in a muted span: `220.00 PLN`;
- cash list signs: credit `+`, debit `−` (U+2212 MINUS SIGN), e.g. `+200.00 PLN`, `−20.00 PLN`;
- net/biggest figures prefix `+` when ≥ 0; negatives get the money library's `-` (e.g. `-zł100`) [I].
**Evidence.** `config/initializers/money.rb:7-9`; `bundle/.../money-7.0.2/lib/money/locale_backend/i18n.rb:8-25`;
`app/views/admin/cash_transactions/index.html.erb:35,198`; `app/views/admin/analytics/dashboard/index.html.erb:279,287,507,631`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) ("zł1,125.00", "€1.01", "+1.01 EUR", "−20.00 PLN"); [../oracle/ui/admin_analytics_dashboard_range.html](../oracle/ui/admin_analytics_dashboard_range.html) ("zł2,312.40", "zł19,500", "220.00 PLN").

### BR-362 Percentages
**Rule.** Integer percentages (spend change, savings rate, unmatched share, delta_pct, run-rate delta) use
round-half-away-from-zero of a floating-point ratio × 100; essentials shares use 1 decimal. Division by zero is avoided
by returning null/"-" (spend change, savings rate, delta_pct) or 0 (unmatched share, essentials).
**Evidence.** `app/controllers/admin/analytics/dashboard_controller.rb:74-88`; `app/services/analytics/spend_breakdown.rb:10-13`;
`app/services/analytics/facet_breakdown.rb:12-13`.
**Status.** [V]
**Covered by.** untested.
**Oracle.** see BR-322, BR-324, BR-329.

### BR-363 Privacy mode and sensitive-value kinds
**Rule.** Privacy mode is a cookie preference `privacy_mode = "1"`; when on, `<html>` gets class `privacy-mode`
server-side (no flash of unredacted content). Values wrapped as sensitive get classes `sensitive sensitive--<kind>`;
kinds: `blur` (default) — characters replaced by `•` client-side, text-shadow shield until masked; `mask` — same
bullet replacement (fixed-format values); `redact` — solid block over the text; `strong` — CSS-only text blur (large
JSON/certificates). Unknown kind → `blur`. Blank values are not wrapped (placeholders like "-" stay visible). No hover
reveal (all-or-nothing). A `sensitive:` component prop accepts `true` / a kind symbol / `{kind:, extra:}`.
**Evidence.** `app/helpers/admin/privacy_helper.rb:3-47`; `app/helpers/admin/preference_toggle_helper.rb:10-12`;
`app/views/layouts/admin.html.erb:2`; `app/assets/tailwind/application.css:110-162`.
**Status.** [V] (oracle UI capture); helper unit behaviour [I].
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_privacy_mask_toggled.png](../oracle/ui/admin_privacy_mask_toggled.png).

### BR-364 Server-side hiding of private category values
**Rule.** `hide_private_text(value, category)` returns the value unchanged unless the category is hidden for the user
(BR-333); blank stays blank; with `mask:` returns that fixed mask (used for amounts so digit count does not leak);
else `•` repeated `min(len(value), 24)` times. The original value is never sent to the browser.
**Evidence.** `app/helpers/admin/hide_private_helper.rb:5-20`.
**Status.** [I]
**Covered by.** untested.
**Oracle.** n/a.

### BR-365 Sortable column headers
**Rule.** `sort_link(label, column)`: the active sort is the first Ransack sort. If this column is active and ascending,
the link sorts descending; otherwise ascending. Other `q[...]` params are preserved; `q[s] = "<column> <dir>"`. Icon:
inactive `arrow_up_down` (dimmed), active asc `arrow_up`, active desc `arrow_down`.
**Evidence.** `app/helpers/admin/base_helper.rb:83-97`.
**Status.** [I]
**Covered by.** untested.
**Oracle.** n/a.

### BR-366 Enrichment-source and payment-method labels
**Rule.** Source labels: `system_rule → Auto`, `user_rule → Rule`, `llm_rule → AI`, `llm_pending → Pending review`,
`manual → Manual`, `unmatched → Unmatched`, `system_fallback → Fallback`; unknown → humanized. Badge variants:
manual success, user_rule info, llm_pending warning, llm_rule default, others muted. Payment-method labels: `card → Card`,
`card_authorization → Card authorization`, `blik_pos → BLIK at POS`, `blik_p2p → BLIK to phone`, `blik_atm → BLIK at ATM`,
`transfer → Transfer`, `internal_transfer → Internal transfer`, `topup → Top-up`, `fee → Fee`, `other → Other`; unknown →
humanized; filter options start with `["All", ""]`. Category select labels: `"-"` × depth + breadcrumb names joined
by `" / "`. Cash list "Source" column shows the humanized source (`Manual`, `Atm link`). Sync age: never →
`"never"`; `<1h → "<m>m"`, `<24h → "<h>h"`, else `"<d>d"`; class muted ≤24h, warning ≤7d, else destructive.
**Evidence.** `app/helpers/admin/enrichment_helper.rb:4-66`; `app/helpers/admin/base_helper.rb:143-159`;
`app/views/admin/cash_transactions/index.html.erb:190-191`.
**Status.** [V] (labels visible in oracle UI)
**Covered by.** untested.
**Oracle.** [../oracle/ui/admin_cash_transactions_index.html](../oracle/ui/admin_cash_transactions_index.html) ("Manual", "Atm link"); dashboard account chips "· 0m".

### BR-367 Pagination
**Rule.** Offset pagination (pagy 43): default page size **10**, client may request `limit` up to **100** (larger values
are capped at 100; `0`/invalid → 10); `page` < 1 → 1; pages beyond the last return an empty page (no error) [I].
API list responses carry `pagination: {page, limit, count, pages}` and headers `link` (RFC 8288), `current-page`,
`page-limit`, `total-count`, `total-pages` [I]. Same defaults on admin index pages.
**Evidence.** `config/initializers/pagy.rb:5-8`; `lib/api/helpers/pagy_helper.rb:8-21`;
`bundle/.../pagy-43.5.3/lib/pagy/classes/request.rb:28-36`; `.../toolbox/helpers/headers_hash.rb:7-29`.
**Status.** [V] (default 10, client limit honoured, meta shape); cap at 100 [I] (oracle dataset had only 66 rows).
**Covered by.** `spec/requests/api/v1/transactions_spec.rb:6` LedgerEntry entity shape.
**Oracle.** [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json) `default` → `{"page":1,"limit":10,"count":66,"pages":7}`; `filtered_paged` (`limit=2&page=2`) → `{"page":2,"limit":2,"count":57,"pages":29}`; `limit_above_max` (1000) → all 66 rows.

### BR-368 Ransack search configuration and bank-transaction filters
**Rule.** Ransack converts `"0"`/`"false"` to false for custom scopes. Searchable attributes (allow-lists):
BankTransaction `id external_id booking_date value_date transaction_date amount_cents currency direction status title
type_hint counterparty_name counterparty_iban counterparty_kind payment_method bank_transaction_code bank_account_id
created_at updated_at` (associations `bank_account enrichment`); ManualTransaction `id booking_date transaction_date
amount_cents currency direction status title counterparty_name counterparty_kind payment_method source bank_account_id
linked_bank_transaction_id created_at updated_at` (associations `bank_account enrichment linked_bank_transaction`);
TransactionEnrichment `id source merchant_id category_id`. Admin bank transactions index (user's synced transactions):
explicit filters `merchant_id`, `category_id` (matches the enrichment's **explicit** category only, not merchant
defaults — see U-414), `enrichment_source`, `payment_method`, `enrichment_state ∈ {merchantless, llm_ready, no_llm_signal}`
(other values ignored); then Ransack `q`, default sort `booking_date desc`, paginated. A transaction in a hidden
category cannot be opened: redirect with `"This transaction is in a hidden category. Remove it from the hidden list in preferences to open it."`.
**Evidence.** `config/initializers/ransack.rb:3-6`; `app/models/bank_transaction.rb:85-93`; `app/models/manual_transaction.rb:93-101`;
`app/models/transaction_enrichment.rb:78-84`; `app/controllers/admin/bank_transactions_controller.rb:6-23,26-38,49-67`;
`app/controllers/admin/base_controller.rb:14-20`.
**Status.** [V] (filters render); semantics [I].
**Covered by.** untested for filter semantics.
**Oracle.** [../oracle/http/GET_admin_bank_transactions.json](../oracle/http/GET_admin_bank_transactions.json) `filtered` (`enrichment_state=unclassified&payment_method=card&q[title_cont]=BIED`) → 200.

### BR-369 Ledger list API filters
**Rule.** `GET /api/v1/transactions` over the user's ledger rows (all statuses): `from` (`booking_date ≥`), `to`
(`≤`), `direction`, `status`, `account_id`, `merchant_id`, `category_id` (= `effective_category_id`, i.e. includes
merchant defaults), `category_path` (subtree), `payment_method`, `currency` (upper-cased), `source_type ∈
{BankTransaction, ManualTransaction}`; order `booking_date desc, source_id desc`; response `{data:[LedgerEntry], pagination}`.
`GET /api/v1/transactions/:source_type/:source_id` → one entry, 404 if not the user's. Entity `category_path` is `""`
when NULL.
**Evidence.** `lib/api/resources/transactions.rb:11-60`; `lib/api/entities/ledger_entry.rb:5-28`.
**Status.** [V]
**Covered by.** `spec/requests/api/v1/transactions_spec.rb:6` entity shape; `:28` from/to range; `:43` single entry; `:57` 404 for another user's.
**Oracle.** [../oracle/http/GET_api__version_transactions.json](../oracle/http/GET_api__version_transactions.json); [../oracle/http/GET_api__version_transactions__source_type__source_id.json](../oracle/http/GET_api__version_transactions__source_type__source_id.json) `other_tenant_id` → 404, `invalid_source_type` → 400 `["source_type does not have a valid value"]`.

---

### Service catalogue (Part C)

<a id="svc-cash-atm-withdrawal-linker"></a>
#### app/services/cash/atm_withdrawal_linker.rb
- `Cash::AtmWithdrawalLinker.link!(bank_transaction)` — mirrors an eligible BLIK ATM debit as a booked credit top-up in the owner's cash wallet. Input: one BankTransaction. Output: the created ManualTransaction, or nil (ineligible, already linked, owner without track_cash, or concurrent duplicate). Implements BR-349 (and BR-346 gap, BR-303). [V]

<a id="svc-cash-tracking"></a>
#### app/services/cash/tracking.rb
- `Cash::Tracking.enable!(user:, currency: "PLN")` — ensures the wallet and backfills ATM links for all of the user's BLIK ATM debits. Input: user, currency (default PLN). Output: `Result{wallet, linked}` (count of newly linked rows). Implements BR-340, BR-350. [V]

<a id="svc-cash-transaction-creator"></a>
#### app/services/cash/transaction_creator.rb
- `Cash::TransactionCreator.call(user:, input:)` — normalises input (amount/currency/direction/payment method/dates), resolves the wallet, saves the ManualTransaction and its manual enrichment in one DB transaction. Input: `Input{amount, currency, direction, booking_date, transaction_date, title, note, counterparty_name, merchant_id, category_id, payment_method}`. Output: `Result{success?, transaction, enrichment, error_messages}` (`error` = messages joined by ", "). Implements BR-341, BR-342, BR-343, BR-344, BR-345, BR-346. [V]

<a id="svc-cash-transaction-updater"></a>
#### app/services/cash/transaction_updater.rb
- `Cash::TransactionUpdater.call(transaction:, input:)` — updates a manual row with keep-vs-clear semantics and rewrites its enrichment as manual; currency is locked to the wallet. Input: the row + `Input` (same fields as the creator minus currency). Output: `Result{success?, transaction, error_messages}`. Implements BR-342, BR-345, BR-346, BR-347. [V]

<a id="svc-cash-wallet-resolver"></a>
#### app/services/cash/wallet_resolver.rb
- `Cash::WalletResolver.call(user:, currency: "PLN")` — find-or-create the user's cash wallet for a currency (uid `cash_<user_id>_<ccy>`). Output: BankAccount (manual). Raises ArgumentError for missing user/currency. Implements BR-341. [V]

<a id="svc-analytics-account-breakdown"></a>
#### app/services/analytics/account_breakdown.rb
- `Analytics::AccountBreakdown.call(scope, user:, currency:)` — spend per owned account, descending. Output: rows `{account, amount_cents, count, currency}`. Implements BR-328, BR-306. [V]

<a id="svc-analytics-cash-flow"></a>
#### app/services/analytics/cash_flow.rb
- `Analytics::CashFlow.totals(scope)` / `.series(scope, period:, currency:)` — spend, income and net totals and the gap-filled per-bucket series. Output: `{spend_cents, income_cents, net_cents}` / list of points `{date, spend_cents, income_cents, net_cents, quiet?}`. Implements BR-320, BR-313, BR-303. [V]

<a id="svc-analytics-facet-breakdown"></a>
#### app/services/analytics/facet_breakdown.rb
- `Analytics::FacetBreakdown.essential(scope, currency:)` — essential vs discretionary split of spend. Output: `Pair{left: Essential row, right: Discretionary row, total, left/right share % (1 decimal)}`. Implements BR-329. [V]

<a id="svc-analytics-filter"></a>
#### app/services/analytics/filter.rb
- `Analytics::Filter.new(user:, params:)` — turns request params into the analytics scope: owned-account set (incl. `accounts=none`), single currency (explicit or dominant, fallback PLN), period (default month-to-date) and bucket (auto by length), `under_path`, previous-period scope/label, previous full month scope, and URL params. Output: `scope`, `previous_scope`, `previous_full_month_scope`, `period`, `currency`, `previous_label`, `to_query_params`, … Implements BR-304, BR-305, BR-306, BR-307, BR-311, BR-312, BR-314, BR-316. [V]

<a id="svc-analytics-period"></a>
#### app/services/analytics/period.rb
- `Analytics::Period.new(from:, to:, bucket:)` / `.last_n_days(n)` — inclusive date window with day/week/month buckets, length, previous same-length window, gap-fill and SQL `DATE_TRUNC` expression; rejects bad bucket or `from > to` with ArgumentError. Implements BR-310, BR-311, BR-313, BR-314. [V]

<a id="svc-analytics-spend-breakdown"></a>
#### app/services/analytics/spend_breakdown.rb
- `Analytics::SpendBreakdown.by_category / by_subpath / by_merchant_in_category / merchant_monthly_trend / total_cents` — category-path spend grouping (leaf or depth-truncated) with previous-period amounts and delta %, next-level subtree rows, merchants within a category subtree, and the 12-month merchant trend. Output: `Row{path, name, merchant, amount_cents, prev_amount_cents, count, currency, slug, delta_pct}` lists or `[{bucket, value}]`. Implements BR-325, BR-330, BR-331. [V]

<a id="svc-analytics-top-merchants"></a>
#### app/services/analytics/top_merchants.rb
- `Analytics::TopMerchants.call(scope, user:, currency:, limit: 8)` — top merchants by spend. Output: rows `{merchant, amount_cents, count, currency}`. Implements BR-327. [V]

<a id="svc-analytics-top-movers"></a>
#### app/services/analytics/top_movers.rb
- `Analytics::TopMovers.from_breakdown(breakdown, limit: 5, min_amount_cents: 5000, min_change_cents: 5000)` — biggest category swings vs the previous period, filtered for noise. Output: rows `{path, name, slug, current_cents, prev_cents, delta_cents, delta_pct, direction, new_spend?}`. Implements BR-326. [V]
