### U-600 BUG? MCP `transactions.list` returns 1 row when `limit` is omitted (documented default 25)
- **What is unclear:** The tool computes `limit = min(max(args[:limit].to_i, 1), 200)` and then `limit = 25 if limit.zero?`; after the clamp the value can never be zero, so an omitted/0 limit yields 1 row.
- **Evidence for / against:** `lib/mcp/tools/transactions/list.rb:29-30`; description "default 25, max 200" (`:8`); [oracle](../oracle/http/POST_mcp.json) case `tools_call:transactions.list` (no args) → `"count":1`; `oracle/server.log.txt` shows `LIMIT 1` for the MCP call. `spec/requests/mcp/tools_spec.rb:25-41` passes because it only asserts count == size.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** Fix in Kotlin: default 25 when absent or < 1, clamp to 1..200.

### U-601 BUG? MCP `merchants.list` returns 1 row when `limit` is omitted (documented default 50, description says max 100)
- **What is unclear:** Same clamp-before-zero-check defect as U-600; also the description says "max 100 rows" while the code clamps to 200.
- **Evidence for / against:** `lib/mcp/tools/merchants/list.rb:8,22-23`; [oracle](../oracle/http/POST_mcp.json) case `tools_call:merchants.list` → `"count":1`.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** Default 50, clamp 1..200, fix the description text to "max 200".

### U-602 BUG? `POST /mcp` with malformed JSON returns 500 (HTML) instead of a JSON 400
- **What is unclear:** The MCP SDK would answer `400 {"error":"Invalid JSON"}`, but the request fails in `McpController#handle` with `NoMethodError (undefined method 'each' for nil)` at the header-copy line, producing a 500 exception page (production: generic 500).
- **Evidence for / against:** [oracle](../oracle/http/POST_mcp.json) case `malformed_json` → 500 (`h1` "NoMethodError in McpController#handle"); `oracle/server.log.txt:1151`; `app/controllers/mcp_controller.rb:11-12`; SDK `parse_request_body` in `mcp-0.15.0/lib/mcp/server/transports/streamable_http_transport.rb:492-495`. Root cause (why headers are nil) not confirmed (Rails JSON params parsing of the body is a likely factor).
- **Who/what can resolve:** reading/running the controller with a debugger; product owner for the target behaviour.
- **Human question?** no
- **Proposed default:** Kotlin returns 400 `{"error":"Invalid JSON"}` (SDK behaviour); optionally a JSON-RPC parse error `-32700`.

### U-603 BUG? Analytics with `from > to` → 500 instead of 400 (API) / internal error (MCP)
- **What is unclear:** `Analytics::Period` raises `ArgumentError "from must be <= to"`, which the API maps to 500 `{"message":"ArgumentError: from must be <= to"}` (production: "Internal server error."). Applies to all five analytics endpoints and the three analytics MCP tools (which would return a JSON-RPC internal error).
- **Evidence for / against:** [oracle](../oracle/http/GET_api__version_analytics_cash_flow.json) case `from_after_to` → 500; `app/services/analytics/period.rb:19`; `app/services/analytics/filter.rb:38-40`; `lib/api/api.rb:32-40`. Other endpoints/tools [I].
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** 400 `{"message":"Invalid parameters.","details":["from must be <= to"]}`; MCP tool error `isError: true`.

### U-604 BUG? Merchant `default_category_id` accepts another tenant's category (API + MCP)
- **What is unclear:** `POST /api/v1/merchants` / `PATCH /api/v1/merchants/:id` and MCP `merchants.create`/`merchants.update` store any category id; the response then embeds the other tenant's category (name, slug, path, colour) in `default_category`, and the foreign category would drive effective categorisation.
- **Evidence for / against:** [oracle](../oracle/http/POST_api__version_merchants.json) case `foreign_category` → 201 with `"default_category":{"id":119,…}` (119 belongs to tenant "other", `oracle/fixture.json`); `app/services/merchants/creator.rb:72-85`; `lib/api/resources/merchants.rb:80-84` (no scoping). Whether the model has any ownership validation: none observed.
- **Who/what can resolve:** product owner / security review.
- **Human question?** yes
- **Proposed default:** Reject foreign/unknown ids with 422 (`"Default category must exist"`-style message) or 404; never expose another tenant's category.

