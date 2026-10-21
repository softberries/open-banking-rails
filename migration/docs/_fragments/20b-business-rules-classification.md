## Part B — Categories, merchants, rules, enrichment, LLM

Scope: the category taxonomy, merchants, merchant rules (the "matching engine"), transaction enrichment (classification of
every ledger row), the counterparty resolver, the LLM merchant-suggestion pipeline, LLM provider settings, and the seeders
that build the baseline taxonomy and the showcase data set.

Conventions used below:

- Paths are relative to the source checkout `src/` (commit `cd3bf605…`).
- "Spec" references are `spec/…_spec.rb:LINE` ids from `inventory/specs.json`. All 825 examples passed in `inventory/specs_run.json`,
  so a rule asserted by a cited spec is **[V]**.
- Oracle links are relative to `docs/`. The oracle ran as RAILS_ENV=development with two tenants seeded by `Seeders::Showcase`
  and with in-memory fakes for the external systems.
- Time: no `config.time_zone` is set, so the app zone is **UTC**. `Time.current` timestamps (`approved_at`, `enriched_at`, `archived_at`, `sent_at`)
  are UTC. The one exception is `Seeders::Showcase`, which wraps itself in `Time.use_zone("Europe/Warsaw")` (`app/services/seeders/showcase.rb:52`). Evidence that it is UTC: the oracle's
  connection-test prompt was `ping sent_at=2026-10-21T12:52:12Z` ([oracle](../oracle/operation_runs_after_capture.jsonl) run id 14) **[V]**.
- Money does not appear in classification rules. Classification never reads amounts (see BR-255).

---

### BR-200 Three-layer category model

- **Rule:** Classification uses three independent layers:
  1. **Layer 1 – `Category`** (one row per user): a hierarchical position (PostgreSQL `ltree` `path`, e.g. `food.cooking.supermarket`), an analytic role (`kind`), and the `essential` (need-vs-want) boolean. Categories can be soft-deleted with `archived_at`.
  2. **Layer 2 – per-transaction facets on `TransactionEnrichment`.** ADR 0010 says these are `recurring` + `recurrence_interval`, but **those columns do not exist** in the schema at this commit (see U-314).
  3. **Layer 3 – free-form tags** (gutentag) on `TransactionEnrichment`.

  `path` is the source of truth for the hierarchy. A rename changes `name` only.
- **Evidence:** `docs/adr/0010-three-layer-category-model.md:18-40`; `app/models/category.rb:34-37`; `app/models/transaction_enrichment.rb:42` (gutentag); `inventory/schema.rb` (no `recurring` column); `inventory/views_sql/ledger_entries_v04.sql:9-11`.
- **Status:** [I] for the layer split. Columns verified against `inventory/schema.rb`.
- **Covered by:** `spec/models/ledger_entry_spec.rb:209` mirrors category_path to the resolved category's ltree path; `spec/models/ledger_entry_spec.rb:285` re-categorizes rows on the fly when a Category's kind changes (no re-enrichment).

### BR-201 Category kinds

- **Rule:** `kind` ∈ {`expense`, `income`, `transfer`, `savings`, `ignored`}. The default for a new category is `expense` (DB default; the admin "new" form also preselects `expense`). Analytics must partition by `kind` before summing. Changing a category's `kind` re-classifies every row that resolves to it on the next query, with no re-enrichment. Any other value fails validation with `Kind is not included in the list`. The API/HTML returns 422 for it.
- **Evidence:** `app/models/category.rb:39,55`; `app/controllers/admin/categories_controller.rb:13`; AGENTS.md "Always partition by `Category#kind`"; ADR 0010:32-34.
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:135` rejects a kind value outside the canonical list and accepts every member of KINDS; `spec/models/ledger_entry_spec.rb:285`. [oracle](../oracle/http/PUT_admin_categories__id.json) case `invalid_kind` (`kind=luxury`) → 422.

### BR-202 Category field validations (exact messages)

- **Rule:** On save:
  - `name` is required → `Name can't be blank`.
  - `slug` is required and must match `^[a-z0-9_\-]+$` → `Slug must be lowercase letters, digits, underscores, dashes`.
  - `path` is required and must match `^[a-z0-9_]+(\.[a-z0-9_]+)*$` (lowercase ltree labels joined by `.`) → `Path must be lowercase letters, digits, underscores, dot-separated`. Dashes are allowed in a slug but **not** in a path label, so a slug containing `-` can never be composed into a valid path.
  - `kind` must be in KINDS (BR-201).
  - Optional attributes: `color` (free string token, e.g. `emerald`), `icon` (icon file name), `position` (integer, default 0, "Lower = higher on the list within its level"), `essential` (default false).
  - The admin form permits exactly `name slug parent_path kind color icon position essential`.
- **Evidence:** `app/models/category.rb:46,52-57`; `app/controllers/admin/categories_controller.rb:80-82`; `app/views/admin/categories/_form.html.erb:15-60`.
- **Status:** [V] for the name and slug-format messages. [I] for the others.
- **Covered by:** `spec/models/category_spec.rb:36` rejects slug values that violate the format; `spec/system/settings_change_spec.rb:86` blank name → 422 with "can't be blank"; `spec/system/settings_change_spec.rb:99` renders a friendly 422 instead of a 500 when the slug fails its format; `spec/requests/categorization_spec.rb:47`. [oracle](../oracle/http/POST_admin_categories.json) case `invalid_blank_name` → 422 re-rendering "New category".

### BR-203 Slug and path uniqueness per user

- **Rule:** `slug` is unique per user (`Slug has already been taken`). `path` is unique per user (`Path has already been taken`). Both have DB unique indexes on `(user_id, slug)` and `(user_id, path)`. The path uniqueness check runs **only when the path matches the ltree format**. Otherwise only the format error is reported: a malformed value would make the uniqueness SELECT fail with a PG syntax error, which would surface as a 500 instead of a 422. Different users may hold identical slugs and paths. Slug uniqueness is tree-wide, not per parent: `food.other` and `income.other` cannot both have slug `other`.
- **Evidence:** `app/models/category.rb:41-58,131-133`; `app/models/category.rb:26-27` (indexes).
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:52` scopes slug uniqueness per user; `spec/models/category_spec.rb:63` scopes path uniqueness per user; `spec/services/categories/creator_spec.rb:47`; `spec/system/settings_change_spec.rb:99`.

### BR-204 Slug back-fill from path; slug and path leaf are independent

- **Rule:** Before validation, if `path` is present and `slug` is blank, `slug` is set to the last `.`-segment of `path`. If `slug` is present and differs from the last segment, **nothing is changed**. Slug and path leaf can therefore diverge. They always diverge for seeded categories: slug `food_cooking_supermarket` vs leaf `supermarket` (BR-213). `slug` is the stable identifier used in URLs such as `/admin/analytics/categories/:slug`. `path` is the hierarchy.
- **Evidence:** `app/models/category.rb:60,135-140`; `app/services/seeders/categories.rb:178`; `app/views/admin/shared/components/_category_breadcrumb.html.erb:17`.
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:76` fills slug from the last segment of path when slug is blank, and leaves an explicit slug alone.

<a id="br-205"></a>
### BR-205 Creating a category (slug generation, path composition)

- **Rule:** Inputs: `attributes` (name, slug, kind, color, icon, position, essential) and an optional `parent_path`.
  1. If `slug` is **nil**, it is generated from `name`:
     - lowercase;
     - remove combining marks (`\p{M}`). There is **no** Unicode decomposition first, so precomposed letters such as `ż`, `ó`, `ł`, `é` are *not* reduced to ASCII;
     - replace every run of characters outside `[a-z0-9]` with `_`;
     - collapse `__+` to `_`;
     - trim a leading or trailing `_`.

     Examples (pure-Ruby evaluation of the same expression): `Mobilność` → `mobilno`, `Café Nero` → `caf_nero`, `Łódź Kebab` → `d_kebab`, `Москва` → `""` (see U-305).
  2. Collision numbering: if the user already has that slug, try `<base>_2`, `<base>_3`, … until one is free. The check covers archived categories too.
  3. `path` = `slug` when `parent_path` is blank, else `"<parent_path>.<slug>"`.
  4. Save. Success → `Result(success?: true, category)`. Failure → `Result(success?: false, category, error_messages = full messages)`.

  The parent path is **not** checked for existence or archived state. A non-existent parent produces an orphan path that is valid as far as the server is concerned [I].

  Because the admin form always submits `category[slug]`, a blank form field arrives as `""` (not nil) and skips generation. The resulting create fails validation (see U-301) [I].
- **Evidence:** `app/services/categories/creator.rb:19-52`; `app/views/admin/categories/_form.html.erb:21-25`.
- **Status:** [V] for generation, numbering and composition. [I] for the blank-string form path and the orphan parent.
- **Covered by:** `spec/services/categories/creator_spec.rb:6` creates a root category, deriving the slug from the name; `spec/services/categories/creator_spec.rb:17` creates a child under parent_path; `spec/services/categories/creator_spec.rb:28` auto-numbers a slug collision (groceries → groceries_2); `spec/services/categories/creator_spec.rb:39` blank name → failure; `spec/requests/api/v1/categorization_spec.rb:34`; `spec/requests/mcp/tools_spec.rb:43`. [oracle](../oracle/http/POST_admin_categories.json) case `default` (`name="Oracle UI Category"`, `parent_path=food`, no slug key) → 302 to `/admin/categories`. The server log shows the created path `food.oracle_ui_category` (`../oracle/server.log.txt` around line 16560).
- **Admin UI:** success → redirect `/admin/categories` with notice `Category created.`. Failure → re-render "New category" with 422 (`app/controllers/admin/categories_controller.rb:17-31`).

<a id="br-206"></a>
### BR-206 Updating / moving a category (descendant path rewrite)

- **Rule:** Inputs: the category, `attributes`, and an optional `parent_path`.
  - If `parent_path` is **present**, a candidate path `"<parent_path>.<slug>"` is built. `slug` is the new slug if submitted, else the current one. The candidate is assigned to `path` only if it matches the ltree format. Otherwise `path` is left unchanged and the slug-format error is reported.
  - The update runs inside one DB transaction. If the save succeeds **and** `path` actually changed, every descendant of the old path in the *same user's* tree (`path <@ old AND path != old`) is rewritten with a single UPDATE to `new_path || subpath(path, nlevel(old_path))`.
  - No path change (same parent) → no descendant rewrite. A validation failure → no rewrite and `Result(success?: false, error_messages)`.
  - If `parent_path` is **blank**, the path is never recomputed. Consequences:
    - choosing "- top-level (new root) -" in the form does **not** move the category to the root;
    - changing only the slug leaves the path leaf unchanged.
  - The server does not prevent moving a category under its own descendant (the form hides those options, the API does not) (U-302).
- **Evidence:** `app/services/categories/mover.rb:23-62`; `app/views/admin/categories/_form.html.erb:3-9,28-35`.
- **Status:** [V] for the move and rewrite behaviour. [I] for the root-move and cycle gaps.
- **Covered by:** `spec/services/categories/mover_spec.rb:14` moves a leaf; `:26` moves an entire subtree with one UPDATE; `:39` same-parent move is a no-op; `:50` no rewrite on validation failure; `:61` scopes the descendant rewrite to the moving category's user; `spec/requests/api/v1/categorization_spec.rb:68`. [oracle](../oracle/http/PATCH_admin_categories__id.json) case `default` → 302. [oracle](../oracle/http/PUT_admin_categories__id.json) `invalid_kind` → 422.
- **Admin UI:** success → `/admin/categories` with notice `Category updated.`. Failure → re-render edit with 422.

<a id="br-207"></a>
### BR-207 Tree navigation helpers (and their missing tenant scope)

- **Rule:** Definitions:
  - depth = number of `.` in path; a root has depth 0;
  - `self_and_descendants` = `path <@ P`;
  - `descendants` = `path <@ P AND path != P`;
  - `children` = `path ~ 'P.*{1}'`;
  - `ancestors` = `path @> P AND path != P`;
  - `parent` = the category whose path is P without its last label;
  - breadcrumb = ancestors ordered by `nlevel(path)` + self, names joined with ` / `;
  - `under_path(x)` accepts a Category, a path string, or an array of both, and returns the OR of `path <@ x`. An empty input returns nothing.

  **These helpers are not scoped to the user.** They query the whole `categories` table. With two tenants holding the same seeded tree, every breadcrumb shows each ancestor twice ("Jedzenie / Jedzenie / W domu / W domu / Supermarkety"), and `in_use?` (BR-209) sees other tenants' descendants. A Kotlin rebuild must scope these queries by `user_id` (U-300).
- **Evidence:** `app/models/category.rb:70-119`. SQL in `../oracle/server.log.txt`: `SELECT 1 … FROM "categories" WHERE (path <@ 'food.oracle_ui_category' AND path != …)` with no `user_id` predicate.
- **Status:** [V] (oracle).
- **Covered by:** `spec/models/category_spec.rb:103` exposes ltree helpers over a 3-level tree (single user); `spec/models/category_spec.rb:119` under_path. Cross-tenant behaviour is untested. Oracle: [merchant show](../oracle/ui/admin_merchants_show.html) shows `Jedzenie / Jedzenie / W domu / W domu / Supermarkety`, and [merchants index](../oracle/ui/admin_merchants_index.html) shows the same pattern.

