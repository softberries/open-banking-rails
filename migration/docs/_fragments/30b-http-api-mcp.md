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
