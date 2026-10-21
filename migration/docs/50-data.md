# 50 - Data: schema, view, migrations, seeds


> **Decisions apply.** Where Phase-4 decisions change behaviour for Kotlin, the [deviation register](decisions.md#deviation-register--where-the-kotlin-expectation-differs-from-the-ruby-oracle) (X-01…X-27) overrides the Ruby behaviour described here; unknowns carry a **Resolution** line ([unknowns.md](unknowns.md)).

The physical data model of **open-banking-rails** (PostgreSQL), taken from `db/schema.rb` (schema version
`2026_05_14_141323`, ActiveRecord 8.1) plus `db/views/*.sql`, `db/migrate/*` and `db/seeds*`. Behaviour of the models on
top of these tables is in [10-domain-model.md](10-domain-model.md).

Legend: **[V]** = verified (passing spec, or oracle run), **[I]** = inferred from code. Paths are relative to `src/`.
Unless stated otherwise, every table fact below is read directly from `db/schema.rb` (cited per table) and is **[I]**
(schema DDL, not executed by me). The oracle database was built from this schema (`oracle/fixture.json` counts:
`schema_migrations = 33`) [V].

## 1. Database-wide facts

| Topic | Fact | Evidence |
|---|---|---|
| Engine | PostgreSQL (uses `ltree`, `jsonb`, partial indexes, GiST, check constraints) | `db/schema.rb:13-457` |
| Extensions | `ltree` (category paths) and `plpgsql` (default). There is **no** `pgcrypto`, because encryption happens in the app | `db/schema.rb:15-16` |
| Primary keys | Every table has `id bigint` generated from a sequence (Rails `bigserial` default), except the view (no PK) | Rails PG default [I] |
| Timestamps | `t.datetime` = `timestamp(6) without time zone`, values in **UTC** (app zone is UTC). `created_at`/`updated_at` are NOT NULL except in `versions` (`created_at` nullable, no `updated_at`) | `db/schema.rb`; oracle `server.log.txt` INSERT values in UTC [V] |
| Strings | `varchar` without length unless noted (`currency varchar(3)` on ledger tables, `last_four varchar(4)`) | `db/schema.rb:90,170,265` |
| Enumerations | **No DB enums or CHECKs** for status/kind columns. Allowed values are enforced only by model validations (listed per column; full lists in 10-domain-model) | `db/migrate/20260428220217_create_operation_runs.rb:4-6` |
| Foreign keys | 26 FKs, **all without `ON DELETE`/`ON UPDATE` clauses**, so PostgreSQL `NO ACTION` (deletion of a referenced row fails). Cascades/nullify happen in the application (`dependent:` options, see §4) | `db/schema.rb:373-398` |
| Polymorphic refs | `transaction_enrichments.enrichable_*`, `operation_runs.subject_*`, `versions.item_*`, `gutentag_taggings.taggable_*` have **no FK** | ADR `docs/adr/0002-polymorphic-enrichment.md:24-25` |
| Encryption at rest | 8 `text` columns hold Rails ActiveRecord-encryption envelopes (§3) | ADR `0004-encryption-at-rest.md:15-23` |
| Volumes (oracle, 2 showcase tenants) | users 2, tpp_credentials 4, bank_connections 4, bank_accounts 10, bank_transactions 108, manual_transactions 24, transaction_enrichments 24, categories 236, merchants 56, merchant_rules 66, operation_runs 4, sync_schedules 4, llm_settings 2, personal_access_tokens 3, user_hidden_categories 4, gutentag_tags 0, gutentag_taggings 0, versions 54, schema_migrations 33, ar_internal_metadata 2 | `oracle/fixture.json` `counts` [V] |

Expected real-world scale: one or two users per self-hosted install (ADR `0011-first-run-setup.md:3-8`). ADR 0003
suggests revisiting the plain view only beyond about 10^5 ledger rows (`0003-postgres-view-for-analytics.md:37-38`).

## 2. Tables

<a id="table-users"></a>
### users

Devise user / tenant. `db/schema.rb:347-360`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `email` | varchar | NO | `""` | login (lower-cased) |
| `encrypted_password` | varchar | NO | `""` | bcrypt hash |
| `name` | varchar | yes |  | display name (required by model) |
| `remember_created_at` | timestamp(6) | yes |  | Devise rememberable |
| `reset_password_sent_at` | timestamp(6) | yes |  | Devise recoverable |
| `reset_password_token` | varchar | yes |  | Devise reset token (digest) |
| `reveal_hidden_categories` | boolean | NO | `false` | privacy override |
| `track_cash` | boolean | NO | `false` | cash-tracking opt-in |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: `index_users_on_email` UNIQUE (email); `index_users_on_reset_password_token` UNIQUE. No FKs out. Referenced by
`tpp_credentials`, `categories`, `merchants` (`user_id`, `approved_by_id`), `merchant_rules` (`user_id`, `approved_by_id`),
`llm_settings`, `personal_access_tokens`, `user_hidden_categories`, `operation_runs.triggered_by_user_id`,
`manual_transactions.created_by_user_id`, `bank_accounts.manual_owner_id`.

<a id="table-tpp-credentials"></a>
### tpp_credentials

Enable Banking application registrations. `db/schema.rb:292-313`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `application_id` | text | yes |  | **encrypted** EB application id |
| `cert_expires_at` | timestamp(6) | yes |  | derived from public cert |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `environment` | varchar | yes |  | PRODUCTION / SANDBOX |
| `last_verification_error` | text | yes |  | last test error |
| `last_verified_at` | timestamp(6) | yes |  | last successful test |
| `metadata` | jsonb | NO | `{}` | last GET /application response |
| `name` | varchar | NO |  | label |
| `primary` | boolean | NO | `false` | primary credential flag |
| `private_key_pem` | text | yes |  | **encrypted** RSA private key PEM |
| `provider` | varchar | NO | `"enable_banking"` | enable_banking |
| `public_cert_pem` | text | yes |  | public certificate (clear) |
| `redirect_url` | varchar | yes |  | OAuth callback URL |
| `status` | varchar | NO | `"pending"` | pending / active / error |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users |

Indexes: `index_tpp_credentials_on_user_id` (user_id); **`index_one_primary_tpp_credential_per_user` UNIQUE (user_id)
WHERE `"primary" = true`** (at most one primary per user); `index_tpp_credentials_on_status`; `index_tpp_credentials_on_provider`.
FK: `user_id → users.id` (NO ACTION). `primary` is a reserved word and must be quoted in SQL.
`metadata` shape: the Enable Banking `GET /application` response, including `redirect_urls: [string]` (`app/services/enable_banking/operations/verify_credential.rb:184-197`).

<a id="table-bank-connections"></a>
### bank_connections

PSD2 consent sessions. `db/schema.rb:53-79`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `access_balances` | boolean | NO | `true` | consent scope: balances |
| `access_transactions` | boolean | NO | `true` | consent scope: transactions |
| `authorized_at` | timestamp(6) | yes |  | consent authorised at |
| `bank_country` | varchar | yes | `"PL"` | ASPSP country (ISO-2) |
| `bank_name` | varchar | yes |  | ASPSP display name |
| `bank_slug` | varchar | NO |  | parameterised ASPSP name, e.g. `pko_bp` |
| `closed_at` | timestamp(6) | yes |  | closed/replaced time |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `last_error` | text | yes |  | last refresh error `HTTP <status>: <error>` |
| `last_refreshed_at` | timestamp(6) | yes |  | last GET /sessions/{id} |
| `last_synced_at` | timestamp(6) | yes |  | last connection-wide transaction sync |
| `psu_id_hash` | text | yes |  | **encrypted** PSU id hash |
| `psu_type` | varchar | yes | `"personal"` | personal / business |
| `raw_session_payload` | text | yes |  | **encrypted** full POST /sessions JSON |
| `replaces_id` | bigint | yes |  | FK → bank_connections (self); superseded connection |
| `session_id` | text | yes |  | **encrypted** Enable Banking session id |
| `status` | varchar | NO | `"pending"` | pending/authorized/expired/revoked/replaced/error/closed |
| `tpp_credential_id` | bigint | NO |  | FK → tpp_credentials |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `valid_until` | timestamp(6) | yes |  | consent expiry |

Indexes: `index_bank_connections_on_tpp_credential_id`; `index_bank_connections_lookup` (tpp_credential_id, bank_slug,
status); `index_bank_connections_on_status`; `index_bank_connections_on_valid_until`; `index_bank_connections_on_replaces_id`.
FKs: `tpp_credential_id → tpp_credentials.id`; `replaces_id → bank_connections.id` (self). Both NO ACTION.
`raw_session_payload` (decrypted) shape = `POST /sessions` response: `{session_id, psu_type, psu_id_hash, authorized,
access: {balances, transactions, valid_until}, aspsp: {name, country}, accounts: [account resource…]}`
(`app/services/enable_banking/operations/create_connection.rb:33-49`; fake `spec/support/fakes/enable_banking_client.rb:290-306`).

<a id="table-bank-accounts"></a>
### bank_accounts

Synced bank accounts and cash wallets. `db/schema.rb:18-51`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `account_servicer` | jsonb | yes |  | servicer info, e.g. `{"bic_fi":"…"}` |
| `all_account_ids` | jsonb | NO | `[]` | array of `{scheme_name, identification}` (IBAN/BBAN/…) from Enable Banking |
| `balances_synced_at` | timestamp(6) | yes |  | last balance refresh |
| `bban` | varchar | yes |  | BBAN from `account_id.other` when scheme is BBAN |
| `cash_account_type` | varchar | yes |  | ISO 20022 code: CACC/CARD/CASH/LOAN/OTHR/SVGS (wallets: CASH) |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `currency` | varchar | yes |  | ISO 4217 account currency |
| `current_bank_connection_id` | bigint | yes |  | FK → bank_connections; session that last returned the account |
| `details` | varchar | yes |  | bank secondary description |
| `details_fetched_at` | timestamp(6) | yes |  | last GET /accounts/{uid}/details |
| `iban` | varchar | yes |  | primary IBAN |
| `manual` | boolean | NO | `false` | true = cash wallet |
| `manual_owner_id` | bigint | yes |  | FK → users; wallet owner (NULL for synced) |
| `name` | varchar | yes |  | holder name |
| `product` | varchar | yes |  | bank product name |
| `raw_account_resource` | jsonb | yes |  | account object from POST /sessions |
| `raw_balances` | text | yes |  | **encrypted** JSON string of balances response |
| `raw_details` | jsonb | yes |  | GET /accounts/{uid}/details response |
| `status` | varchar | NO | `"active"` | active / inactive / revoked |
| `tpp_credential_id` | bigint | yes |  | FK → tpp_credentials (NULL for wallets) |
| `transactions_synced_at` | timestamp(6) | yes |  | last successful transaction sync; incremental window = this − 7 days |
| `uid` | varchar | NO |  | Enable Banking account UID, or `cash_<user_id>_<cur>` for wallets; globally unique |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `usage` | varchar | yes |  | PRIV / COMM |

Indexes: `index_bank_accounts_on_uid` **UNIQUE (uid)**, which is global and not scoped per user (U-101);
`index_bank_accounts_on_iban`; `…_on_manual`; `…_on_manual_owner_id`; `…_on_status`; `…_on_tpp_credential_id`;
`…_on_current_bank_connection_id`.
**Check constraint `bank_accounts_ownership_xor`**:
`(manual = true AND tpp_credential_id IS NULL AND manual_owner_id IS NOT NULL) OR (manual = false AND tpp_credential_id
IS NOT NULL AND manual_owner_id IS NULL)` (`db/schema.rb:50`; enforced, `spec/models/bank_account_spec.rb:84` [V]).
FKs: `current_bank_connection_id → bank_connections.id`, `tpp_credential_id → tpp_credentials.id`, `manual_owner_id →
users.id` (all NO ACTION).
jsonb shapes: `all_account_ids` = `[{"scheme_name":"IBAN","identification":"PL61…"}, …]`; `account_servicer` = `{"bic_fi":
"…", …}`; `raw_account_resource` = the account object of `POST /sessions` (`uid, account_id{iban|other}, all_account_ids,
currency, name, product, details, cash_account_type, usage, account_servicer`); `raw_details` = `GET /accounts/{uid}/details`.
`raw_balances` (encrypted text, JSON inside) = `{"balances":[{"balance_type":"ITAV","balance_amount":{"amount":"123.45",
"currency":"PLN"},"reference_date":"YYYY-MM-DD"}]}` (`app/services/enable_banking/operations/refresh_account_balances.rb:19-22`;
fake `spec/support/fakes/enable_banking_client.rb:194-202,310-320`).

<a id="table-bank-transactions"></a>
### bank_transactions

Synced ledger rows. `db/schema.rb:81-108`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `amount_cents` | bigint | NO |  | magnitude in minor units (≥ 0) |
| `bank_account_id` | bigint | NO |  | FK → bank_accounts |
| `bank_transaction_code` | varchar | yes |  | Berlin Group code (Revolut) |
| `booking_date` | date | NO |  | bank booking date |
| `counterparty_iban` | varchar | yes |  | counterparty IBAN (PL BBAN → `PL`+BBAN) |
| `counterparty_kind` | varchar | NO | `"unknown"` | self / external / unknown |
| `counterparty_name` | varchar | yes |  | debtor (credit) / creditor (debit) name |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `currency` | varchar(3) | NO |  | ISO 4217 |
| `direction` | varchar | NO |  | credit / debit |
| `external_id` | varchar | NO |  | bank id (`transaction_id` or `entry_reference`); unique per account |
| `fetched_at` | timestamp(6) | NO |  | sync timestamp |
| `payment_method` | varchar | yes |  | normalised method (card, card_authorization, blik_pos, blik_p2p, blik_atm, transfer, internal_transfer, topup, fee, other) |
| `raw_payload` | text | NO |  | **encrypted** bank transaction JSON |
| `status` | varchar | NO | `"booked"` | booked / pending |
| `title` | text | yes |  | remittance_information[0] |
| `transaction_date` | date | yes |  | optional |
| `type_hint` | varchar | yes |  | remittance_information[1] |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `value_date` | date | yes |  | optional |

Indexes: **`index_bank_transactions_on_bank_account_id_and_external_id` UNIQUE (bank_account_id, external_id)** (the sync
idempotency key); `(bank_account_id, booking_date)`; `bank_account_id`; `counterparty_kind`; `payment_method`; `status`.
FK: `bank_account_id → bank_accounts.id` (NO ACTION).
`raw_payload` (encrypted, JSON inside) = one Enable Banking transaction: `{transaction_id, entry_reference,
credit_debit_indicator: "CRDT"|"DBIT", status: "BOOK"|"PDNG", transaction_amount: {amount: "12.34", currency},
remittance_information: [title, type_hint, …], debtor|creditor: {name}, debtor_account|creditor_account: {iban} |
{other: {scheme_name, identification}}, bank_transaction_code: {code}, booking_date, value_date, transaction_date, …}`
(`app/services/enable_banking/transaction_normalizer.rb:22-63`).

<a id="table-manual-transactions"></a>
### manual_transactions

Cash ledger rows (wallets only). `db/schema.rb:162-188`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `amount_cents` | bigint | NO |  | magnitude in minor units (> 0 by model) |
| `bank_account_id` | bigint | NO |  | FK → bank_accounts (must be a wallet) |
| `booking_date` | date | NO |  | booking date |
| `counterparty_kind` | varchar | NO | `"unknown"` | self / external / unknown |
| `counterparty_name` | varchar | yes |  | free text |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `created_by_user_id` | bigint | NO |  | FK → users; author |
| `currency` | varchar(3) | NO |  | ISO 4217 = wallet currency |
| `direction` | varchar | NO |  | credit / debit |
| `linked_bank_transaction_id` | bigint | yes |  | FK → bank_transactions; ATM withdrawal mirrored |
| `note` | text | yes |  | free note |
| `payment_method` | varchar | yes |  | cash / cash_atm_topup / cash_deposit / cash_fx_conversion / cash_adjustment |
| `source` | varchar | NO | `"manual"` | manual / atm_link / csv_import / recurring |
| `status` | varchar | NO | `"booked"` | booked / pending |
| `title` | text | yes |  | description |
| `transaction_date` | date | yes |  | optional |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: `(bank_account_id, booking_date)`; `bank_account_id`; `counterparty_kind`; `created_by_user_id`;
`linked_bank_transaction_id`; **`idx_manual_transactions_one_per_linked_bank_tx` UNIQUE (linked_bank_transaction_id)
WHERE `linked_bank_transaction_id IS NOT NULL`** (one cash top-up per ATM withdrawal; `spec/models/manual_transaction_spec.rb:122` [V]);
`payment_method`; `status`. There is no uniqueness for user-entered rows (duplicates are a UX matter,
`db/migrate/20260430120001_create_manual_transactions.rb:6-9`).
FKs: `bank_account_id → bank_accounts.id`, `linked_bank_transaction_id → bank_transactions.id`, `created_by_user_id →
users.id` (NO ACTION). Deleting a bank transaction that a cash top-up links to fails at DB level [I].

<a id="table-transaction-enrichments"></a>
### transaction_enrichments

Classification per ledger row (polymorphic, 1:1). `db/schema.rb:315-335`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `category_id` | bigint | yes |  | FK → categories; explicit override |
| `category_overridden` | boolean | NO | `false` | user-locked category |
| `confidence` | numeric(4,3) | yes |  | 0..1 |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `enrichable_id` | bigint | NO |  | polymorphic id (no FK) |
| `enrichable_type` | varchar | NO |  | BankTransaction / ManualTransaction |
| `enriched_at` | timestamp(6) | yes |  | last classification |
| `merchant_id` | bigint | yes |  | FK → merchants |
| `merchant_rule_id` | bigint | yes |  | FK → merchant_rules |
| `model` | varchar | yes |  | LLM model |
| `notes` | text | yes |  | free text |
| `source` | varchar | NO |  | unmatched/system_rule/user_rule/llm_rule/llm_pending/manual/system_fallback |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: **`idx_enrichments_on_enrichable` UNIQUE (enrichable_type, enrichable_id)** plus a redundant non-unique
`index_transaction_enrichments_on_enrichable` on the same columns; `category_id`; `merchant_id`; `merchant_rule_id`; `source`.
FKs: `category_id → categories.id`, `merchant_id → merchants.id`, `merchant_rule_id → merchant_rules.id` (NO ACTION; the
app nullifies before deleting parents). No FK for `enrichable_*`.
The table is designed to be **rebuildable**: dropping it and re-running the enricher restores everything except user decisions
(`source = 'manual'` or `category_overridden = true`) (`db/migrate/20260429185631_create_transaction_enrichments.rb:6-13`).

<a id="table-categories"></a>
### categories

Per-user ltree taxonomy. `db/schema.rb:110-128`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `archived_at` | timestamp(6) | yes |  | soft delete |
| `color` | varchar | yes |  | UI colour token |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `essential` | boolean | NO | `false` | needs (true) vs wants |
| `icon` | varchar | yes |  | icon name |
| `kind` | varchar | NO | `"expense"` | expense / income / transfer / savings / ignored |
| `name` | varchar | NO |  | display name |
| `path` | ltree | yes |  | ltree path (labels `[a-z0-9_]`); required by model |
| `position` | integer | NO | `0` | ordering hint |
| `slug` | varchar | NO |  | per-user unique id `[a-z0-9_-]+` |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users |

Indexes: **`index_categories_on_path` GiST (path)** (supports `<@`, `@>`, `~ lquery`); **`index_categories_on_user_id_and_path`
UNIQUE (user_id, path)**; **`index_categories_on_user_id_and_slug` UNIQUE (user_id, slug)**; `user_id`; `archived_at`.
FK: `user_id → users.id`. `path` is nullable in the DB (it was added without a backfill, see migration 20260501140000), but the model
requires it (U-108). In PostgreSQL a unique index treats NULL paths as distinct.

<a id="table-merchants"></a>
### merchants

Per-user counterparties. `db/schema.rb:214-237`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `approved_at` | timestamp(6) | yes |  | approval time |
| `approved_by_id` | bigint | yes |  | FK → users |
| `archived_at` | timestamp(6) | yes |  | soft delete |
| `confidence` | numeric(4,3) | yes |  | LLM confidence 0..1 |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `default_category_id` | bigint | yes |  | FK → categories; category used when enrichment has no override |
| `kind` | varchar | yes |  | company/person/charity/government/platform/other |
| `logo_url` | varchar | yes |  | logo |
| `model` | varchar | yes |  | LLM model |
| `name` | varchar | NO |  | display name |
| `notes` | text | yes |  | free text (LLM reasoning appended) |
| `slug` | varchar | NO |  | per-user unique id |
| `source` | varchar | NO |  | system / user / llm |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users |

Indexes: **`index_merchants_on_user_id_and_slug` UNIQUE**; `user_id`; `name`; `source`; `archived_at`;
`default_category_id`; `approved_by_id`. FKs: `user_id → users.id`, `approved_by_id → users.id`,
`default_category_id → categories.id` (NO ACTION). The former `display_name` column was dropped (migration 20260501150713).

<a id="table-merchant-rules"></a>
### merchant_rules

Pattern rules mapping a field value to a merchant. `db/schema.rb:190-212`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `approved_at` | timestamp(6) | yes |  | approval time |
| `approved_by_id` | bigint | yes |  | FK → users |
| `case_sensitive` | boolean | NO | `false` | match case-sensitively |
| `confidence` | numeric(4,3) | yes |  | LLM confidence 0..1 |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `enabled` | boolean | NO | `true` | participates in matching |
| `field` | varchar | NO |  | title / counterparty_name / counterparty_iban / payment_method |
| `kind` | varchar | NO |  | contains / regex / exact / prefix / iban |
| `merchant_id` | bigint | NO |  | FK → merchants |
| `model` | varchar | yes |  | LLM model |
| `pattern` | varchar | NO |  | match pattern |
| `priority` | integer | NO | `0` | tie-breaker within source tier (higher first) |
| `source` | varchar | NO |  | system / user / llm |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users |

Indexes: `(enabled, priority)`; `(field, pattern)`; `merchant_id`; `source`; `user_id`; `approved_by_id`. There is **no unique
constraint** (seeders and the syncer dedupe by `(merchant_id, field, pattern)` in code). FKs: `merchant_id → merchants.id`,
`user_id → users.id`, `approved_by_id → users.id`. Regex patterns use **Ruby (Onigmo) regex syntax** and are evaluated in
the app, not in SQL (`app/models/merchant_rule.rb:87-89`) [I].

<a id="table-user-hidden-categories"></a>
### user_hidden_categories

`db/schema.rb:337-345`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `category_id` | bigint | NO |  | FK → categories |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users |

Indexes: **UNIQUE (user_id, category_id)**; `user_id`; `category_id`. FKs: `user_id → users.id`, `category_id →
categories.id` (NO ACTION, with no app-side cleanup on category delete, U-119).

<a id="table-llm-settings"></a>
### llm_settings

`db/schema.rb:150-160`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `api_key` | text | NO |  | **encrypted** provider API key |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `last_test_error` | text | yes |  | last test error (≤ 500 chars) |
| `last_tested_at` | timestamp(6) | yes |  | last connection test |
| `model` | varchar | yes |  | model id (defaults to provider default) |
| `provider` | varchar | NO |  | openai / gemini |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users (unique) |

Indexes: `index_llm_settings_on_user_id` **UNIQUE** (one per user). FK `user_id → users.id`.

<a id="table-personal-access-tokens"></a>
### personal_access_tokens

`db/schema.rb:263-275`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `last_four` | varchar(4) | NO |  | last 4 chars of raw token |
| `last_used_at` | timestamp(6) | yes |  | last API use |
| `name` | varchar | NO |  | label (1..50, unique per user ci) |
| `revoked_at` | timestamp(6) | yes |  | revocation time |
| `token_digest` | varchar | NO |  | SHA-256 hex of raw token |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |
| `user_id` | bigint | NO |  | FK → users |

Indexes: **`token_digest` UNIQUE** (global); **`(user_id, name)` UNIQUE** (note: the DB index is case-*sensitive*, while the
model uniqueness check is case-insensitive); `user_id`. FK `user_id → users.id`. Raw tokens (`obrl_` + random) are never stored
(`spec/models/personal_access_token_spec.rb:65` [V]).

<a id="table-sync-schedules"></a>
### sync_schedules

`db/schema.rb:277-290`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `bank_connection_id` | bigint | NO |  | FK → bank_connections (unique) |
| `cadence` | varchar | NO | `"daily"` | daily / every_2_days / weekly |
| `consecutive_failures` | integer | NO | `0` | circuit-breaker counter |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `enabled` | boolean | NO | `false` | auto-sync on |
| `last_dispatched_at` | timestamp(6) | yes |  | last dispatch |
| `next_run_at` | timestamp(6) | yes |  | next slot (NULL = due) |
| `paused_until` | timestamp(6) | yes |  | circuit-breaker / revoked backoff |
| `preferred_hour` | integer | NO | `8` | 0..23 (effectively UTC) |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: **`index_sync_schedules_on_bank_connection_id` UNIQUE** (one per connection); **`index_sync_schedules_due`
(enabled, next_run_at) WHERE `enabled = true`** (dispatcher scan). FK `bank_connection_id → bank_connections.id` (NO ACTION;
the app destroys the schedule with its connection).

<a id="table-operation-runs"></a>
### operation_runs

`db/schema.rb:239-261`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `error` | text | yes |  | failure / partial message |
| `finished_at` | timestamp(6) | yes |  | terminal time |
| `kind` | varchar | NO |  | operation kind (see KINDS) |
| `params` | jsonb | NO | `{}` | kind-specific inputs |
| `scheduled_for` | timestamp(6) | yes |  | slot for scheduled dispatches (NULL for manual) |
| `started_at` | timestamp(6) | yes |  | start time |
| `status` | varchar | NO | `"queued"` | queued/running/succeeded/partial/failed |
| `subject_id` | bigint | yes |  | polymorphic subject id |
| `subject_type` | varchar | yes |  | User / BankConnection / BankAccount |
| `summary` | jsonb | NO | `{}` | kind-specific result |
| `trigger` | varchar | NO | `"manual"` | manual / scheduled |
| `triggered_by_user_id` | bigint | NO |  | FK → users (tenant) |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: `created_at`; `kind`; `status`; `(kind, status)`; `index_operation_runs_on_subject` (subject_type, subject_id);
`triggered_by_user_id`; **`index_operation_runs_scheduled_for_idempotency` UNIQUE (subject_type, subject_id, kind,
scheduled_for) WHERE `scheduled_for IS NOT NULL`**. This gives idempotency for scheduled dispatches: a second insert for the same slot
raises unique-violation and the dispatcher skips it (`spec/models/operation_run_spec.rb:111,124`; `spec/services/auto_sync/dispatcher_spec.rb:55` [V]).
FK `triggered_by_user_id → users.id` (NO ACTION).
jsonb `params` / `summary` shapes per `kind` are a code-side contract (ADR `0009-operation-run-tracker.md:29-31`). They are listed in
[10-domain-model.md, OperationRun](10-domain-model.md#model-operationrun). Example observed rows:
`{"kind":"transaction_sync","params":{"date_from":"2026-07-13","date_to":"2026-10-21"},"summary":{"accounts":[{"bank":"PKO BP",
"iban":"PL61…874","status":"succeeded","date_to":"2026-10-21","skipped":0,"updated":0,"inserted":0,"date_from":"2026-10-14",
"truncated":false,"pages_fetched":1,"bank_account_id":1}]}}` and `{"kind":"llm_enrichment","params":{"limit":5},"summary":
{"batches":[],"skipped":0,"auto_applied":0,"total_groups":0,"pending_review":0}}` (`oracle/operation_runs_after_capture.jsonl` [V]).

<a id="table-versions"></a>
### versions

PaperTrail audit log. `db/schema.rb:362-371`; migrations `20260427193315`, `20260427193316`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `created_at` | timestamp(6) | yes |  | event time (UTC) |
| `event` | varchar | NO |  | create / update / destroy |
| `item_id` | bigint | NO |  | audited record id |
| `item_type` | varchar | NO |  | audited class name |
| `object` | text | yes |  | YAML of attributes before change (NULL on create) |
| `object_changes` | text | yes |  | YAML `{attr: [old, new]}` |
| `whodunnit` | varchar | yes |  | actor (always NULL here) |

Index: `index_versions_on_item_type_and_item_id` (item_type, item_id). No FKs and **no user/tenant column**.
**Usage**: rows are written for `TppCredential` (skipping `application_id`, `private_key_pem`), `BankConnection` (skipping
`session_id`, `psu_id_hash`, `raw_session_payload`), `BankAccount` (no skip, so the `raw_balances` ciphertext envelope is copied)
and `ManualTransaction` (all columns). `object`/`object_changes` are **YAML** produced by Ruby's Psych, including Ruby tags
(`!ruby/object:ActiveSupport::TimeWithZone` with `utc:`/`zone: Etc/UTC`) and YAML anchors (`&1`, `*1`). `whodunnit` is always
NULL. In the oracle: 33 inserts during capture, 7 create / 21 update / 5 destroy (`oracle/server.log.txt`) [V]; 54 rows total
(`oracle/fixture.json`). Read only by `/admin/versions*`, which has no tenant scoping (U-121). `PersonalAccessToken#touch_used!`
deliberately bypasses versioning (`spec/models/personal_access_token_spec.rb:98` [V]).

<a id="table-gutentag-tags"></a>
### gutentag_tags

Gutentag tag table, created by `20260501140000_layered_categories_foundation`. `db/schema.rb:141-148`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `name` | varchar | NO |  | tag name (globally unique) |
| `taggings_count` | integer | NO | `0` | counter cache |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: `index_gutentag_tags_on_name` UNIQUE; `index_gutentag_tags_on_taggings_count`. Global (no user_id). **Unused**: 0 rows in
the oracle, and no app code writes tags (10-domain-model, Gutentag) [I].

<a id="table-gutentag-taggings"></a>
### gutentag_taggings

`db/schema.rb:130-139`.

| Column | SQL type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | bigint (bigserial) | NO | sequence | primary key |
| `created_at` | timestamp(6) | NO |  | row creation (UTC) |
| `tag_id` | bigint | NO |  | → gutentag_tags (no FK) |
| `taggable_id` | bigint | NO |  | polymorphic id |
| `taggable_type` | varchar | NO |  | polymorphic type (TransactionEnrichment) |
| `updated_at` | timestamp(6) | NO |  | last update (UTC) |

Indexes: `index_gutentag_taggings_on_tag_id`; `(taggable_type, taggable_id)`; `unique_taggings` UNIQUE (taggable_type,
taggable_id, tag_id). There is no FK, not even to `gutentag_tags`. **Unused** (0 rows).

<a id="table-ledger-entries"></a>
### ledger_entries (view)

The read-only analytics view `ledger_entries (view)`, managed by the `scenic` gem. The current definition is `db/views/ledger_entries_v04.sql`
(dumped into `db/schema.rb:400-456`; copy in `inventory/views_sql/`). It backs the `LedgerEntry` model.

**Semantics of v04 (current)** [V via `spec/models/ledger_entry_spec.rb`, cited per line]:

```sql
SELECT 'BankTransaction'::text AS source_type, bt.id AS source_id, bt.bank_account_id, bt.amount_cents, bt.currency,
       bt.direction,
       CASE bt.direction WHEN 'credit' THEN bt.amount_cents ELSE -bt.amount_cents END AS signed_amount_cents,
       bt.status, bt.booking_date, bt.transaction_date, bt.payment_method, bt.title, bt.counterparty_name,
       bt.counterparty_kind,
       te.id AS enrichment_id, te.merchant_id,
       COALESCE(te.category_id, m.default_category_id) AS effective_category_id,
       c.path AS category_path, COALESCE(c.essential, false) AS essential, te.source AS enrichment_source
FROM bank_transactions bt
LEFT JOIN transaction_enrichments te ON te.enrichable_type = 'BankTransaction' AND te.enrichable_id = bt.id
LEFT JOIN merchants m ON m.id = te.merchant_id
LEFT JOIN categories c ON c.id = COALESCE(te.category_id, m.default_category_id)
UNION ALL
SELECT 'ManualTransaction'::text, mt.id, ... identical projection over manual_transactions mt
       with te.enrichable_type = 'ManualTransaction' ...
```

| Column | Type | Rule |
|---|---|---|
| `source_type` | text | literal per branch; `(source_type, source_id)` is the natural key (one row per source row, `:57`) |
| `source_id` | bigint | source PK |
| `bank_account_id`, `amount_cents`, `currency`, `direction`, `status`, `booking_date`, `transaction_date`, `payment_method`, `title`, `counterparty_name`, `counterparty_kind` | as source | copied unchanged |
| `signed_amount_cents` | bigint | `+amount_cents` if `direction = 'credit'`, else `-amount_cents` (`:74`) |
| `enrichment_id`, `merchant_id`, `enrichment_source` | bigint/bigint/varchar | from the enrichment row; NULL when there is none |
| `effective_category_id` | bigint | `COALESCE(te.category_id, m.default_category_id)`: the override wins, else the merchant default, else NULL = unmatched (`:92,:107,:121`) |
| `category_path` | ltree | `categories.path` of the effective category (`:209`) |
| `essential` | boolean | `COALESCE(categories.essential, false)` |

Notes [I]: rows are **not** filtered by status, archived category/merchant, or tenant (tenant filtering is
`bank_account_id IN (…)` in the app). No column is NULL-cast because both branches have matching types. Merchant
`archived_at` and category `archived_at` do not affect resolution. The plain (non-materialised) view is always fresh (ADR 0003).

**Version history** (`db/views/ledger_entries_v01..v04.sql`; ADR `0003-postgres-view-for-analytics.md:21-29`)

| Version | Migration | Projection change |
|---|---|---|
| v01 | `20260430210000_create_ledger_entries_view` | Baseline: source_type, source_id, bank_account_id, amount_cents, currency, direction, signed_amount_cents, status, booking_date, transaction_date, payment_method, title, counterparty_name, enrichment_id, merchant_id, effective_category_id, enrichment_source. Joins enrichment + merchant only (`ledger_entries_v01.sql:27-81`) |
| v02 | `20260501141000_update_ledger_entries_to_v02` | Adds a `LEFT JOIN categories c ON c.id = COALESCE(...)` and the columns `category_path`, `essential` (`COALESCE(c.essential,false)`), `recurring` (`COALESCE(te.recurring,false)`), `recurrence_interval` (`te.recurrence_interval`) (`ledger_entries_v02.sql:1-88`) |
| v03 | `20260501153007_update_ledger_entries_to_version_3` | Adds `counterparty_kind` from both sources (NOT NULL default 'unknown' at source) after `counterparty_name` (`ledger_entries_v03.sql:1-84`) |
| v04 (current) | `20260508201753_update_ledger_entries_to_version_4` | Drops `recurring` and `recurrence_interval`. The same migration then drops those enrichment columns and their partial index (the view must be replaced first because of the dependency) (`ledger_entries_v04.sql:1-11`) |

Note: AGENTS.md (`AGENTS.md:115,146-155`) and ADR 0010 (`:23-25`) still describe the v01 projection or the removed
`recurring` facet. The SQL above is authoritative.

## 3. Encrypted columns

All of these are Rails ActiveRecord encryption, **non-deterministic** (random IV per write, so equality search is impossible), stored in
`text` columns. Ciphertext format (a JSON string, observed in the oracle SQL log [V]):
`{"p":"<base64 AES-256-GCM ciphertext>","h":{"iv":"<base64 12-byte IV>","at":"<base64 auth tag>"[,"c":true]}}`.
`"c": true` marks payloads that were zlib-compressed before encryption (Rails compresses larger values). The key is derived from
`ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY` with `ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT` (PBKDF2; SHA-256 under
`load_defaults 8.1`). `ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY` is configured but unused (`config/initializers/active_record_encryption.rb:15-32`;
algorithm details are Rails defaults [I]).

| Table.column | Plaintext content | Spec (round-trip, raw ≠ plaintext) |
|---|---|---|
| `tpp_credentials.application_id` | Enable Banking application id | `spec/models/tpp_credential_spec.rb:126` [V] |
| `tpp_credentials.private_key_pem` | RSA private key PEM | same [V] |
| `bank_connections.session_id` | EB session id | `spec/models/bank_connection_spec.rb:105` [V] |
| `bank_connections.psu_id_hash` | PSU id hash | [I] |
| `bank_connections.raw_session_payload` | JSON of `POST /sessions` | [I] |
| `bank_accounts.raw_balances` | JSON of balances | `spec/models/bank_account_spec.rb:165` [V] |
| `bank_transactions.raw_payload` | JSON of the bank transaction | `spec/models/bank_transaction_spec.rb:109` [V] |
| `llm_settings.api_key` | provider API key | `spec/models/llm_setting_spec.rb:67` [V] |

Copies of the `raw_balances` ciphertext also live in `versions.object/object_changes` (§2 versions). Migrating to Kotlin requires either
a Rails-compatible decryptor or a one-off re-encryption export (U-106).

## 4. Delete behaviour (DB vs application)

The DB never cascades (all FKs are NO ACTION). The Rails `dependent:` options define the effective behaviour, and a Kotlin port must
replicate it in services (or switch to explicit `ON DELETE` clauses with the same outcome) [I]:

| Parent deleted | Child effect | Evidence |
|---|---|---|
| users | destroy tpp_credentials (each **refuses** if it has connections/accounts), cash wallets (→ their transactions → enrichments), hidden categories, categories, merchants, merchant_rules, llm_setting, tokens, operation_runs | `app/models/user.rb:27-45` |
| tpp_credentials | **restrict** while bank_connections or bank_accounts exist | `app/models/tpp_credential.rb:42-43` |
| bank_connections | accounts' `current_bank_connection_id` → NULL; sync_schedule destroyed. A connection referenced by `replaces_id` cannot be deleted (no handling) | `app/models/bank_connection.rb:49-53` |
| bank_accounts | destroy bank_transactions and manual_transactions (each destroys its enrichment) | `app/models/bank_account.rb:61-62`; `spec/models/concerns/ledger_entry_concern_spec.rb:68,78` [V] |
| bank_transactions | destroy enrichment. A linked manual top-up blocks deletion (FK) | concern |
| manual_transactions | destroy enrichment; a paper_trail `destroy` version is written | concern; oracle log [V] |
| categories | merchants.default_category_id → NULL; enrichments.category_id → NULL; **user_hidden_categories not handled** (FK error, U-119). The UI refuses deletion while `in_use?` | `app/models/category.rb:49-50` |
| merchants | destroy merchant_rules (each nullifies enrichments.merchant_rule_id); enrichments.merchant_id → NULL | `app/models/merchant.rb:51-52`; `spec/models/merchant_spec.rb:106` [V] |
| merchant_rules | enrichments.merchant_rule_id → NULL | `app/models/merchant_rule.rb:55` |

## 5. Migrations

33 migrations, all `ActiveRecord::Migration[8.1]` except `20260507180000` (`[8.0]`). Applied in timestamp order:

| # | Version / file | Change |
|---|---|---|
| 1 | `20260427193315_create_versions` | PaperTrail `versions` (whodunnit, created_at, item_id, item_type, event, object) + index |
| 2 | `20260427193316_add_object_changes_to_versions` | `versions.object_changes text` |
| 3 | `20260427200713_devise_create_users` | `users` (Devise columns + name), unique email / reset token |
| 4 | `20260428185911_create_tpp_credentials` | `tpp_credentials` + partial unique "one primary per user" |
| 5 | `20260428185912_create_bank_connections` | `bank_connections` + lookup index, self-FK `replaces_id` |
| 6 | `20260428192948_create_bank_accounts` | `bank_accounts` (tpp_credential_id NOT NULL at that time), unique uid |
| 7 | `20260428194530_add_raw_balances_to_bank_accounts` | `raw_balances text` (encrypted) |
| 8 | `20260428214128_create_bank_transactions` | `bank_transactions` + unique (account, external_id) |
| 9 | `20260428220217_create_operation_runs` | `operation_runs` (triggered_by_user_id nullable at that time) |
| 10 | `20260429185628_create_categories` | `categories` with `parent_id` self-FK, global unique slug |
| 11 | `20260429185629_create_merchants` | `merchants` with `display_name`, global unique slug |
| 12 | `20260429185630_create_merchant_rules` | `merchant_rules` |
| 13 | `20260429185631_create_transaction_enrichments` | polymorphic `transaction_enrichments` + unique enrichable |
| 14 | `20260429185632_add_payment_method_to_bank_transactions` | `bank_transactions.payment_method` + index |
| 15 | `20260429190000_backfill_payment_method_on_bank_transactions` | **data backfill** (below) |
| 16 | `20260430120000_allow_manual_bank_accounts` | `manual`, `manual_owner_id`; tpp_credential_id nullable; XOR check constraint |
| 17 | `20260430120001_create_manual_transactions` | `manual_transactions` + partial unique linked tx |
| 18 | `20260430120002_add_track_cash_to_users` | `users.track_cash` default false |
| 19 | `20260430210000_create_ledger_entries_view` | view v01 |
| 20 | `20260430220000_create_user_hidden_categories` | `user_hidden_categories` |
| 21 | `20260430230000_scope_categories_merchants_rules_to_user` | **data backfill + tenancy** (below) |
| 22 | `20260501105510_create_llm_settings` | `llm_settings` (unique user) |
| 23 | `20260501112131_require_triggered_by_user_on_operation_runs` | **guarded NOT NULL** (below) |
| 24 | `20260501140000_layered_categories_foundation` | **structural + destructive** (below) |
| 25 | `20260501141000_update_ledger_entries_to_v02` | view v02 |
| 26 | `20260501150713_drop_merchant_display_name` | drop `merchants.display_name` (data discarded; it duplicated `name`) |
| 27 | `20260501152615_add_counterparty_kind_to_ledger_rows` | `counterparty_kind` NOT NULL default `unknown` on both ledger tables + indexes |
| 28 | `20260501153007_update_ledger_entries_to_version_3` | view v03 |
| 29 | `20260502170613_create_sync_schedules` | `sync_schedules` + partial due index; `operation_runs.scheduled_for` + partial unique idempotency index |
| 30 | `20260504184504_create_personal_access_tokens` | `personal_access_tokens` |
| 31 | `20260507180000_scope_category_path_uniqueness_to_user` | replace global unique `path` with unique `(user_id, path)` |
| 32 | `20260508201753_update_ledger_entries_to_version_4` | view v04; drop `transaction_enrichments.recurring`, `recurrence_interval` and the partial index |
| 33 | `20260514141323_add_reveal_hidden_categories_to_users` | `users.reveal_hidden_categories` default false |

### Migrations that change or backfill data

- **15 `20260429190000_backfill_payment_method_on_bank_transactions`**: `disable_ddl_transaction!`. For every
  `bank_transactions` row with `payment_method IS NULL`, it computes `EnableBanking::PaymentMethodInferer.call(type_hint:,
  bank_transaction_code:, title:, counterparty_name:, direction:)` and writes it with `update_columns` (no callbacks, no
  updated_at change) when non-nil. It is idempotent. `down` sets every `payment_method` to NULL. It depends on **application code** (the
  inferer as of the run date). An equivalent rake task `banking:backfill_payment_methods` exists (`lib/tasks/banking.rake`).
  (`db/migrate/20260429190000_backfill_payment_method_on_bank_transactions.rb:8-30`) [I]
- **16 `20260430120000_allow_manual_bank_accounts`**: makes `tpp_credential_id` nullable and adds `manual` (default false)
  and `manual_owner_id`. Existing rows satisfy the new XOR check because they are synced with a credential. No data rewrite.
  (`:7-20`) [I]
- **21 `20260430230000_scope_categories_merchants_rules_to_user`**: picks `user_id = MIN(users.id)` and **raises "Cannot backfill -
  no User exists. Create one first." when there are no users**. It adds nullable `user_id` FKs to `categories`, `merchants`, `merchant_rules`,
  runs `UPDATE … SET user_id = <first user> WHERE user_id IS NULL` on each, makes them NOT NULL, then replaces global
  unique `slug` indexes with `(user_id, slug)` on categories and merchants. The author's premise was that only one user existed in
  any deployment (`:2-17`). Consequence: **replaying all migrations on an empty database fails at this step** unless a user row exists
  (U-107). (`:18-41`) [I]
- **23 `20260501112131_require_triggered_by_user_on_operation_runs`**: raises "Refusing to migrate: orphan OperationRuns
  without triggered_by_user_id exist. Backfill or delete them first." if any NULL exists, otherwise sets NOT NULL. No
  data is changed. (`:2-11`) [I]
- **24 `20260501140000_layered_categories_foundation`**: `enable_extension "ltree"`; creates the gutentag tables (the 3 gem
  migrations collapsed); **drops `categories.parent_id`** (FK + indexes) if still present, so the old hierarchy is lost and not
  converted; adds `categories.path ltree` with a GiST index and a *global* unique index `index_categories_on_path_unique` (later
  made per-user by #31); adds `categories.essential` default false; adds `transaction_enrichments.recurring` (NOT NULL default
  false), `recurrence_interval` and a partial index `WHERE recurring = true` (all later dropped by #32). There is **no backfill of
  `path`**: existing categories get NULL, and the documented cutover is to re-run `db/seeds/categories.rb`, which re-keys categories by slug
  (`:18-22`). (`:23-77`) [I]
- **27 `20260501152615_add_counterparty_kind_to_ledger_rows`**: existing rows get `'unknown'`. Real values are computed at
  sync/create time, and for history by the rake task `banking:backfill_counterparty_kind` (`lib/tasks/banking.rake`) [I].
- **26 / 32**: destructive column drops (`merchants.display_name`; enrichment `recurring`/`recurrence_interval`) [I].

### What a Kotlin / Flyway baseline must replicate vs. what can be squashed

- **Squash** migrations 1-33 into a single baseline `V1__baseline.sql` equal to the *final* `db/schema.rb` state. Every
  intermediate shape (categories.parent_id, merchants.display_name, enrichment recurring columns, view v01-v03, global slug/path
  uniqueness, nullable triggered_by_user_id) is gone from the final schema and need not be reproduced. The data backfills (#15, #21,
  #24 path, #27) are only relevant to pre-May-2026 databases [I].
- The baseline **must** contain: the `ltree` extension; every table/column/default/NULL rule in §2; all indexes incl. the
  **partial unique** indexes (`index_one_primary_tpp_credential_per_user`, `idx_manual_transactions_one_per_linked_bank_tx`,
  `index_operation_runs_scheduled_for_idempotency`), the **partial** `index_sync_schedules_due`, the **GiST** index on
  `categories.path`, the compound uniques; the **check constraint** `bank_accounts_ownership_xor`; the 26 FKs (NO ACTION);
  and the `ledger_entries` view v04 (created after its base tables) [I].
- **Existing production databases** (if migrating data rather than starting fresh): mark the Flyway baseline as applied
  (`baselineOnMigrate`/`baselineVersion=1`) on databases whose `schema_migrations` contains all 33 versions. Rails bookkeeping tables
  `schema_migrations` and `ar_internal_metadata` can then be dropped or ignored. Encrypted columns and `versions` YAML need
  explicit migration decisions (U-105, U-106) [I].
- Optional cleanups (migration choices, not required for behaviour parity): the duplicate enrichable index; making `categories.path`
  NOT NULL (U-108); dropping the unused gutentag tables; DB enums/CHECKs for status columns [I].

## 6. Seeds

### Entry points and environment conditions

| Entry point | When | What | Evidence |
|---|---|---|---|
| `bin/rails db:seed` → `db/seeds.rb` | manual / `db:setup` | **Development only**: upserts user `maciek@example.com` (name "John Doe", password "password"). **All environments**: loads `db/seeds/categories.rb` then `db/seeds/merchant_rules.rb` | `db/seeds.rb:5-19` |
| `db/seeds/categories.rb` | from seeds.rb | `Seeders::Categories.call(user)` for **every existing user** (`User.find_each`) | `db/seeds/categories.rb:1-11` |
| `db/seeds/merchant_rules.rb` | from seeds.rb | `Seeders::MerchantRules.call(user)` for every user | `db/seeds/merchant_rules.rb:1-14` |
| First-run setup `POST /setup` | the first user is created | after `user.save` succeeds: `Seeders::Categories.call(user)`, `Seeders::MerchantRules.call(user)`, then sign-in. Not wrapped in a transaction (U-123) | `app/controllers/setup_controller.rb:12-25`; `spec/requests/public_spec.rb:29,51` [V] |
| `POST /admin/onboarding/seed_taxonomy` | manual "load baseline taxonomy" button | both seeders for `current_user` only, then `TransactionEnricher.rebuild!`. Flash: "Baseline taxonomy loaded - <n> categories, <m> system merchants. Existing transactions reclassified." | `app/controllers/admin/onboarding_controller.rb:8-15`; `spec/requests/onboarding_spec.rb:6,34` [V] |
| `Seeders::Showcase` | specs, oracle capture, `bin/rails runner` | demo data set (below); requires fake EB + LLM clients | `app/services/seeders/showcase.rb:1-334` |

### Seeders::Categories (default taxonomy per user)

`app/services/seeders/categories.rb:28-218`. **118 categories**: 10 roots, 30 second-level, 78 third-level (count of
`DEFINITIONS`). Idempotency key `(user_id, slug)` with `slug = path.tr(".", "_")` (e.g. `food.cooking.supermarket` →
`food_cooking_supermarket`). On each run, `name`, `kind`, `color` (per-domain palette unless overridden), `icon`,
`essential`, `path`, and `position` (= definition index 0..117) are **overwritten**, which also reverts user edits of seeded rows (U-109). Categories are never deleted
(`spec/services/seeders/categories_spec.rb:6,18,31` [V]: full tree with kind + path, idempotent with attribute re-apply,
per-user trees without collisions). Oracle: 236 categories = 2 × 118 [V].

Top-level categories:

| path | name (seeded, Polish) | kind | essential | colour | icon |
|---|---|---|---|---|---|
| `food` | Jedzenie | expense | false | emerald | utensils |
| `mobility` | Mobilność | expense | false | blue | car |
| `home` | Mieszkanie | expense | true | amber | home |
| `health` | Zdrowie i ciało | expense | false | rose | heart |
| `lifestyle` | Lifestyle | expense | false | violet | sparkles |
| `education` | Edukacja | expense | false | indigo | book-open |
| `services` | Usługi i opłaty | expense | true | slate | briefcase |
| `income` | Wpływy | income | false | green | trending-up |
| `money` | Ruch pieniędzy | transfer | false | gray | arrow-right-left |
| `noise` | Niesklasyfikowane | ignored | false | zinc | help-circle |

Kind rules inside the tree: all of `food.*`, `mobility.*`, `home.*`, `health.*`, `lifestyle.*`, `education.*`, `services.*`
are `expense`. `income.*` is `income`. `money.transfers.*` (own, private, atm) is `transfer`. `money.savings.*` and
`money.investments.*` are **`savings`**. `noise.unmatched.*` is **`expense`** ("real spend without a known merchant"), while
`noise.authorizations.*` and `noise.adjustments.*` are `ignored` (`categories.rb:182-197`). Children have no icon. Their colour
comes from the root's palette. The full list with names and `essential` flags is in `app/services/seeders/categories.rb:47-198`.

### Seeders::MerchantRules (default merchants + rules per user)

`app/services/seeders/merchant_rules.rb:3-132`. It requires the category seed (`raise "Missing seeded category at path: <path>"`
otherwise). Totals: **27 merchants, 29 rules** per user, all `source = "system"`, rules `enabled = true`, `case_sensitive =
false`. Merchant idempotency key `(user_id, slug)`; rule key `(merchant_id, field, pattern)` (find-or-initialize then overwrite)
(`spec/services/seeders/merchant_rules_spec.rb:6,24,39` [V]).

| Group | Merchants | Rule(s) | priority | Merchant kind → default category |
|---|---|---|---|---|
| Retail (25) | e.g. `biedronka` "Biedronka", `lidl`, `kaufland`, `auchan`, `eleclerc`, `zabka` "Żabka", `rossmann`, `mcdonalds` "McDonald's", `t_mobile`, `claude_ai`, `openai`, `anthropic`, `google_one`, `linkedin` … | 1 rule each: 20 × `title contains <UPPERCASE TOKEN>` (e.g. `BIEDRONKA`, `T-MOBILE POLSKA`, `DOZ APTEKA`), 5 × `counterparty_name contains` (`Claude.ai`, `Openai`, `Anthropic`, `Google`, `Linkedin`) | 0 (an existing priority is kept) | `company` → e.g. `food.cooking.supermarket`, `home.fixed.telecom`, `lifestyle.tools.saas` |
| ATM | `atm_withdrawal` "ATM" | `payment_method exact blik_atm` | **300** | `other` → `money.transfers.atm` (kind transfer) |
| Own top-up | `mobile_wallet_topup` "Top-up (own)" | `title contains "Google Pay Top-Up by"`, `"Apple Pay Top-Up by"`, `"Top-Up by *"` (literal `*`, not a wildcard) | **250** | `platform` → `money.transfers.own` |

Merchants get `approved_at` = the existing value or now. Retail rules get no `approved_at`, while ATM/top-up rules get one. Merchant
notes for ATM/top-up are fixed English texts (`merchant_rules.rb:304-306,330-332`). The full table is in `merchant_rules.rb:226-261`.
Related system data created at runtime (not by seeds): `Enrichment::OwnAccountMerchantSyncer` creates one merchant per synced account
`own_account_<first 8 chars of uid>` "Own account (<bank> ⋯<last4>)" (kind person, default category slug `money_transfers`)
with `iban` rules on `counterparty_iban` at priority 200 (`app/services/enrichment/own_account_merchant_syncer.rb:12-107`).
Oracle: 56 merchants / 66 rules for 2 tenants [V].

### Seeders::Showcase (demo data, not production)

Deterministic (`srand(20260115)`, reference time `2026-01-15 12:00:00` Europe/Warsaw in specs). For one user it runs the two
seeders, plus: an LlmSetting (`gemini`, key `fake-gemini-key`, `gemini-2.5-flash`); two credentials "PKO BP (Showcase)" (primary)
and "Revolut (Showcase)" (SANDBOX, active, fresh RSA key); fake sessions (PKO 30 days, Revolut LT 90 days, plus one expired); 4 accounts
(PKO PLN current + savings, Revolut EUR + USD pockets sharing one IBAN); 30 PKO card debits, 6 BLIK ATM withdrawals of 200.00 PLN,
3 salary credits of 6,500.00 PLN, and 15 Revolut EUR subscriptions; connections via the real `CreateConnection`; one `transaction_sync`
run per connection; `track_cash` on with a PLN wallet and 6 cash debits; sync schedules (first enabled, daily, 08:00); hidden categories
`noise_authorizations`, `noise_adjustments_fx`. Wrapped in one transaction, it returns a Result. (`app/services/seeders/showcase.rb:47-333`;
`spec/services/seeders/showcase_spec.rb:6,13,43,54` [V])