### BR-208 Archive and unarchive a category

- **Rule:**
  - `archive` sets `archived_at = now` only if not already archived. It is idempotent: a second call keeps the original timestamp.
  - `unarchive` sets `archived_at = NULL`.
  - Neither cascades to descendants.
  - Archiving keeps every existing link (merchant defaults, enrichment overrides). Analytics continue to attribute spend to an archived category.
- **Evidence:** `app/models/category.rb:76-81`; `app/controllers/admin/categories_controller.rb:64-72`.
- **Status:** [V]
- **Covered by:** `spec/models/category_spec.rb:88` archive! is idempotent; `spec/requests/categorization_spec.rb:150` and `:161`; `spec/requests/api/v1/categorization_spec.rb:102`; `spec/system/settings_change_spec.rb:55` keeps an archived category attributing spend to the same enrichment rows in analytics. Oracle: [archive](../oracle/http/POST_admin_categories__id_archive.json) → 302, [unarchive](../oracle/http/POST_admin_categories__id_unarchive.json) → 302.
- **Admin UI:** notices `Category archived.` and `Category restored.`. Both redirect to `/admin/categories`.

### BR-209 Deleting a category

- **Rule:** A category may be hard-deleted only if it is **not in use**. In use means any of:
  - it has descendants (unscoped across tenants, BR-207);
  - a merchant has it as `default_category`;
  - an enrichment has it as explicit `category`.

  If in use → no change and redirect to `/admin/categories` with alert `Can't delete - this category is in use or has sub-categories. Archive it instead.`. Otherwise it is destroyed: merchant defaults and enrichment categories referencing it are nullified (no-ops given the guard), with notice `Category deleted.`.

  `user_hidden_categories` rows are not considered and have no dependent rule. Deleting an otherwise unused category that the user has marked hidden would hit the FK `user_hidden_categories.category_id → categories.id` (U-303) [I].
- **Evidence:** `app/models/category.rb:49-50,112-114`; `app/controllers/admin/categories_controller.rb:54-62`; `app/models/user_hidden_category.rb:19-22`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:125` refuses an in-use category and keeps the row; `:138` deletes an unused category; `spec/requests/api/v1/categorization_spec.rb:79,91`. [oracle](../oracle/http/DELETE_admin_categories__id.json) `default` → 302 (the log shows the three in_use checks, then `DELETE FROM "categories" WHERE id = 239`), and `other_tenant_id` → 404.

### BR-210 Where archived categories appear

- **Rule:** Archived categories are excluded from:
  - the main table on `/admin/categories` (they appear in a separate "Archived" card with a Restore button);
  - every category picker (`_category_picker`, the classify modal, the parent-path select);
  - the LLM prompt's list of category paths (BR-255).

  They remain resolvable by path for LLM suggestions (BR-261) and as fallback targets (BR-234). The API lists only active categories unless `include_archived=true`.
- **Evidence:** `app/controllers/admin/categories_controller.rb:8-9`; `app/views/admin/categories/index.html.erb:75-95`; `app/views/admin/shared/components/_category_picker.html.erb:4`; `app/views/admin/bank_transactions/_classify_modal.html.erb:16`; `app/views/admin/categories/_form.html.erb:5`; `app/services/llm/merchant_suggester.rb:210`; `lib/api/resources/categories.rb:12-16`.
- **Status:** [V] for the API flag. [I] for the views.
- **Covered by:** `spec/requests/api/v1/categorization_spec.rb:6`, `:22`; `spec/requests/categorization_spec.rb:6`.

<a id="br-211"></a>
### BR-211 Hidden categories: definition and settings

- **Rule:**
  - A user marks specific categories as hidden. These are `user_hidden_categories` rows, unique per (user, category). A duplicate fails with `Category has already been taken`.
  - Hiding is **subtree-aware**: hiding `food` hides every category whose path is under any hidden path. The hidden set is computed per request as category ids with `path <@ any hidden path`, scoped to the user's own categories.
  - If the user flag `reveal_hidden_categories` is true, nothing is hidden. `hides_category?` returns false for every input, including blank.
  - The preferences "App" form (`PATCH /admin/settings/preferences/app`) permits `track_cash`, `reveal_hidden_categories` and `hidden_category_ids[]`. An omitted multi-select is coerced to `[]`, which clears all hidden categories. Ids are not restricted to the user's own categories. A foreign id creates an ineffective row, and an unknown id gives a 404 (U-320) [I].
  - This is independent of the cookie-based privacy mode.
- **Evidence:** `app/models/user.rb:46-66`; `app/models/user_hidden_category.rb:24-32`; `app/controllers/admin/settings/preferences_controller.rb:107-114`.
- **Status:** [V]
- **Covered by:** `spec/models/user_spec.rb:27` true for hides_category? on every descendant of an explicitly hidden parent; `spec/models/user_spec.rb:43`; `spec/models/user_hidden_category_spec.rb:27`, `:37`; `spec/requests/settings_spec.rb:116` forces hidden_category_ids to [] when the multi-select is omitted. [oracle](../oracle/http/PATCH_admin_settings_preferences_app.json) → 302.

### BR-212 Hidden categories: effect on screens

- **Rule:** When `hides_category?(category)` is true:
  - **Masking.** Names and paths are masked server-side; the real value never reaches the HTML.
    - Text masking replaces a value with `•` × min(length, 24). Blank values stay blank. A caller-supplied fixed mask (used for amounts) replaces the value entirely.
    - Breadcrumbs render `•••` and are not linked.
    - In the classify modal, merchants whose default category is hidden show as `•••`, as do hidden categories.
  - **Pickers.** Hidden categories are omitted from the category picker and from the parent-path select.
  - **Redirects.**
    - `GET /admin/categories/:id/edit` redirects to `/admin/categories` with alert `This category is private. Remove it from the hidden list in preferences to edit it.`
    - `GET /admin/merchants/:id` where the merchant's default category is hidden redirects to `/admin/merchants` with alert `This merchant is in a hidden category. Remove it from the hidden list in preferences to open it.`
    - `GET /admin/bank_transactions/:id` whose effective category is hidden redirects with alert `This transaction is in a hidden category. Remove it from the hidden list in preferences to open it.`
  - **Merchant edit is not guarded.** The intended redirect for `GET /admin/merchants/:id/edit` (alert `…to edit it.`) is dead code. `MerchantsController` defines `edit` twice and the later empty definition wins, so the edit page renders (U-304) [I].
- **Evidence:** `app/helpers/admin/hide_private_helper.rb:6-21`; `app/views/admin/shared/components/_category_breadcrumb.html.erb:4-6`; `app/views/admin/bank_transactions/_classify_modal.html.erb:7-18`; `app/views/admin/shared/components/_category_picker.html.erb:6`; `app/controllers/admin/categories_controller.rb:33-38`; `app/controllers/admin/merchants_controller.rb:20-25,37-42,58-59`; `app/controllers/admin/bank_transactions_controller.rb:31-35`.
- **Status:** [V] for the category edit and merchant show redirects. [I] for the rest.
- **Covered by:** `spec/requests/categorization_spec.rb:82` edit redirects when the category is hidden; `spec/requests/categorization_spec.rb:231` merchant show redirects when the default category is hidden.

<a id="br-213"></a>
### BR-213 Baseline taxonomy (`Seeders::Categories`)

- **Rule:**
  - Creates or updates **118** categories for a user: 10 roots, 30 depth-1 nodes, 78 depth-2 leaves. The full list is in `DEFINITIONS`, with Polish names, `kind` and `essential` per row.
  - Each row is keyed on `slug = path with '.' replaced by '_'` (e.g. `food.cooking.supermarket` → `food_cooking_supermarket`).
  - Every run assigns `name`, `kind`, `essential` (default false), `path`, `position` = index in `DEFINITIONS` (0-based), `icon` (only roots carry one) and `color` = palette by root domain:

    | Domain | Color |
    |---|---|
    | food | emerald |
    | mobility | blue |
    | home | amber |
    | health | rose |
    | lifestyle | violet |
    | education | indigo |
    | services | slate |
    | income | green |
    | money | gray |
    | noise | zinc |

  - Root kinds:
    - `food`, `mobility`, `home`, `health`, `lifestyle`, `education`, `services` are `expense`;
    - `income` is `income`;
    - `money` is `transfer`, except `money.savings.*` and `money.investments.*`, which are `savings`;
    - `noise` is `ignored`. `noise.unmatched.*` is however `expense` ("real spend without a known merchant"). `noise.authorizations.*` and `noise.adjustments.*` remain `ignored`.
  - Idempotent: it never deletes and never duplicates. A re-run **overwrites** user edits to those attributes on seeded rows (U-315).
  - Callers: first-run setup, `POST /admin/onboarding/seed_taxonomy`, `Seeders::Showcase`.
- **Evidence:** `app/services/seeders/categories.rb:6-192`; `app/controllers/setup_controller.rb:18`; `app/controllers/admin/onboarding_controller.rb:9`.
- **Status:** [V]
- **Covered by:** `spec/services/seeders/categories_spec.rb:6` seeds the full category tree on first run; `:18` is idempotent; `:31` scopes per user.

### BR-214 Onboarding "load baseline taxonomy"

- **Rule:** `POST /admin/onboarding/seed_taxonomy` (signed-in user only):
  1. runs `Seeders::Categories` then `Seeders::MerchantRules` for the current user only;
  2. runs a full re-enrichment rebuild (BR-235);
  3. redirects back to the Referer (fallback `/admin`) with notice `Baseline taxonomy loaded - <N> categories, <M> system merchants. Existing transactions reclassified.`, where N = the user's total category count and M = the user's merchants with `source = system`.

  Anonymous users are redirected to sign-in. The AI Enrichment page offers this action ("Load baseline taxonomy") when the user has no active categories.
- **Evidence:** `app/controllers/admin/onboarding_controller.rb:8-15`; `app/views/admin/llm_enrichments/index.html.erb:6-13`.
- **Status:** [V]
- **Covered by:** `spec/requests/onboarding_spec.rb:6`, `:22` honors the Referer header, `:34` passes only the current user, `:49` anonymous → sign-in. [oracle](../oracle/http/POST_admin_onboarding_seed_taxonomy.json) → 302 `/admin`.

---

### BR-215 Merchant attributes and validations

- **Rule:**

  | Attribute | Constraint |
  |---|---|
  | `name` | required → `Name can't be blank` |
  | `slug` | required, unique per user, format `^[a-z0-9_\-]+$` → `Slug is invalid` (default message) / `Slug has already been taken` |
  | `source` | ∈ {`system`, `user`, `llm`} |
  | `kind` | optional, ∈ {`company`, `person`, `charity`, `government`, `platform`, `other`} |
  | `confidence` | optional decimal(4,3), 0.0..1.0 inclusive |
  | other | `default_category` (optional FK), `approved_at`/`approved_by`, `archived_at`, `logo_url`, `notes`, `model` |

  - "Approved" means `approved_at` is not null. "Pending" means `source = llm AND approved_at IS NULL`.
  - The admin form permits `name slug kind default_category_id logo_url notes`.
  - Destroying a merchant destroys its rules and nullifies `transaction_enrichments.merchant_id`.
- **Evidence:** `app/models/merchant.rb:45-71`; `app/controllers/admin/merchants_controller.rb:105-107`.
- **Status:** [V]
- **Covered by:** `spec/models/merchant_spec.rb:71` slug uniqueness per user; `:82` confidence boundary; `:95` pending scope; `:106` nullifies enrichment merchant_id on destroy. [oracle](../oracle/http/POST_admin_merchants.json) `invalid_blank_name` → 422; [oracle](../oracle/http/PUT_admin_merchants__id.json) `invalid_blank_name` → 422.

### BR-216 Merchant slug generation (two algorithms)

- **Rule:**
  - **(a) Model fallback.** Used when the slug is still blank at validation. Steps: NFD-normalize, lowercase, strip combining marks, replace non-`[a-z0-9]` runs with `_`, collapse `_`, trim. If the result is empty → `merchant_<8 hex chars>` (random). Examples: `Żabka` → `zabka`, `Café Nero` → `cafe_nero`.
  - **(b) Creator, LLM runner and categories.** Same steps **without** NFD: `Żabka` → `abka`, `Łódź Kebab` → `d_kebab`.
    - `Merchants::Creator` adds collision numbering (`_2`, `_3`, …).
    - The LLM runner has no numbering. It *reuses* an existing merchant with that slug (BR-259) and falls back to `merchant_<hex>` when empty.

  A pre-set non-blank slug is never overwritten (see U-305).