### U-605 BUG? `POST /api/v1/transaction_syncs` silently widens a foreign/inactive `bank_connection_id` to "all connections" and accepts `date_to < date_from`
- **What is unclear:** `TransactionSyncs::Queuer#resolve_subject` falls back to the user when the connection is not found among the user's active connections; inverted ranges are stored as-is. Same for MCP `transaction_syncs.create`.
- **Evidence for / against:** [oracle](../oracle/http/POST_api__version_transaction_syncs.json) cases `other_tenant_connection` → 201 with `"subject_type":"User"`, `date_to_before_from` → 201; `app/services/transaction_syncs/queuer.rb:44-47`. What the job does with an inverted range is documented by the sync writer.
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** 404 for a foreign/unknown connection id, 422 for an inactive one, 400 for `date_to < date_from`.

### U-606 404 error messages leak internal SQL fragments
- **What is unclear:** RecordNotFound messages are returned verbatim, e.g. `"Couldn't find Category with 'id'=119 [WHERE \"categories\".\"user_id\" = $1]"`, including table/column names. Should Kotlin reproduce these strings?
- **Evidence for / against:** `lib/api/api.rb:12-14`; oracle `other_tenant_id` cases (e.g. [GET_api__version_categories__id.json](../oracle/http/GET_api__version_categories__id.json)). Specs only assert the presence of `message` (`spec/requests/api/v1/cross_cutting_spec.rb:22-31`).
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (migration choice)
- **Proposed default:** Keep the `{"message": …}` envelope and status, but use a neutral message `"Couldn't find <Model> with 'id'=<id>"` without the WHERE clause.

### U-607 Merchant `source` filter enum excludes `system`, the value used by seeded merchants
- **What is unclear:** API `GET /api/v1/merchants?source=` allows only `user|llm|seed` (400 otherwise) and the entity doc says "user / llm / seed", but seeded merchants have `source "system"`; `source=seed` matches nothing. MCP `merchants.list` allows `system`.
- **Evidence for / against:** `lib/api/resources/merchants.rb:13`; `lib/api/entities/merchant.rb:9`; `lib/mcp/tools/merchants/list.rb:13`; [oracle](../oracle/http/GET_api__version_merchants.json) `default` rows `"source":"system"`, `filtered` (`source=seed`) → empty. Model enum owned by the models doc.
- **Who/what can resolve:** product owner / models doc writer.
- **Human question?** yes
- **Proposed default:** Accept the model's full source set (`user|llm|seed|system`) in the API filter.

### U-608 Swagger `info.version` is "0.0.1" although configured as "1.0.0"
- **What is unclear:** grape-swagger ignores `info.version` and uses its `doc_version` default.
- **Evidence for / against:** `lib/api/api.rb:65-69`; [oracle](../oracle/http/GET_api__version_swagger_doc.json) `"version":"0.0.1"`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** Publish `1.0.0` in the Kotlin OpenAPI document.

### U-609 Unmatched `/api/...` paths return Rails HTML 404, not JSON
- **What is unclear:** Unknown paths, non-integer `:id`s and unknown versions fall through Grape to Rails' routing 404 (HTML; dev exception page). Should Kotlin return a JSON 404 for everything under `/api/`?
- **Evidence for / against:** [oracle](../oracle/http/GET_api__version_merchants.json) `unknown_api_path_404` → 404 HTML; [oracle](../oracle/http/GET_api__version_categories__id.json) `non_integer_id` → 404 HTML; `spec/requests/api/v1/cross_cutting_spec.rb:77-84` (asserts only 404).
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** 404 with JSON `{"message":"Not Found"}` for any unmatched `/api/**` path; keep status 404.

### U-610 Pagination edge cases not guarded (negative `limit`, out-of-range `page`)
- **What is unclear:** Pagy clamps `limit` only from above (`[limit, 100].min`); a negative limit is passed to Pagy, which raises `OptionError` (→ 500 via the global handler). Page beyond the last returns an empty page.
- **Evidence for / against:** pagy 43.5.3 `lib/pagy/classes/request.rb:30-37`, `lib/pagy.rb:53-60`, `lib/pagy/modules/abilities/rangeable.rb:6-11`; not exercised by oracle/specs.
- **Who/what can resolve:** running `GET /api/v1/transactions?limit=-5`.
- **Human question?** no
- **Proposed default:** Treat `limit < 1` as default 10; page beyond range → empty `data` with correct `count/pages`.