- **Evidence:** `app/models/merchant.rb:83-88`; `app/services/merchants/creator.rb:35-44`; `app/services/llm/enrichment_runner.rb:179-182`.
- **Status:** [V] for (a). [I] for the (b) examples, reproduced by evaluating the same Ruby expressions in isolation.
- **Covered by:** `spec/models/merchant_spec.rb:43` auto-generates a slug, stripping diacritics; `:56` falls back to merchant_<hex>; `:64` preserves a pre-set slug; `spec/system/llm_enrichment_spec.rb:16` (LLM names `Devstyle` → `devstyle`, `P.U.N.K.T` → `p_u_n_k_t`).

<a id="br-217"></a>
### BR-217 Creating a merchant (user)

- **Rule:** `Merchants::Creator`:
  1. builds the merchant from the submitted attributes;
  2. forces `source = user`, `approved_at = now`, `approved_by = the user`;
  3. if the slug is blank, generates it with algorithm (b) and collision numbering. A base that comes out empty falls through to the model fallback `merchant_<hex>`;
  4. saves. Success → `Result(success?, merchant)`. Failure → `Result(success?: false, merchant, error_messages)`.

  A user merchant does **not** trigger re-enrichment. It only takes effect through rules (BR-224) or manual classification (BR-237).
- **Evidence:** `app/services/merchants/creator.rb:18-31`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:244`, `:259`; `spec/requests/api/v1/categorization_spec.rb:142`. [oracle](../oracle/http/POST_admin_merchants.json) `default` → 302 `/admin/merchants/60`.
- **Admin UI:** notice `Merchant created.` and redirect to the merchant page. Failure → re-render "New merchant" with 422.

### BR-218 Updating a merchant; retroactive default-category effect

- **Rule:** `PATCH /admin/merchants/:id` updates the permitted attributes.
  - A change to `default_category_id` immediately changes the effective category of **every** enrichment pointing at this merchant that has no explicit category (BR-232). This is a read-time effect, so no rebuild is needed; the change is only logged.
  - Redirect to `return_to` if it is a safe local path, else to the merchant page, with notice `Merchant updated.`.
  - Failure → re-render edit with 422.
  - Another tenant's id → 404.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:61-71`; `app/models/merchant.rb:41-43`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:273` safe return_to; `:286` hostile return_to falls back; `spec/models/concerns/ledger_entry_concern_spec.rb:46` falls back to the merchant default category. [oracle](../oracle/http/PATCH_admin_merchants__id.json) `default` → 302 and `other_tenant_id` → 404.

### BR-219 Archive and unarchive a merchant

- **Rule:**
  - Archive sets `archived_at = now` (not idempotent: it re-stamps). Notice `Merchant archived.`, redirect to `return_to` or `/admin/merchants`.
  - Unarchive clears it. Notice `Merchant restored.`, redirect to `return_to` or the merchant page.
  - Archived merchants are hidden from the merchant list unless `show_archived=1`, and from the classify modal's merchant choices.
  - **The merchant's rules keep matching**: the enricher does not filter on `merchant.archived_at` (U-310) [I].
- **Evidence:** `app/controllers/admin/merchants_controller.rb:9,83-91`; `app/controllers/admin/bank_transactions_controller.rb:38`; `app/services/enrichment/transaction_enricher.rb:135-138`.
- **Status:** [V] for archive. [I] for rule behaviour.
- **Covered by:** `spec/requests/categorization_spec.rb:324`. Oracle: [archive](../oracle/http/POST_admin_merchants__id_archive.json) → 302 `/admin/merchants`; [unarchive](../oracle/http/POST_admin_merchants__id_unarchive.json) → 302 `/admin/merchants/60`.

### BR-220 Deleting a merchant

- **Rule:** If any `transaction_enrichments.merchant_id` references the merchant → no change and redirect to the merchant page with alert `Can't delete - this merchant has linked transactions. Archive it instead.`. Otherwise destroy the merchant and its rules, then redirect to `return_to` or `/admin/merchants` with notice `Merchant deleted.`.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:73-81`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:299`, `:314`; `spec/requests/api/v1/categorization_spec.rb:174`. [oracle](../oracle/http/DELETE_admin_merchants__id.json) → 302 `/admin/merchants`.

<a id="br-221"></a>
### BR-221 Approving a merchant (LLM review queue)

- **Rule:** `Merchants::Approver` runs in one DB transaction:
  1. set `approved_at = now`, `approved_by = actor` on the merchant;
  2. for every rule of this merchant with `source = llm AND enabled = false`, set `enabled = true`, `approved_at = now`, `approved_by = actor`. Already-enabled rules are untouched.

  After commit it runs a full rebuild for the merchant's owner (BR-235), and the controller redirects to `return_to` or the merchant page with notice `Approved - historical transactions re-classified.`. Any merchant can be approved, whatever its source.
- **Evidence:** `app/services/merchants/approver.rb:14-23`; `app/controllers/admin/merchants_controller.rb:93-97`.
- **Status:** [V]
- **Covered by:** `spec/services/merchants/approver_spec.rb:6`, `:19`, `:32` idempotency on re-approval, `:44` rebuild after approval; `spec/requests/categorization_spec.rb:334`; `spec/requests/api/v1/categorization_spec.rb:187`; `spec/requests/mcp/tools_spec.rb:62`, `:77`. [oracle](../oracle/http/POST_admin_merchants__id_approve.json) → 302.

### BR-222 Merchant list filters (admin)

- **Rule:** `GET /admin/merchants` lists the current user's merchants:
  - active only, unless `show_archived=1`;
  - optional exact `source=`;
  - optional `category_id=` (exact default category, no subtree);
  - optional `q=` → `name ILIKE '%q%'` (no escaping of `%`/`_`).

  Ordered by `name`, offset-paginated. Each row shows the number of enrichments linked to the merchant.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:7-18`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:172`, `:186` filters by source, `:198` free-text q. [oracle](../oracle/http/GET_admin_merchants.json) `filtered` (`show_archived=1&source=seed&q=a`) → 200. `seed` is not a valid source, so the list is empty.

### BR-223 Merchant detail page data

- **Rule:** `GET /admin/merchants/:id`:
  - is subject to the hidden-category guard (BR-212);
  - lists the merchant's rules ordered by `source` **alphabetically** then `priority DESC`. This display order is not the matching order, although the page states "First match wins. Order: user > llm > system, then higher priority within source.";
  - shows the total linked transactions and the 10 most recent linked bank transactions by `booking_date DESC`;
  - offers a new-rule form defaulting to `field=title`, `kind=contains`.
- **Evidence:** `app/controllers/admin/merchants_controller.rb:20-35`; [oracle UI](../oracle/ui/admin_merchants_show.html).
- **Status:** [V] (oracle page).
- **Covered by:** `spec/requests/categorization_spec.rb:210`, `:220` 404 for another user's merchant. [oracle](../oracle/http/GET_admin_merchants__id.json) `other_tenant_id` → 404.

---

### BR-224 Merchant rule attributes and validations

- **Rule:**

  | Attribute | Constraint |
  |---|---|
  | `kind` | ∈ {`contains`, `regex`, `exact`, `prefix`, `iban`}. The kinds `equals`, `starts_with` and `ends_with` do **not** exist; `exact` = equals, `prefix` = starts-with, there is no ends-with |
  | `field` | ∈ {`title`, `counterparty_name`, `counterparty_iban`, `payment_method`} |
  | `source` | ∈ {`system`, `user`, `llm`} |
  | `pattern` | required → `Pattern can't be blank` |
  | `confidence` | optional, 0.0..1.0 |
  | `case_sensitive` | default false |
  | `priority` | integer, default 0 |
  | `enabled` | default true |
  | other | `approved_at`/`approved_by`, `model` |

  - For `kind = regex`, the pattern must compile → `Pattern is not a valid regex: <engine message>`. The same string is accepted for non-regex kinds.
  - Rule CRUD params permitted from the admin form: `kind field pattern case_sensitive priority enabled`.
- **Evidence:** `app/models/merchant_rule.rb:44-62,91-96`; `app/controllers/admin/merchant_rules_controller.rb:41-43`.
- **Status:** [V]
- **Covered by:** `spec/models/merchant_rule_spec.rb:83` rejects an invalid regex pattern with a :pattern error; `:109` confidence boundary. [oracle](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json) `invalid_regex` (`([`) → 302 with alert; [oracle](../oracle/http/PUT_admin_merchants__merchant_id_merchant_rules__id.json) `invalid_blank_pattern` → 302 with alert.

<a id="br-225"></a>
### BR-225 Rule matching semantics per kind

- **Rule:** `matches?(value)`:
  - A blank value (nil, empty, whitespace-only) never matches.
  - Unless `case_sensitive`, both the value and the pattern are lowercased first. This is Ruby `String#downcase`, a full Unicode lowercase mapping; a Kotlin port should use `lowercase()` with a root locale.
  - Per kind:
    - `contains` → the value contains the pattern as a substring;
    - `exact` → whole-string equality;
    - `prefix` → the value starts with the pattern;
    - `iban` → remove all whitespace from both sides, uppercase both, compare equal. `case_sensitive` is ignored;
    - `regex` → unanchored search of the pattern in the **original** value, compiled with ignore-case unless `case_sensitive`.
  - There is no trimming, accent folding or `TitleNormalizer` step: rules see the raw stored field value.
  - There is no regex timeout, so ReDoS is possible (U-313).
- **Evidence:** `app/models/merchant_rule.rb:69-89`.
- **Status:** [V] for contains, exact, iban and regex. [I] for prefix (no spec).
- **Covered by:** `spec/models/merchant_rule_spec.rb:42` contains case-insensitive by default and respects case_sensitive; `:52` iban whitespace/upcase; `:61` regex, blank value, ignorecase; `:73` exact; `spec/services/enrichment/transaction_enricher_spec.rb:43`.

<a id="br-226"></a>
### BR-226 Rule resolution order: first match wins

- **Rule:** For one user, the enricher loads **all enabled** rules of that user, across all fields, into one list sorted by:
  1. `SOURCE_RANK` DESC, with user = 2, llm = 1, system = 0 and any unknown source = −1;
  2. `priority` DESC;
  3. `id` ASC.

  For each transaction it walks the list and takes the **first** rule for which:
  - the transaction type exposes the rule's field. Polymorphic ledger types: a manual (cash) transaction lacking e.g. `counterparty_iban` counts as a non-match, not an error;
  - the field value is non-blank;
  - `matches?` is true.

  This is first-match, not best-match: a user rule on `counterparty_name` beats a system rule on `title`, whatever the priorities. Disabled rules are ignored. The rule list is loaded once per enricher instance, i.e. once per `enrich_pending`/`rebuild!` call.

  The Matching Engine page reproduces the same order in SQL: `CASE source WHEN 'user' THEN 2 WHEN 'llm' THEN 1 WHEN 'system' THEN 0 ELSE -1 END DESC, priority DESC, id ASC`.
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:4-6,133-148`; `app/models/merchant_rule.rb:50,83`; `app/controllers/admin/matching_engine_controller.rb:8-9`; ADR 0005:16-17; ADR 0002:21-23.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:14` ranks user above llm above system; `:30` tie-breaks by priority DESC then id ASC; `:54` skips a rule whose field is missing on the polymorphic enrichable; `spec/models/merchant_rule_spec.rb:95`; `spec/system/categorization_workflow_spec.rb:16`, `:103` user rule beats an LLM-source rule.

### BR-227 Priority conventions used by the system

- **Rule:** Priority values assigned by code (higher wins within a source tier):

  | Rule | Source | Priority |
  |---|---|---|
  | Seeded retail (title/counterparty contains) | system | 0 (kept on re-seed) |
  | Own-account IBAN rules | system | 200 |
  | Seeded top-up rules | system | 250 |
  | Seeded ATM rule (`payment_method exact blik_atm`) | system | 300 |
  | LLM-generated rules | llm | 50 |
  | Rule from the classify modal "create_rule" | user | 100 |
  | Rule from the merchant page form / API | user | as submitted, default 0 |

  Because source ranks first, every user rule beats every llm rule, and every llm rule beats every system rule.
- **Evidence:** `app/services/seeders/merchant_rules.rb:69,94,125`; `app/services/enrichment/own_account_merchant_syncer.rb:14`; `app/services/llm/enrichment_runner.rb:173`; `app/services/enrichment/classification_applier.rb:87`.
- **Status:** [V] for the seeded 0 and 300 values. [I] for the others.
- **Covered by:** `spec/services/seeders/merchant_rules_spec.rb:6`, `:24`.

<a id="br-228"></a>
### BR-228 Rule create, update and delete from the merchant page

- **Rule:** All under `/admin/merchants/:merchant_id/merchant_rules`. The merchant is looked up within the current user and the rule within that merchant; misses return 404.
  - **Create** (`MerchantRules::Creator`):
    - build with the permitted attributes, forcing `user = actor`, `source = user`, `approved_at = now`, `approved_by = actor`;
    - on success, run a full rebuild (BR-235). Notice `Rule added - historical transactions re-classified.`;
    - on failure, no rebuild. Alert `Could not add rule: <errors joined ", ">`.
  - **Update** (`MerchantRules::Updater`):
    - update the attributes; the source is **not** changed, so editing a system rule keeps it system;
    - success → rebuild, notice `Rule updated.`;
    - failure → no rebuild, alert `Could not update rule: <errors>`.
  - **Delete** (`MerchantRules::Destroyer`):
    - destroy the rule, which nullifies `merchant_rule_id` on enrichments;
    - always rebuild. Notice `Rule deleted - transactions re-classified.`.
  - All redirect to the merchant page.
- **Evidence:** `app/controllers/admin/merchant_rules_controller.rb:8-39`; `app/services/merchant_rules/creator.rb:19-33`; `app/services/merchant_rules/updater.rb:19-26`; `app/services/merchant_rules/destroyer.rb:14-18`.
- **Status:** [V]
- **Covered by:** `spec/services/merchant_rules/updater_spec.rb:6`, `:17` rebuild ONLY after a successful update, `:28`, `:40`; `spec/services/merchant_rules/destroyer_spec.rb:6`, `:17`; `spec/requests/categorization_spec.rb:348`, `:365` alert matches /pattern/, `:380`, `:396`; `spec/system/categorization_workflow_spec.rb:16` (flash `Rule added…re-classified`). Oracle: [create](../oracle/http/POST_admin_merchants__merchant_id_merchant_rules.json), [update](../oracle/http/PATCH_admin_merchants__merchant_id_merchant_rules__id.json), [delete](../oracle/http/DELETE_admin_merchants__merchant_id_merchant_rules__id.json) → 302 `/admin/merchants/60`.

<a id="br-229"></a>
### BR-229 Seeded merchants and rules (`Seeders::MerchantRules`)

- **Rule:** Requires the taxonomy. A missing path raises `Missing seeded category at path: <path>`. The run is idempotent.
  - **Retail:** 25 merchants, each `kind = company`, `source = system`, `approved_at` kept or set to now, `default_category` per row. Each gets one rule keyed on (field, pattern): `kind contains`, `source system`, `enabled true`, `priority` kept or 0, `case_sensitive false`. Patterns:

    | Field | Pattern | Category path |
    |---|---|---|
    | title | BIEDRONKA | food.cooking.supermarket |
    | title | LIDL | food.cooking.supermarket |
    | title | KAUFLAND | food.cooking.supermarket |
    | title | AUCHAN | food.cooking.supermarket |
    | title | ELECLERC | food.cooking.supermarket |
    | title | ZABKA | food.cooking.convenience |
    | title | SPOLEM | food.cooking.convenience |
    | title | ROSSMANN | home.variable.drugstore |
    | title | PEPCO | lifestyle.shopping.general |
    | title | TEDI | lifestyle.shopping.general |
    | title | DECATHLON | health.body.fitness |
    | title | OTCF | lifestyle.shopping.clothing |
    | title | MEDIAEXPERT | lifestyle.shopping.electronics |
    | title | DOZ APTEKA | health.medical.pharmacy |
    | title | DARA KEBAB | food.eating_out.fastfood |
    | title | DONER KING | food.eating_out.fastfood |
    | title | MCDONALD | food.eating_out.fastfood |
    | title | CAPONE | food.cooking.alcohol |
    | title | T-MOBILE POLSKA | home.fixed.telecom |
    | title | ALLEGROPAY | lifestyle.shopping.general |
    | counterparty_name | Claude.ai | lifestyle.tools.saas |
    | counterparty_name | Openai | lifestyle.tools.saas |
    | counterparty_name | Anthropic | lifestyle.tools.saas |
    | counterparty_name | Google | lifestyle.tools.cloud |
    | counterparty_name | Linkedin | lifestyle.tools.saas |

    Merchant slugs and names are in `RETAIL`.
  - **ATM:** merchant `atm_withdrawal` "ATM" (`kind other`, default `money.transfers.atm`) with rule `payment_method exact "blik_atm"`, priority 300.
  - **Top-up:** merchant `mobile_wallet_topup` "Top-up (own)" (`kind platform`, default `money.transfers.own`) with three title-contains rules at priority 250: `Google Pay Top-Up by`, `Apple Pay Top-Up by`, `Top-Up by *`. The `*` is literal, since the kind is contains.
  - A re-seed resets `enabled = true` and `case_sensitive = false` on these rules, so user edits to them are overwritten (U-315).
- **Evidence:** `app/services/seeders/merchant_rules.rb:7-130`.
- **Status:** [V]
- **Covered by:** `spec/services/seeders/merchant_rules_spec.rb:6`, `:24`, `:39`. Oracle: [merchants index](../oracle/ui/admin_merchants_index.html) shows e.g. Biedronka with 5 transactions and ATM with 6.

<a id="br-230"></a>
### BR-230 Own-account merchants (`OwnAccountMerchantSyncer`)

- **Rule:** Runs after a bank account is created or updated by connection creation and after an account-details refresh. For one bank account:
  1. Collect IBANs: the primary IBAN plus `alternate_ibans`, blanks removed, whitespace stripped, uppercased, de-duplicated. If there are none → do nothing.
  2. Resolve the owner: the credential's user, else `manual_owner_id`. If there is none, raise `BankAccount <id> has no resolvable owner`.
  3. Upsert the merchant by slug `own_account_<first 8 chars of account uid>`:
     - name `Own account (<bank name | credential name | "Bank"> ⋯<last 4 of IBAN | "????">)`;
     - `kind person`, `source system`;
     - default category = the user's category with slug `money_transfers` (path `money.transfers`, **not** `money.transfers.own`; see U-311). `find_by!` raises if the category is missing;
     - notes `Auto-generated. Matches transfers where counterparty_iban is one of <display_name>'s own IBANs.`;
     - `approved_at` kept or set to now.
  4. For each IBAN, upsert a rule `field counterparty_iban, kind iban, pattern <IBAN>` with `source system`, `enabled true`, `priority 200`, `case_sensitive false`, `approved_at` kept or set to now.
  5. Existing iban rules of that merchant whose pattern is no longer in the list are **disabled**, never deleted, because historical enrichments reference them.

  All of this runs in one DB transaction. Two accounts sharing an IBAN (multi-currency pockets) yield two merchants with identical rules; the tie goes to the lower rule id (U-323).
- **Evidence:** `app/services/enrichment/own_account_merchant_syncer.rb:12-104`; `app/services/enable_banking/operations/create_connection.rb:75`; `app/services/enable_banking/operations/refresh_account_details.rb:39`.
- **Status:** [I]
- **Covered by:** untested directly. Indirectly exercised by `spec/services/seeders/showcase_spec.rb:13` (connections created).

---

### BR-231 The enrichment record

- **Rule:**
  - **One record per ledger row.** Each ledger row (bank transaction or manual/cash transaction) has at most one `TransactionEnrichment`, linked polymorphically by `(enrichable_type, enrichable_id)` with a DB unique index. Deleting the source row deletes its enrichment.
  - **Fields:** `merchant`, `category` (the explicit override), `merchant_rule` (the rule that matched), `source`, `confidence`, `model`, `category_overridden`, `enriched_at`, `notes`, tags.
  - **`source` values:**

    | Source | Meaning |
    |---|---|
    | `unmatched` | no rule, no fallback |
    | `system_rule` | matched a system rule |
    | `user_rule` | matched a user rule, or set by "all for merchant" |
    | `llm_rule` | matched an llm rule |
    | `llm_pending` | defined, never written by current code |
    | `manual` | explicit user decision |
    | `system_fallback` | payment-method fallback category |

  - **Constraints and scopes:**
    - `confidence` must be in 0.0..1.0 or null;
    - "rebuildable" = `source != manual AND category_overridden = false`;
    - "merchantless" = `merchant_id IS NULL`, which covers both `unmatched` and `system_fallback`;
    - the per-user scope unions bank and manual transactions owned by the user.
- **Evidence:** `app/models/transaction_enrichment.rb:24,37-76`; ADR 0002.
- **Status:** [V]
- **Covered by:** `spec/models/transaction_enrichment_spec.rb:61` rebuildable scope; `:76` merchantless; `:93` for_user across both types; `:114` DB uniqueness; `:125` predicates; `spec/models/concerns/ledger_entry_concern_spec.rb:68`, `:78` enrichment destroyed with its source row.

<a id="br-232"></a>
### BR-232 Effective category resolution

- **Rule:** effective category = the enrichment's explicit `category` if set, else the merchant's `default_category`, else NULL ("uncategorized"). This is resolved at read time: in Ruby, and in SQL in the `ledger_entries` view as `COALESCE(te.category_id, m.default_category_id)`. A transaction with no enrichment has a NULL effective category. Rows with a NULL effective category do not fall into any kind-partitioned total (spend, income, …).
- **Evidence:** `app/models/transaction_enrichment.rb:70-72`; `app/models/concerns/ledger_entry_concern.rb:18-21`; `inventory/views_sql/ledger_entries_v04.sql:33,76-77`.
- **Status:** [V]
- **Covered by:** `spec/models/transaction_enrichment_spec.rb:40`; `spec/models/concerns/ledger_entry_concern_spec.rb:6`, `:19`, `:33`, `:46`, `:58`, `:89` agrees with the view across the override / merchant-default / unmatched matrix; `spec/models/ledger_entry_spec.rb:92`, `:107`, `:121`.

<a id="br-233"></a>
### BR-233 Enriching one transaction (algorithm)

- **Rule:** Given a transaction and an optional existing enrichment (otherwise the current one, otherwise a new one):
  1. If the enrichment is persisted and `source = manual` → return it unchanged.
  2. If the enrichment is persisted and `category_overridden = true` → return it unchanged.
  3. Find the first matching rule (BR-226). If one matches, set:
     - `merchant` = rule.merchant;
     - `merchant_rule` = the rule;
     - `source` = `system_rule` / `user_rule` / `llm_rule` according to rule.source;
     - `confidence` and `model` copied from the rule;
     - `category` = NULL, so the merchant default applies.
  4. Otherwise, if a fallback category exists (BR-234), set merchant, rule, confidence and model to NULL, `source = system_fallback`, and `category` = the fallback category.
  5. Otherwise set everything to NULL with `source = unmatched`.
  6. Set `enriched_at = now` and save. A validation error raises.
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:96-129`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:67` payment_method fallback; `:89` unmatched; `:100` manual wins; `:113` category_overridden wins; `spec/system/categorization_workflow_spec.rb:57` preserves a manual override when an unrelated user rule fires a rebuild.

<a id="br-234"></a>
### BR-234 Payment-method / direction fallback table

- **Rule:** Used only when no rule matches. Lookup:
  1. first `(direction, payment_method, counterparty_kind)` in the identity-aware table;
  2. else `(direction, payment_method)` in the plain table;
  3. the resulting path must exist in the user's categories; archived categories count. Otherwise → `unmatched`.

  A transaction type without `counterparty_kind` uses `""`, which matches no identity key.

  Identity-aware table (`unknown` behaves like `external`):

  | direction | payment_method | self | external / unknown |
  |---|---|---|---|
  | debit | blik_p2p | money.transfers.own | noise.unmatched.other |
  | debit | transfer | money.transfers.own | noise.unmatched.other |
  | credit | blik_p2p | money.transfers.own | income.refunds.refunds |
  | credit | transfer | money.transfers.own | income.work.salary |

  Plain table:

  | direction | payment_method | path |
  |---|---|---|
  | debit | blik_pos | noise.unmatched.blik |
  | debit | blik_atm | money.transfers.atm |
  | debit | card | noise.unmatched.card |
  | debit | card_authorization | noise.authorizations.card |
  | debit | internal_transfer | money.transfers.own |
  | debit | topup | money.transfers.own |
  | debit | fee | services.financial.fees |
  | debit | cash | noise.unmatched.cash |
  | debit | cash_atm_topup | money.transfers.atm |
  | debit | cash_deposit | money.transfers.own |
  | debit | cash_fx_conversion | noise.adjustments.fx |
  | debit | cash_adjustment | noise.adjustments.cash |
  | credit | internal_transfer | money.transfers.own |
  | credit | topup | money.transfers.own |
  | credit | card | income.refunds.refunds |
  | credit | blik_atm | money.transfers.atm |
  | credit | cash | income.other.sale |
  | credit | cash_atm_topup | money.transfers.atm |
  | credit | cash_deposit | money.transfers.own |
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:20-64,150-163`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:67`, `:77` identity-aware fallback over the plain table.

<a id="br-235"></a>
### BR-235 When enrichment runs: `enrich_pending` vs `rebuild!`

- **Rule:**
  - **`enrich_pending(user, scope?)`** enriches transactions that have **no** enrichment yet. The default scope is the user's bank transactions without an enrichment. It returns the count processed. It is called by the transaction-sync job after each successful sync, scoped to the run's transactions. Failures there are logged and swallowed.
  - **`rebuild!(user, scope?)`** re-evaluates the user's **rebuildable** enrichments (not manual, not overridden) for both ledger types. Orphans whose source row is missing are skipped. Transactions with no enrichment row are **not** touched. The user parameter is mandatory; there is no cross-tenant rebuild.
  - Rebuild triggers:
    - rule create, update or delete;
    - merchant approval;
    - classification `create_rule`;
    - an LLM run with ≥ 1 auto-applied suggestion;
    - onboarding seed;
    - showcase seeding;
    - a rake task in `lib/tasks/banking.rake`.
  - Both run synchronously in the caller (request thread or job).