### U-611 API `GET /api/v1/analytics/top_merchants` `limit` is unbounded (MCP clamps 1..50)
- **What is unclear:** API passes `params[:limit]` (default 10) straight to SQL `LIMIT`; huge values are allowed and negative values would raise a DB error (500). MCP clamps to 1..50.
- **Evidence for / against:** `lib/api/resources/analytics/top_merchants.rb:16,21`; `lib/mcp/tools/analytics/top_merchants.rb:24`.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** Clamp to 1..50 in both surfaces.

### U-612 Analytics ignore a single date bound
- **What is unclear:** `from`/`to` are applied only when both are present; a request with only `from` (or only `to`) silently returns month-to-date data.
- **Evidence for / against:** `app/services/analytics/filter.rb:176-190`. Not exercised.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Keep behaviour for compatibility (document it), or default the missing bound (`to` = today, `from` = first of `to`'s month).

### U-613 POST action endpoints return 201 Created although nothing is created
- **What is unclear:** Grape's POST default (201) applies to `/archive`, `/unarchive`, `/approve`, `/refresh*`, `/make_primary`, `/test_connection`, `/classification`. Clients may depend on it.
- **Evidence for / against:** oracle `default` cases of those endpoints → 201; specs accept 200 or 201 (e.g. `spec/requests/api/v1/banking_spec.rb:81,207`, `categorization_spec.rb:109`, `transactions_spec.rb:208`).
- **Who/what can resolve:** product owner / API consumers.
- **Human question?** yes (migration choice)
- **Proposed default:** Keep 201 for wire compatibility.

### U-614 MCP tools crash (JSON-RPC internal error) on unexpected argument keys
- **What is unclear:** `cash.create_transaction`, `cash.update_transaction`, `transaction_syncs.create` pass `**args` into keyword Structs (unknown key → `ArgumentError`), and `merchants.create/update`, `categories.create/update` pass args into model attributes (unknown attribute → `ActiveModel::UnknownAttributeError`). The input schemas do not set `additionalProperties: false`, so such calls pass schema validation and fail as JSON-RPC errors instead of `isError` tool results.
- **Evidence for / against:** `lib/mcp/tools/cash/create_transaction.rb:29`, `cash/update_transaction.rb:33`, `operations/queue_transaction_sync.rb:22`, `merchants/create.rb:24`, `merchants/update.rb:28`, `categories/create.rb:26-30`; SDK `server.rb:596-601`. Not exercised.
- **Who/what can resolve:** running a `tools/call` with an extra key.
- **Human question?** no
- **Proposed default:** Ignore unknown keys (or return an `isError` result "Unknown argument: <key>").

### U-615 409 StaleObjectError mapping is unreachable
- **What is unclear:** The API maps `ActiveRecord::StaleObjectError` to 409 `{"message":"Resource was modified by another request, try again."}`, but no table has a `lock_version` column, so optimistic locking never triggers.
- **Evidence for / against:** `lib/api/api.rb:20-22`; `inventory/schema.rb` (no `lock_version`); no spec references it.
- **Who/what can resolve:** product owner.
- **Human question?** no
- **Proposed default:** Keep the 409 mapping and message for any future optimistic-locking conflict; no locking columns required.

### U-616 Category PATCH cannot move a category to the top level
- **What is unclear:** `Categories::Mover` only recomputes the path when `parent_path` is present; sending `""`/null leaves the category under its current parent, though the Swagger param description for create says "null/empty = top-level".
- **Evidence for / against:** `app/services/categories/mover.rb:23-31`; `lib/api/resources/categories.rb:32,74`. Not exercised.
- **Who/what can resolve:** product owner.
- **Human question?** yes (intent)
- **Proposed default:** Keep current behaviour (blank = no move); document it.

### U-617 Swagger UI page depends on the public unpkg CDN
- **What is unclear:** `GET /api/:version/docs` loads `swagger-ui-dist@5` (floating major version) from `https://unpkg.com`; self-hosted/offline deployments get a blank page, and the floating version is a supply-chain risk.
- **Evidence for / against:** `app/views/swagger/index.html.erb:7,11`; ADR 0014 self-hosted deployment (`docs/adr/0014-self-hosted-deployment.md`).
- **Who/what can resolve:** product owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Bundle a pinned Swagger UI with the Kotlin service.