- **Evidence:** `app/services/enrichment/transaction_enricher.rb:66-88`; `app/jobs/transaction_sync_job.rb:49-59`; `lib/tasks/banking.rake:79`; call sites listed in the BR ids above.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/transaction_enricher_spec.rb:128` rebuild! re-evaluates non-manual non-overridden rows only; `:149` enrich_pending writes one enrichment per scoped transaction and returns the count.

<a id="br-236"></a>
### BR-236 Counterparty resolver (self / external / unknown)

- **Rule:** Computed and stored on each transaction at **sync/save time**, not at enrichment time, as `counterparty_kind`. Inputs: `payment_method`, `counterparty_iban`, `counterparty_name`, user. First hit wins:
  1. `payment_method` ∈ {`internal_transfer`, `topup`, `cash_atm_topup`, `cash_deposit`, `cash_fx_conversion`, `cash_adjustment`} → `self`.
  2. Normalize IBAN = remove whitespace and uppercase; normalize name = trim and uppercase. Blank → absent.
  3. Both absent → `unknown`.
  4. IBAN ∈ the user's own IBANs → `self`. Own IBANs are every primary and alternate IBAN of every account the user owns (synced or cash), normalized the same way.
  5. Name ∈ the user's own holder names → `self`. Holder names are the normalized `name` of every owned account.
  6. Otherwise `external`.

  Name matching can produce false positives on common names; a per-transaction override always wins. Used by the fallback table (BR-234) and by LLM eligibility (BR-250).
- **Evidence:** `app/services/banking/counterparty_resolver.rb:4-62`; `app/models/user.rb:80-94`; `app/services/enable_banking/operations/sync_account_transactions.rb:58-63`; `app/services/cash/transaction_creator.rb:80`.
- **Status:** [V]
- **Covered by:** `spec/services/banking_spec.rb:6`, `:15`, `:23`, `:32`, `:41`, `:50` IBAN preferred over name, `:59`, `:68`, `:77`, `:86`; `spec/services/enable_banking/operations/sync_account_transactions_spec.rb:6` resolves counterparty_kind during sync.

<a id="br-237"></a>
### BR-237 Manual classification: modes, guards, messages

- **Rule:** Input: a transaction, an actor, a mode, a merchant (or nil), a category (or nil), `rule_field`, `rule_kind`, `rule_pattern`. Guards, in order:
  1. Mode not in {`only_this`, `all_for_merchant`, `create_rule`} → failure `Unknown propagation mode: <mode>`.
  2. Merchant nil and mode ≠ `only_this` → failure `Pick a merchant`.
  3. Mode `create_rule` with a blank pattern → failure `Pick a pattern`.

  The mode's writes then run inside one DB transaction. Success → `Applied: <label>`, where the labels are `this transaction only`, `all transactions for this merchant`, `new rule + rebuild`. A validation error from any write → rollback and failure with the record's messages joined by `", "`.
- **Evidence:** `app/services/enrichment/classification_applier.rb:24-51,101-107`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:85` 'Pick a merchant'; `:95` 'Pick a pattern'; `:106` 'Unknown propagation mode'. [oracle](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json) `create_rule_missing_fields` → 302 with no DB writes (the log shows no BEGIN).

<a id="br-238"></a>
### BR-238 Mode `only_this`

- **Rule:** On this transaction's enrichment (created if missing), set:
  - `merchant` = the chosen merchant (may be nil);
  - `category` = the chosen category (may be nil);
  - `category_overridden` = true if and only if a category was given;
  - `source = manual`;
  - `merchant_rule`, `confidence`, `model` = NULL;
  - `enriched_at = now`.

  No other transaction changes. Because `source = manual`, later rebuilds never touch this row (BR-233).
- **Evidence:** `app/services/enrichment/classification_applier.rb:55-66`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:16` with merchant + category writes source manual and category_overridden true; `:33` merchant without category leaves category_overridden false. [oracle](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json) `default` (`only_this`, merchant 1, category 1) → 302. The log shows `UPDATE transaction_enrichments SET category_id = 1, …, merchant_id = 1`.

<a id="br-239"></a>
### BR-239 Mode `all_for_merchant`

- **Rule:**
  1. If a category was given, set the merchant's `default_category` to it. This retroactively re-categorizes every transaction of that merchant without an explicit override, past and future (BR-232).
  2. On this transaction's enrichment (created if missing), set `merchant` = the merchant, `category` = NULL, `category_overridden` = false, `source = user_rule`, `enriched_at = now`. `merchant_rule`, `confidence` and `model` are left unchanged.

  The row is rebuildable afterwards. A later rebuild re-runs rule matching and can replace the merchant if no rule matches this transaction (U-308) [I].
- **Evidence:** `app/services/enrichment/classification_applier.rb:68-79`.
- **Status:** [V] for steps 1-2. [I] for the rebuild consequence.
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:46`.

<a id="br-240"></a>
### BR-240 Mode `create_rule`

- **Rule:**
  1. Create a rule for the actor with:
     - merchant = the chosen merchant;
     - `kind` = rule_kind, default `contains`;
     - `field` = rule_field, default `title`;
     - `pattern` = rule_pattern, used verbatim (not trimmed or uppercased by the server);
     - `priority 100`, `source user`, `enabled true`, `approved_at now`, `approved_by actor`.
  2. If a category was given and differs from the merchant's default, set it as the merchant default.
  3. Run a full rebuild for the actor (BR-235). This affects every rebuildable enrichment of the user, including this transaction only if its row is rebuildable.

  An invalid kind, field or regex fails with the model messages (e.g. `Kind is not included in the list`).
- **Evidence:** `app/services/enrichment/classification_applier.rb:81-99`.
- **Status:** [V]
- **Covered by:** `spec/services/enrichment/classification_applier_spec.rb:63` builds a user-source MerchantRule and rebuilds matching transactions retroactively.

<a id="br-241"></a>
### BR-241 Classification endpoint (admin)

- **Rule:** `PATCH|PUT /admin/bank_transactions/:bank_transaction_id/enrichment`:
  - The transaction must belong to the user, else 404.
  - Params `enrichment[mode, merchant_id, category_id, rule_field, rule_kind, rule_pattern]`.
  - `merchant_id` and `category_id` are looked up **within the current user**. A foreign or unknown id silently becomes nil, so a foreign merchant leads to `Pick a merchant` for non-`only_this` modes.
  - Result message → flash `notice` on success, `alert` on failure. Always redirects to `/admin/bank_transactions/:id`.
  - A missing `enrichment[mode]` (nil) raises inside the service and yields a 500 (U-309) [I].
  - Only bank transactions use this endpoint. Cash rows are classified through the cash-transaction editor (Part C).
- **Evidence:** `app/controllers/admin/transaction_enrichments_controller.rb:5-27`; `app/services/enrichment/classification_applier.rb:15`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:410`, `:432` nil merchant for a foreign merchant_id, `:451` failure → flash[:alert], `:467` 404 for another user's transaction. Oracle: [PATCH](../oracle/http/PATCH_admin_bank_transactions__bank_transaction_id_enrichment.json), [PUT](../oracle/http/PUT_admin_bank_transactions__bank_transaction_id_enrichment.json).

### BR-242 Classify modal defaults

- **Rule:** The "Edit classification" modal on a bank transaction preselects:
  - the current enrichment merchant;
  - the category as the explicit enrichment category, else the merchant default;
  - mode `only_this`;
  - for `create_rule`: field `title`, kind `contains`, pattern = the transaction title **uppercased and trimmed**.

  Merchant choices are the user's active merchants, labelled `<name> (<default category name>)` and sorted case-insensitively. Category choices are active categories labelled by breadcrumb. Hidden items are masked (BR-212). The UI copy per mode:
  - "This transaction only – Override on this one transaction. Marked manual - won't be overwritten by future rules."
  - "All transactions for this merchant – Updates the merchant's default category. Applies retroactively and going forward."
  - "Create a new rule for this pattern – A user-source rule will match every existing and future transaction matching this pattern."
- **Evidence:** `app/views/admin/bank_transactions/_classify_modal.html.erb:4-25,85-124`.
- **Status:** [I]
- **Covered by:** untested (UI only).

<a id="br-243"></a>
### BR-243 Matching engine overview

- **Rule:** `GET /admin/matching_engine` shows:
  - all of the user's rules in resolution order (BR-226), offset-paginated, with the total rule count;
  - per rule on the current page, the number of the user's enrichments whose `merchant_rule_id` is that rule;
  - the total number of enrichments with any rule;
  - the **plain** fallback table only (the identity-aware table is not shown), with the user's category for each path and the count of `system_fallback` enrichments per `(direction, payment_method)` summed over bank and cash rows;
  - the `unmatched` count and the total enrichment count.
- **Evidence:** `app/controllers/admin/matching_engine_controller.rb:5-36`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:522` lists only the current user's rules. [oracle](../oracle/http/GET_admin_matching_engine.json) → 200; [UI](../oracle/ui/admin_matching_engine.html).

---

<a id="br-244"></a>
### BR-244 LLM provider registry and model defaults

- **Rule:** Exactly two providers are supported. There is **no** Anthropic or other client at this commit.

  | key | label | default model | allowed models (in this order) | client |
  |---|---|---|---|---|
  | `openai` | OpenAI | `gpt-5-mini` | gpt-5-mini, gpt-5-nano, gpt-5.4-mini, gpt-5.4-nano, gpt-4.1-mini, gpt-4o-mini | `Llm::Clients::OpenAI` |
  | `gemini` | Google Gemini | `gemini-2.5-flash` | gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash | `Llm::Clients::Gemini` |

  An unknown key raises `Unknown LLM provider: "<key>"`. Select options are `[label, key]` in registry order, and the first key (`openai`) is the default for a new setting form. Adding a vendor means one registry entry plus one client class.
- **Evidence:** `app/services/llm/providers.rb:6-47`; ADR 0012:18-24; `app/controllers/admin/settings/preferences_controller.rb:92-93`.
- **Status:** [V]
- **Covered by:** `spec/models/llm_setting_spec.rb:28`, `:34`, `:40`.

<a id="br-245"></a>
### BR-245 Per-user LLM setting (`LlmSetting`)

- **Rule:**
  - Each user has at most one setting (unique `user_id`).
  - `provider` is required and must be a registry key.
  - `api_key` is required and stored with Rails attribute encryption (ADR 0004). The raw column never contains the plaintext.
  - `model`: blank → filled with the provider default before validation; non-blank and not in the provider's list → `Model is not supported by <label>`.
  - "Configured" = `api_key` present. The effective model is `model`, else the provider default.
  - Connection-test bookkeeping:
    - success sets `last_tested_at = now`, `last_test_error = NULL`;
    - failure sets `last_tested_at = now` and `last_test_error` = the message truncated to 500 characters.
- **Evidence:** `app/models/llm_setting.rb:25-81`.
- **Status:** [V]
- **Covered by:** `spec/models/llm_setting_spec.rb:28`, `:34`, `:40`, `:48`, `:58`, `:67` api_key round-trips through encryption.

<a id="br-246"></a>
### BR-246 Saving LLM preferences

- **Rule:** `PATCH /admin/settings/preferences/llm`, params `llm_setting[provider, api_key, model]`:
  - If the setting already exists and `api_key` is blank, the key is **kept**, even when the provider changes. The form never shows the real key.
  - Success → redirect `/admin/settings/preferences/llm` with notice `LLM settings saved.`.
  - Validation failure → re-render with 422 and flash alert = errors joined `", "`.
  - An **unknown provider** fails validation, but the re-render then calls the registry for that provider and raises, giving a **500** with `ArgumentError: Unknown LLM provider: "martian"` (known finding).
- **Evidence:** `app/controllers/admin/settings/preferences_controller.rb:53-68`; `app/views/admin/settings/preferences/llm.html.erb:37`; `../oracle/server.log.txt:15505-15519`.
- **Status:** [V]
- **Covered by:** `spec/requests/settings_spec.rb:127`, `:136` creates on first save, `:149` blank api_key keeps the previous key, `:164` rotates the key. Oracle: [PATCH](../oracle/http/PATCH_admin_settings_preferences_llm.json) `default` (switch to openai/gpt-5-mini with blank key) → 302; `invalid_provider` → 500. The switch kept the Gemini key, and the subsequent connection test sent `fake-gem***-key` to OpenAI ([runs](../oracle/operation_runs_after_capture.jsonl) id 14).

<a id="br-247"></a>
### BR-247 LLM client factory and per-call credentials

- **Rule:** `Llm::Client.for(user)` returns the client of the user's setting, built with that user's decrypted key and effective model. If the user has no setting or no key, it raises `NotConfiguredError` with `User has not configured an LLM provider - see /admin/settings/preferences`.
  - There is no global API key: every call opens a per-call configuration context with this key (RubyLLM context). One tenant can never spend another's quota.
  - Transport defaults: request timeout **60 s** and **2** library-level retries.
  - The client contract is `structured(system_prompt, user_prompt, schema) → parsed JSON object`. Transport or parse failures raise `Llm::Client::Error`.
- **Evidence:** `app/services/llm/client.rb:7-47`; `config/initializers/ruby_llm.rb:11-14`; ADR 0012:26-29.
- **Status:** [I] (the oracle replaced clients by a fake).
- **Covered by:** `spec/services/llm/connection_test_runner_spec.rb:162` does not leak the api_key into the OperationRun.

<a id="br-248"></a>
### BR-248 Provider clients: parsing, errors, rate-limit retry

- **Rule:** Both clients send the system prompt as instructions, attach the JSON schema as structured output, send the user prompt, and parse the reply. A reply that is already an object is returned as-is, a string is JSON-parsed, and anything else raises.
  - **Error messages** (exact formats, `<P>` = `OpenAI` or `Gemini`):
    - `<P> API error: <ErrorClass>: <message>`;
    - `<P> returned non-JSON content: <message>`;
    - `Unexpected response shape from <P>: <class>`.
  - **OpenAI rate limits:** on a rate-limit error the call is retried up to **4** times (5 attempts total). The wait before each retry is:
    - `N + 1` seconds if the message contains `retry after Ns`;
    - `X + 1` seconds if it contains `please try again in X s`;
    - otherwise **30 s**.

    After the 4th retry it raises `OpenAI API error: …`.
  - **Gemini** has no extra retry beyond the library's.
- **Evidence:** `app/services/llm/clients/openai.rb:6-48`; `app/services/llm/clients/gemini.rb:6-28`.
- **Status:** [V] for OpenAI retry. [I] for Gemini.
- **Covered by:** `spec/services/llm/clients/openai_spec.rb:7` retries up to MAX_RETRIES parsing the wait; `:36` raises Llm::Client::Error once MAX_RETRIES is exceeded.

<a id="br-249"></a>
### BR-249 LLM connection test

- **Rule:** `POST /admin/settings/preferences/llm/test`:
  - If the setting is not configured, redirect to the LLM preferences page with alert `Save a provider and API key first.`. No run is created.
  - Otherwise:
    1. create an operation run with kind `llm_connection_test`, status `running`, trigger `manual`, the user as subject and triggered-by, params `{provider, model}`;
    2. send one probe (no retry or fan-out by the runner):
       - system prompt `You are a connectivity probe. Reply with exactly the JSON {"ok": true, "echo": "<the sent_at value from the user message>"}.`;
       - user prompt `ping sent_at=<ISO-8601 now>`;
       - schema `{ok: boolean, echo: string}`, both required, no extra properties;
    3. on success, finish the run as succeeded with summary `{request (+provider, model), response}`, record the test success, and show notice `Connection OK - <label> (<model>).`;
    4. on `Llm::Client::Error`, fail the run with the error message and summary `{request, response: null}`, record the test failure, and show alert `Test failed: <message>`.
  - The API key is never written to the run.
  - The client is built directly from the setting rather than through the factory (known finding; functionally the same) (U-318).
- **Evidence:** `app/services/llm/connection_test_runner.rb:8-83`; `app/controllers/admin/settings/preferences_controller.rb:70-83`.
- **Status:** [V]
- **Covered by:** `spec/services/llm/connection_test_runner_spec.rb:6`, `:22`, `:33`, `:46`, `:62`, `:74`, `:88`, `:98`, `:110`, `:124`, `:137`, `:147`, `:154`, `:162`; `spec/requests/settings_spec.rb:176`, `:186`, `:200`. [oracle](../oracle/http/POST_admin_settings_preferences_llm_test.json) → 302; [runs](../oracle/operation_runs_after_capture.jsonl) id 14 = failed with `OpenAI API error: RubyLLM::UnauthorizedError: Incorrect API key provided: fake-gem***-key. …`.

<a id="br-250"></a>
### BR-250 Which transactions are eligible for LLM enrichment

- **Rule:** A transaction is eligible when it is a **bank** transaction of the user (cash/manual rows are never sent) that meets all of:
  - it **has** an enrichment row with `merchant_id IS NULL`, i.e. `unmatched` or `system_fallback`, including manual-source rows without a merchant;
  - (`title` not null, not empty and not all digits, i.e. not matching `^[0-9]+$`) **or** `counterparty_name` not null and not empty;
  - `payment_method` ∉ {`blik_p2p`, `blik_atm`, `internal_transfer`, `topup`, `fee`};
  - `counterparty_kind ≠ self`.

  The SQL `NOT IN` / `<>` also excludes rows whose `payment_method` or `counterparty_kind` is NULL [I].
- **Evidence:** `app/services/llm/enrichable_query.rb:8-27`; ADR 0005:24-25.
- **Status:** [V] (oracle: salary credit `WYNAGRODZENIE`, a `system_fallback` row, was eligible).
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`. [runs](../oracle/operation_runs_after_capture.jsonl) ids 10, 11 (requests list `WYNAGRODZENIE`/`Some Company sp. z o.o.`, `Spotify`/`Spotify AB`, `Netflix`/`Netflix Intl.`).

<a id="br-251"></a>
### BR-251 Grouping and de-duplication of LLM work

- **Rule:**
  1. Eligible transactions are iterated in primary-key batches, in ascending id order. Each is assigned the group key `[TitleNormalizer(title), counterparty_name or ""]`. A key of `["", ""]` is dropped.
  2. A transaction is skipped if **any** existing rule of the user, enabled **or disabled** and of any source, matches its `title`, `counterparty_name` or `counterparty_iban` (BR-225). `payment_method` rules are never considered here.
  3. The first transaction seen per key supplies the sample `{title, counterparty_name}`.
  4. Groups keep first-seen order.
- **Evidence:** `app/services/llm/enrichable_query.rb:29-54`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (4 distinct titles → 4 groups). The "already proposed" subtraction on the page relies on this (BR-263).

<a id="br-252"></a>
### BR-252 Queueing an LLM enrichment run

- **Rule:** Input: an optional `limit`. Blank → 50; otherwise converted to an integer. There is no server-side upper or lower bound; the form offers min 1, max 200 (U-317).
  - If the user's setting is not configured → failure `Configure an LLM provider in Preferences before running enrichment.`. No run is created.
  - Otherwise create an operation run with kind `llm_enrichment`, status `queued`, trigger `manual`, subject = triggered-by = user, params `{"limit": <n>}`, empty summary, and enqueue the background job with the run id.
  - **Admin** `POST /admin/llm_enrichments`:
    - success → redirect to `/admin/llm_enrichments/<id>` with notice `Run #<id> queued.`;
    - failure → redirect to `/admin/settings/preferences/llm` with alert = the message.
  - **API** `POST /api/v1/llm_enrichments`:
    - success → 201 with the run;
    - failure → 422 `{message, details}`;
    - a non-integer `limit` → 400 (Grape type coercion).
  - Runs are listed and shown only for runs the user triggered. Another user's id → 404.
- **Evidence:** `app/services/llm_enrichments/queuer.rb:4-46`; `app/controllers/admin/llm_enrichments_controller.rb:28-48`; `lib/api/resources/llm_enrichments.rb:27-55`.
- **Status:** [V]
- **Covered by:** `spec/requests/categorization_spec.rb:479`, `:494`, `:506`; `spec/requests/api/v1/categorization_spec.rb:254`, `:269`, `:281`; `spec/system/llm_enrichment_spec.rb:120` refuses to enqueue with a clear flash; `spec/system/cross_user_isolation_spec.rb:83`. Oracle: [admin POST](../oracle/http/POST_admin_llm_enrichments.json) → 302 `/admin/llm_enrichments/11`; [API POST](../oracle/http/POST_api__version_llm_enrichments.json) `default` → 201, `invalid_limit` → 400; [API GET id](../oracle/http/GET_api__version_llm_enrichments__id.json) `not_found` → 404.

<a id="br-253"></a>
### BR-253 Run execution and final status

- **Rule:** The background job `LlmEnrichmentJob(run_id)`:
  1. If the run is already terminal → do nothing.
  2. Mark it `running`. Initialize the summary to `{total_groups: 0, auto_applied: 0, pending_review: 0, skipped: 0, batches: []}`.
  3. limit = `params.limit` (integer) or 50. User = the run's subject if it is a User, else triggered-by. If there is none, raise.
  4. Execute the runner (BR-254). After each batch, append `{index, size, status: succeeded|failed, auto, pending, skipped, errors: [{title, error}], request, response}` to `summary.batches` and save. Each save broadcasts live progress to the run page.
  5. Copy the final totals.
  6. Final status:
     - errors present and `auto_applied = 0` and `pending_review = 0` → **failed** with error `All batches failed. First: <first error>`. This also happens when the only errors are item-level and the rest were skipped (U-322);
     - errors present otherwise → **partial** with error `<n> item(s) failed.`;
     - no errors → **succeeded**. Zero groups gives an empty, succeeded run.
  7. Any other exception → **failed** with `<ErrorClass>: <message>` (summary kept), then re-raised.
- **Evidence:** `app/jobs/llm_enrichment_job.rb:8-51`; `app/models/operation_run.rb:65-67,85-103`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` succeeded with counts; `:67` failed with "All batches failed" including the provider message; `:91` partial with "1 item(s) failed". [runs](../oracle/operation_runs_after_capture.jsonl) id 6 (0 groups → succeeded, `batches: []`), ids 10 and 11 (fake returned `{"results": []}` → every item skipped → succeeded).

<a id="br-254"></a>
### BR-254 Runner: limits, batching, throttle

- **Rule:**
  - Groups (BR-251) are truncated to the **first `limit`** groups (default 50 = max groups per run), then split into batches of **15**.
  - Each batch is **one** provider call. Between batches the runner sleeps **2 s**, but not after the last batch.
  - A batch whose call raises `Llm::Client::Error` records every item of the batch as an error `{title, error: message}` and continues with the next batch.
  - Inside a successful batch, an item raising a validation error records `{title, "ActiveRecord::RecordInvalid: <msg>"}` and continues.
  - The client is resolved lazily, before the first batch. Its `NotConfiguredError` therefore escapes the batch handling and fails the whole run via BR-253 step 7 [I].
  - After all batches, a full rebuild runs (BR-235) if at least one suggestion was auto-applied.
  - Result: `processed` = number of groups sent (not transactions), plus `auto_applied`, `pending_review`, `skipped`, `errors`.
- **Evidence:** `app/services/llm/enrichment_runner.rb:9-86`; `app/services/llm/merchant_suggester.rb:7`.
- **Status:** [V] for batching, counts and errors. [I] for the throttle and NotConfigured path.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`, `:67`, `:91`.

<a id="br-255"></a>
### BR-255 Prompt content and what data leaves the system

- **Rule:** Per batch, the provider receives:
  - **System prompt** (Polish, kept verbatim from `merchant_suggester.rb:77-191`). It contains:
    - noise-stripping guidance (city prefixes, trailing "PL", terminal codes, domain prefixes/suffixes, separators);
    - 7 merchant classes and their rule strategies;
    - rule-pattern guidance ("short core, not the whole title"; `contains` by default; `exact` only for a clean company name; `iban` only for `counterparty_iban`);
    - confidence bands: ≥ 0.95 known chain/SaaS; 0.8–0.9 readable core; 0.6–0.8 local business; below 0.5 → `merchant_name=""` with `confidence=0`, "do not invent";
    - the rule that the pattern must occur in `title_raw`;
    - the list of the user's **active leaf category paths**. A leaf is an active path with no active descendant; the list is sorted as strings, one per line;
    - the instruction that every result must carry the input `index`.
  - **User prompt:** `Sklasyfikuj poniższe transakcje:` followed by one `{ index: i, title_raw: "<title>", [title_normalized: "<normalized>",] [counterparty_name: "<name>"] }` per item. Strings are inspected/quoted Ruby-style.
    - `title_normalized` (BR-264) is included only when non-empty and different from the raw title ignoring case.
    - `counterparty_name` is included only when present.

  **Data that leaves the system:**
  - the raw title, the normalized title, the counterparty name;
  - the user's category paths;
  - implicitly the chosen model and the user's API key, to the provider.

  **Never sent:** amounts, currencies, IBANs, dates, account identifiers. Note that the UI and the initializer claim "only the normalized title" is sent, but the raw title is sent too (U-312). The full request (`index`, `title`, `counterparty_name`) and response are stored in the run summary.
- **Evidence:** `app/services/llm/merchant_suggester.rb:58-64,76-214`; `app/views/admin/llm_enrichments/index.html.erb:89`; `config/initializers/ruby_llm.rb:9-10`.
- **Status:** [V] for the request contents. [I] for the full prompt text.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (the fake matches the prompt on `Jesteś asystentem klasyfikującym`). [runs](../oracle/operation_runs_after_capture.jsonl) ids 10, 11 show `request` arrays.

<a id="br-256"></a>
### BR-256 Structured-output schema and result mapping

- **Rule:** The response schema is `{results: [item]}` with no extra properties. Every item field is required:

  | Field | Type / allowed values |
  |---|---|
  | `index` | integer |
  | `merchant_name` | string; "" if unidentifiable |
  | `merchant_kind` | company, person, charity, government, platform, other, unknown |
  | `category_path` | string |
  | `rule_field` | title, counterparty_name, counterparty_iban |
  | `rule_kind` | contains, regex, exact, prefix, iban |
  | `rule_pattern` | string |
  | `confidence` | number in 0..1 |
  | `reasoning` | string |

  Results are matched to inputs **by `index`**, not by position. A missing index produces a null result. Mapping (blank → default):

  | Field | Mapping |
  |---|---|
  | `merchant_name` | trimmed string |
  | `merchant_kind` | `unknown` |
  | `category_path` | `noise.unmatched.other` |
  | `rule_field` | `title` |
  | `rule_kind` | `contains` |
  | `rule_pattern` | trimmed string |
  | `confidence` | float, defaults to 0.0 |
  | `reasoning` | string |

  The null result is: name "", kind unknown, `noise.unmatched.other`, title/contains, pattern "", confidence 0.0, reasoning `LLM did not return a result for this index.`
- **Evidence:** `app/services/llm/merchant_suggester.rb:15-39,66-72,216-235`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`. [runs](../oracle/operation_runs_after_capture.jsonl) id 11: response `{"results": []}` → 3 null results → 3 skipped.

<a id="br-257"></a>
### BR-257 Processing one suggestion (skip, pattern enforcement)

- **Rule:** For each (sample, suggestion):
  1. Blank `merchant_name` or confidence exactly 0 → **skipped**.
  2. Pattern enforcement. The sample value is the sample's `title` if `rule_field = title`, or its `counterparty_name` if `rule_field = counterparty_name`. For any other field (e.g. `counterparty_iban`) the value is missing → **skipped**.
     - If the LLM rule (its kind, case-insensitive) matches the sample value, keep it.
     - Else, only for `title`: derive a pattern with `TitleNormalizer.likely_pattern(title)` (BR-264). If that pattern, as a case-insensitive `contains`, matches the title, replace the suggestion's pattern and set kind to `contains`, **keep the LLM confidence**, and prefix reasoning with `[DERIVED] LLM pattern didn't match; replaced with stripped-title substring. `.
     - Else → **skipped**.
  3. In one DB transaction: upsert the merchant (BR-259), upsert the rule (BR-260), and return `auto_applied` if confidence ≥ threshold, else `pending_review`.

  An LLM-proposed **invalid regex** raises a regex error during the probe. It is not caught by the per-item handler and aborts the run (U-307) [I].
- **Evidence:** `app/services/llm/enrichment_runner.rb:90-146`.
- **Status:** [V] for skip and apply. [I] for the derived-pattern branch and regex abort.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`, `:91`.

<a id="br-258"></a>
### BR-258 Confidence gating

- **Rule:** The threshold is env `LLM_MERCHANT_AUTO_APPROVE_THRESHOLD` (float, default **0.85**), read once at boot. For a non-skipped suggestion:
  - **confidence ≥ threshold** (inclusive) → the rule is saved **enabled**: auto-applied on the rebuild at the end of the run. A *new* merchant is also stamped approved;
  - **0 < confidence < threshold** → the rule is saved **disabled**. The merchant stays unapproved when new and appears in "Awaiting approval" until approved (BR-221);
  - **confidence = 0** → skipped.

  LLM rules always rank below user rules (BR-226), and rebuilds never touch manual or overridden rows. "LLM never silently overrides a user decision" holds for enrichments but not for merchant attributes (BR-259).
- **Evidence:** `app/services/llm/enrichment_runner.rb:4-9,101,160,174`; `app/services/llm/merchant_suggester.rb:10-12`; ADR 0005:13-22; `inventory/env.txt:32`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (0.95/0.92 → enabled + transactions re-classified; 0.6/0.7 → disabled, merchants unassigned, "Awaiting approval (2)"). [UI](../oracle/ui/admin_llm_enrichments_index.html) shows `Confidence ≥ 0.85 → rule enabled immediately.`

<a id="br-259"></a>
### BR-259 Merchant upsert from an LLM suggestion

- **Rule:** Look up the user's merchant by slug, using algorithm (b) on `merchant_name` with no collision numbering (BR-216). If found, **reuse and overwrite** it; otherwise create it. Then:
  - `name` = the suggested name;
  - `kind` = the suggested kind if it is a valid merchant kind, else NULL (`unknown` → NULL);
  - `source` = unchanged if the merchant exists, else `llm`;
  - `confidence` = the suggestion's confidence, stored as decimal(4,3);
  - `model` = the client's model name;
  - `default_category` = BR-261;
  - `notes` = the previous notes and the reasoning, de-duplicated, joined by a newline;
  - `approved_at` = now **only if** the merchant is new and confident.

  An existing system or user merchant with the same slug therefore gets its name, kind and **default category overwritten** even for a below-threshold suggestion. That retroactively re-categorizes its transactions (U-306) [I].
- **Evidence:** `app/services/llm/enrichment_runner.rb:148-163`.
- **Status:** [V] for new merchants. [I] for the overwrite case.
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`.

<a id="br-260"></a>
### BR-260 Rule upsert from an LLM suggestion

- **Rule:** Within the merchant, find or create the rule by exact `(field, kind, pattern)`. Then set:
  - `user` = the user;
  - `source = llm`;
  - `confidence` and `model` from the suggestion and client;
  - `priority = 50`;
  - `enabled` = confidence ≥ threshold.

  `approved_at` is not set. Re-proposing an existing pattern with a lower confidence would re-**disable** a rule that the user had approved (U-321) [I]. This is normally prevented, because covered groups are not re-sent (BR-251).
- **Evidence:** `app/services/llm/enrichment_runner.rb:165-177`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (patterns DEVSTYLE and P.U.N.K.T enabled; JANUSZEX and MOSO disabled).

<a id="br-261"></a>
### BR-261 Category resolution for an LLM suggestion

- **Rule:** Trim `category_path` and find the user's category with exactly that path; archived categories count. If there is none, use the user's `noise.unmatched.other`. If that does not exist either, use NULL. The prompt mentions targets that do not exist in the seeded tree (`uncategorized`, `gifts_donations`). They resolve to `noise.unmatched.other` (U-319).
- **Evidence:** `app/services/llm/enrichment_runner.rb:188-194`; `app/services/llm/merchant_suggester.rb:117,137`.
- **Status:** [I]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (valid paths only).

### BR-262 Effect of an LLM run on transactions

- **Rule:**
  - Auto-applied rules affect transactions only through the end-of-run rebuild (BR-235). Matching rows get `source = llm_rule`, the rule's confidence and model, and the merchant; their category comes from the merchant default.
  - Pending (disabled) rules have no effect until the merchant is approved, which enables them and rebuilds.
  - The `llm_pending` source is never produced.
- **Evidence:** `app/services/llm/enrichment_runner.rb:83`; `app/services/enrichment/transaction_enricher.rb:103-109`; `app/services/merchants/approver.rb:17-21`.
- **Status:** [V]
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16` (auto_high → merchant `devstyle`; pending_low → merchant nil); `spec/services/merchants/approver_spec.rb:44`.

### BR-263 AI Enrichment page figures

- **Rule:** `GET /admin/llm_enrichments` shows:
  - **"Without a merchant":** the user's merchantless enrichments, bank and cash;
  - **"Awaiting approval":** merchants with `source llm` and `approved_at` null, newest first;
  - **"Ready to send to LLM":** the number of groups after rule de-duplication (BR-251);
  - **"LLM can't help":** merchantless minus eligible *transactions*. This mixes transaction and group counts, so the rows do not "add up" as the hint claims;
  - **API calls:** ⌈ready / 15⌉;
  - **Default group limit:** min(ready, 50);
  - **"already proposed":** all groups minus ready groups;
  - the user's runs, paginated, newest first.

  If the user has no active categories, a "Taxonomy not set up" empty state replaces the page. If no key is configured, the warning `No LLM provider configured` is shown.
- **Evidence:** `app/controllers/admin/llm_enrichments_controller.rb:7-26,53-58`; `app/views/admin/llm_enrichments/index.html.erb:6-104`.
- **Status:** [V] (oracle page: 24 without merchant, 0 awaiting, 3 ready, 13 can't help).
- **Covered by:** `spec/system/llm_enrichment_spec.rb:16`, `:120`. [UI](../oracle/ui/admin_llm_enrichments_index.html); [oracle](../oracle/http/GET_admin_llm_enrichments.json) → 200.

<a id="br-264"></a>
### BR-264 Title normalizer

- **Rule:** The known city prefixes are RZESZOW, WARSZAWA, KRAKOW, POZNAN, WROCLAW, GDANSK, GDYNIA, SZCZECIN, LODZ, LUBLIN, BYDGOSZCZ, BIALYSTOK, KATOWICE, SOSNOWIEC, ZLOTOW, TORUN. They are matched case-insensitively at the start of the title, with **no word boundary**.

  **`normalize(title)`**, used for grouping and for `title_normalized`. A blank title gives `""`. Steps:
  1. uppercase;
  2. remove one leading city prefix;
  3. remove a trailing `PL`;
  4. replace each digit run with a space;
  5. replace every character that is not a letter, whitespace, `.`, `&` or `-` with a space;
  6. replace `.` with a space;
  7. squeeze spaces and trim.

  **`likely_pattern(title)`**, the fallback rule pattern. A blank title gives nil. Steps:
  1. on the *original casing*, remove the city prefix (case-insensitive);
  2. remove a trailing `PL` (case-sensitive);
  3. replace digit runs with spaces;
  4. split on whitespace;
  5. keep tokens of ≥ 3 characters;
  6. return the longest, the first on ties, or nil.

  Outputs (pure-Ruby evaluation of the source file):

  | input | normalize | likely_pattern |
  |---|---|---|
  | `RZESZOWLIDL 01PL` | `LIDL` | `LIDL` |
  | `RZESZOWJMP S.A. BIEDRONKA 7645PL` | `JMP S A BIEDRONKA` | `BIEDRONKA` |
  | `RzeszoweLeclercPL` | `ELECLERC` | `eLeclerc` |
  | `RzeszowP.U.N.K.TPL` | `P U N K T` | `P.U.N.K.T` |
  | `WWW.DEVSTYLE.PL` | `WWW DEVSTYLE` | `WWW.DEVSTYLE.` |
  | `POZNANSKA 12` | `SKA` (over-strip) | `SKA` |
  | `12345` | `""` | nil |

  The code comments promise `JMP S.A. BIEDRONKA` and `LECLERC`, which differ from the real output (U-316).
- **Evidence:** `app/services/enrichment/title_normalizer.rb:11-50`.
- **Status:** [V] for the cases asserted by specs. [I] for the other table rows.
- **Covered by:** `spec/services/enrichment/title_normalizer_spec.rb:6`, `:12`, `:16`, `:21`, `:26`.

### BR-265 "Facts-only" AI narration boundary

- **Rule:** ADR 0008 describes an `Analytics::AiInsight` card. Ruby computes every number; the LLM writes 3 sentences "using ONLY numbers in the facts"; a numeric guard rejects any digit sequence not present in the facts. **No such code exists at this commit**: no `AiInsight` class or view. The only LLM uses are the merchant suggester (BR-255) and the connection test (BR-249). The enrichment pipeline never sends amounts or dates and never lets the LLM produce numbers that are shown as facts. The ADR's notable-mover rule (|delta_pct| ≥ 100 % AND |amount| ≥ 200 PLN) is therefore not implemented (U-314).
- **Evidence:** `docs/adr/0008-ai-insight-architecture.md:19-27`; `grep -r AiInsight src` → no matches; `app/services/llm/*`.
- **Status:** [I]
- **Covered by:** untested (not implemented).

<a id="br-266"></a>
### BR-266 Showcase data set (`Seeders::Showcase`)

- **Rule:** Builds a deterministic demo tenant by calling the production services against fakes.
  - **Inputs:** `user`, `fake_eb`, `fake_llm` (all required; each missing one raises `user required` / `fake_eb required (test fake or production client)` / `fake_llm required (test fake or production client)`), `seed` (default `20260115`), `reference_time` (default `2026-01-15 12:00:00`).
  - **Setup:**
    - seeds the random generator and Faker;
    - runs in zone `Europe/Warsaw`;
    - time-travels to the reference time only when the test time helpers are available, otherwise uses the real now (as in the oracle);
    - temporarily redirects `EnableBanking::Client.new` to `fake_eb` unless running inside RSpec;
    - `fake_llm` is only validated, never used.
  - **Steps** (in **one DB transaction**):
    1. **Taxonomy:** BR-213 and BR-229.
    2. **LLM setting:** `gemini` / `fake-gemini-key` / `gemini-2.5-flash`.
    3. **Credentials:** two enable_banking SANDBOX credentials, `PKO BP (Showcase)` (primary, app id `fake-app-pko`) and `Revolut (Showcase)` (`fake-app-revolut`). Both use redirect `http://localhost:3000/admin/oauth/enable_banking/callback` and a fresh 2048-bit RSA key.
    4. **Fake bank sessions:**
       - PKO BP / PL valid 30 days;
       - Revolut LT / LT valid 90 days;
       - one expired PKO session.
    5. **Fake accounts:**

       | Bank | Product | Currency | Balance | IBAN | Holder |
       |---|---|---|---|---|---|
       | PKO | Konto Osobiste | PLN | 12 345.67 | PL61109010140000071219812874 | MACIEJ TEST |
       | PKO | Konto Oszczędnościowe | PLN | 50 000.00 | …2875 | MACIEJ TEST |
       | Revolut | EUR Pocket | EUR | 1 500.00 | LT123456789012345678 (alternate PL00000000000000000000000099) | Maciej Test |
       | Revolut | USD Pocket | USD | 250.00 | same LT IBAN | Maciej Test |

       Balances are given in minor units × 100.
    6. **Fake transactions**, with base date = today − 80 days:
       - PKO card debits: 30, one every 2 days. Amounts cycle 19.99 / 45.00 / 12.50 / 156.00 / 8.99 / 220.00 PLN. Titles cycle `BIEDRONKA WARSZAWA`, `ZABKA NANO`, `MCDONALD'S 5230`, `T-MOBILE POLSKA`, `ROSSMANN 0123`, `DECATHLON`.
       - PKO ATM debits: 6 × 200.00 PLN, every 12 days, title `WYP. BANKOMAT`, type `BLIK ATM`.
       - PKO salary credits: 3 × 6 500.00 PLN on base + 28·i + 5 days, title `WYNAGRODZENIE`, counterparty `Some Company sp. z o.o.`.
       - Revolut EUR debits: 15, one every 5 days. Amounts cycle 9.99 / 14.99 / 5.00 / 25.00. Titles `Spotify`, `Netflix`, `OpenAI`, `Anthropic` with counterparties `Spotify AB`, `Netflix Intl.`, `Openai LLC`, `Anthropic`.
    7. **Connections:** two, created through the real connection-creation operation.
    8. **Sync:** per connection, a `transaction_sync` run (manual) → real sync → rebuild → run succeeded. A failure marks only that run failed.
    9. **Cash:** enable cash tracking (PLN wallet). Six cash debits of 5, 8, 11, 14, 17, 20 PLN, weekly from today − 4 months, titles `Coffee at office`, `Tip at restaurant`, `Newspaper`, `Charity coin`, `Lottery`, `Parking meter`, created through the cash creator.
    10. **Sync schedules:** daily at 08:00. The first connection is enabled; the second is paused.
    11. **Hidden categories:** `noise_authorizations` and `noise_adjustments_fx`.
  - **Result:** `Result(success?, user, credentials, connections, accounts, bank/cash transactions, enrichments, runs, schedules)`. A validation error gives `success?: false` with its messages. Any other error gives `"<Class>: <message>"`.
- **Evidence:** `app/services/seeders/showcase.rb:13-333`.
- **Status:** [V] (specs + the oracle data set).
- **Covered by:** `spec/services/seeders/showcase_spec.rb:6`, `:13`, `:22`, `:29`, `:36`, `:43`, `:54`. The oracle fixture was built with it ([runs](../oracle/operation_runs_after_capture.jsonl) ids 1–4 = showcase `transaction_sync` runs for two tenants).

---

### Service catalogue (Part B)

<a id="svc-categories-creator"></a>
**`app/services/categories/creator.rb`** (`Categories::Creator`)
- Creates a category for a user. Inputs: `user`, `attributes`, `parent_path?`. Output: `Result(success?, category, error_messages)` (`error` = messages joined `", "`). It generates a slug when nil, auto-numbers collisions, composes `parent_path.slug`, and saves. Implements BR-205, BR-202, BR-203.

<a id="svc-categories-mover"></a>
**`app/services/categories/mover.rb`** (`Categories::Mover`)
- Updates a category and, when `parent_path` is given and the path changes, rewrites every descendant path of the same user in one UPDATE inside a transaction. Inputs: `category`, `attributes`, `parent_path?`. Output: `Result(success?, category, error_messages)`. Implements BR-206, BR-207.

<a id="svc-enrichment-classification-applier"></a>
**`app/services/enrichment/classification_applier.rb`** (`Enrichment::ClassificationApplier`)
- Applies a manual classification to one transaction in mode `only_this`, `all_for_merchant` or `create_rule`. Inputs: `transaction`, `actor`, `Input(mode, merchant, category, rule_field, rule_kind, rule_pattern)`. Output: `Result(success, message)`. Implements BR-237, BR-238, BR-239, BR-240.

<a id="svc-enrichment-own-account-merchant-syncer"></a>
**`app/services/enrichment/own_account_merchant_syncer.rb`** (`Enrichment::OwnAccountMerchantSyncer`)
- For one bank account, upserts an "Own account" system merchant plus iban rules (priority 200) for its IBANs, and disables rules for IBANs that are gone. Input: `bank_account` (or `sync_all(scope)`). Output: the merchant, or nil when the account has no IBAN. Implements BR-230, BR-227.

<a id="svc-enrichment-title-normalizer"></a>
**`app/services/enrichment/title_normalizer.rb`** (`Enrichment::TitleNormalizer`)
- Pure functions: `call(title)` → the normalized uppercase merchant signal; `likely_pattern(title)` → the fallback `contains` pattern. Implements BR-264. Used by BR-251, BR-255, BR-257.

<a id="svc-enrichment-transaction-enricher"></a>
**`app/services/enrichment/transaction_enricher.rb`** (`Enrichment::TransactionEnricher`)
- Rule engine. `call(tx, user)`, `enrich_pending(user, scope?)` → count, `rebuild!(user, scope?)`. Writes `TransactionEnrichment` rows from the first matching rule, else the payment-method fallback, else `unmatched`, and never touches manual or overridden rows. Implements BR-226, BR-233, BR-234, BR-235.

<a id="svc-llm-client"></a>
**`app/services/llm/client.rb`** (`Llm::Client`)
- Abstract LLM client and factory. `Client.for(user)` builds the user's configured client or raises `NotConfiguredError`. Defines the `structured(system_prompt, user_prompt, schema)` contract, the `Error` class, and the per-call credential context. Implements BR-247.

<a id="svc-llm-clients-gemini"></a>
**`app/services/llm/clients/gemini.rb`** (`Llm::Clients::Gemini`)
- Gemini implementation of `structured`: schema-constrained chat and JSON parsing, with errors wrapped as `Gemini API error: …` / `Gemini returned non-JSON content: …`. Implements BR-248.

<a id="svc-llm-clients-openai"></a>
**`app/services/llm/clients/openai.rb`** (`Llm::Clients::OpenAI`)
- OpenAI implementation of `structured`, with rate-limit retry (4 retries; the wait is parsed from the message, default 30 s) and errors wrapped as `OpenAI API error: …`. Implements BR-248.

<a id="svc-llm-connection-test-runner"></a>
**`app/services/llm/connection_test_runner.rb`** (`Llm::ConnectionTestRunner`)
- Sends a timestamp-echo probe with the user's setting and records an `llm_connection_test` operation run plus `last_tested_at`/`last_test_error`. Input: `user`. Output: `Result(run, setting)`. Raises `Failed(message)`. Implements BR-249, BR-245.

<a id="svc-llm-enrichable-query"></a>
**`app/services/llm/enrichable_query.rb`** (`Llm::EnrichableQuery`)
- `scope(user)` returns the bank transactions eligible for LLM enrichment. `groups(user, scope?)` returns ordered distinct `[normalized title, counterparty]` groups not covered by any existing rule, each mapped to a sample `{title, counterparty_name}`. Implements BR-250, BR-251.

<a id="svc-llm-enrichment-runner"></a>
**`app/services/llm/enrichment_runner.rb`** (`Llm::EnrichmentRunner`)
- Orchestrates one LLM enrichment run: limits groups (default 50), batches by 15, calls the suggester, enforces patterns, upserts merchants and rules with confidence gating (threshold env, default 0.85), throttles 2 s between batches, and rebuilds when anything was auto-applied. Inputs: `user`, `scope?`, `limit`, `client?`, `throttle_seconds`, `on_batch` callback. Output: `Result(processed, auto_applied, pending_review, skipped, errors)`. Implements BR-254, BR-257, BR-258, BR-259, BR-260, BR-261, BR-262.

<a id="svc-llm-merchant-suggester"></a>
**`app/services/llm/merchant_suggester.rb`** (`Llm::MerchantSuggester`)
- Builds the Polish system prompt (with the user's leaf category paths) and the user prompt for up to 15 items, calls `structured` with the batch schema, and maps results back by index (null result when missing). Exposes `last_input` and `last_response`. Inputs: `user`, `items`, `client?`. Output: an array of suggestion results. Implements BR-255, BR-256.

<a id="svc-llm-providers"></a>
**`app/services/llm/providers.rb`** (`Llm::Providers`)
- Static registry of supported providers (openai, gemini): label, default model, allowed models, client class, credential key. `keys`, `fetch` (raises `Unknown LLM provider: …`), `options_for_select`, `models_by_provider`. Implements BR-244.

<a id="svc-llm-enrichments-queuer"></a>
**`app/services/llm_enrichments/queuer.rb`** (`LlmEnrichments::Queuer`)
- Validates that the user has a configured LLM, creates a queued `llm_enrichment` operation run with `params.limit` (default 50), and enqueues `LlmEnrichmentJob`. Inputs: `user`, `Input(limit)`. Output: `Result(success?, run, error_messages)`. Implements BR-252 (BR-253 for execution).

<a id="svc-merchant-rules-creator"></a>
**`app/services/merchant_rules/creator.rb`** (`MerchantRules::Creator`)
- Creates a user-source, approved rule under a merchant and rebuilds the actor's enrichments on success. Inputs: `merchant`, `actor`, `attributes`. Output: `Result(success?, rule, error_messages)`. Implements BR-228, BR-224.

<a id="svc-merchant-rules-destroyer"></a>
**`app/services/merchant_rules/destroyer.rb`** (`MerchantRules::Destroyer`)
- Destroys a rule (nullifying enrichment references), then rebuilds the actor's enrichments. Inputs: `rule`, `actor`. Output: `Result(success?: true)`. Implements BR-228.

<a id="svc-merchant-rules-updater"></a>
**`app/services/merchant_rules/updater.rb`** (`MerchantRules::Updater`)
- Updates a rule's attributes, keeping its source, and rebuilds only after a successful update. Inputs: `rule`, `actor`, `attributes`. Output: `Result(success?, rule, error_messages)`. Implements BR-228.

<a id="svc-merchants-approver"></a>
**`app/services/merchants/approver.rb`** (`Merchants::Approver`)
- Stamps merchant approval, enables and approves the merchant's disabled llm rules (one transaction), then rebuilds the owner's enrichments. Inputs: `merchant`, `actor`. Output: `Result(success?, merchant)`. Implements BR-221, BR-258.

<a id="svc-merchants-creator"></a>
**`app/services/merchants/creator.rb`** (`Merchants::Creator`)
- Creates a user-source, approved merchant with slug generation and collision numbering. Inputs: `user`, `attributes`. Output: `Result(success?, merchant, error_messages)`. Implements BR-217, BR-216, BR-215.

<a id="svc-seeders-categories"></a>
**`app/services/seeders/categories.rb`** (`Seeders::Categories`)
- Idempotently upserts the 118-node baseline taxonomy for a user, keyed by slug (path with `_`), assigning name, kind, essential, path, position, icon and palette color. Input: `user`. No result value. Implements BR-213.

<a id="svc-seeders-merchant-rules"></a>
**`app/services/seeders/merchant_rules.rb`** (`Seeders::MerchantRules`)
- Idempotently upserts 25 retail system merchants and rules (priority 0), the ATM merchant and rule (priority 300) and the top-up merchant with 3 rules (priority 250). Requires the taxonomy. Input: `user`. Implements BR-229, BR-227.

<a id="svc-seeders-showcase"></a>
**`app/services/seeders/showcase.rb`** (`Seeders::Showcase`)
- Builds the deterministic demo tenant (taxonomy, rules, LLM setting, 2 credentials, 4 fake accounts, 54 fake bank transactions, syncs, cash wallet with 6 cash transactions, 2 sync schedules, 2 hidden categories) through production services. Inputs: `user`, `fake_eb`, `fake_llm`, `seed`, `reference_time`. Output: `Result(success?, user, tpp_credentials, connections, accounts, bank_transactions, cash_transactions, enrichments, operation_runs, sync_schedules, error_messages)`. Implements BR-266.
