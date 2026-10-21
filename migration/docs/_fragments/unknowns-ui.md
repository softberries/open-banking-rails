### U-700 BUG? Category ancestry is not tenant-scoped (duplicated breadcrumbs, cross-tenant name leak)
- **What is unclear:** `Category#ancestors`, `#descendants`, `#self_and_descendants` and `#children` query `Category` by ltree path **without** `user_id`. With two tenants sharing the seeded taxonomy, every breadcrumb label contains each ancestor twice ("Jedzenie / Jedzenie / W domu / W domu / Supermarkety", "Lifestyle / Lifestyle / Narzędzia cyfrowe / Narzędzia cyfrowe / SaaS / AI"), and a tenant who renames a category leaks the new name into the other tenant's labels. Side effects: `Category#in_use?` (`descendants.exists?`) can refuse deletion because of another tenant's sub-categories; analytics category pages (`@category.descendants.any?`, custom breadcrumbs from `ancestors`) mix tenants; the category form's parent-exclusion list includes foreign ids.
- **Evidence for / against:** [V] `../oracle/ui/admin_bank_transactions_index.png` and the category `<select>` options in `../oracle/ui/admin_cash_transactions_new.html` (13 doubled labels), `admin_merchants_new.html`, `admin_settings_app.html`; [I] `app/models/category.rb:83-99,113,116-119`, `app/controllers/admin/analytics/categories_controller.rb:19,35`. Against: `spec/system/cross_user_isolation_spec.rb:68-81` only checks the categories index list, which does not use ancestry.
- **Who/what can resolve:** original author / product owner (confirm it is a bug); 10-domain-model owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** fix in the Kotlin port — scope every ltree query by `user_id`; labels then read "Jedzenie / W domu / Supermarkety".

### U-701 BUG? Hidden-category guard on merchant edit is dead code
- **What is unclear:** `Admin::MerchantsController` defines `edit` twice; the second empty definition (line 58) replaces the first (lines 37-42) that redirected with "This merchant is in a hidden category. Remove it from the hidden list in preferences to edit it." So the edit page of a merchant in a hidden category opens normally (name shown in the form), unlike every other drill-down.
- **Evidence for / against:** [I] `app/controllers/admin/merchants_controller.rb:37-42,58-59` (Ruby method redefinition). No spec covers it (`spec/requests/categorization_spec.rb` only tests `show` for hidden merchants, :231-242).
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** implement the guard (redirect to `/admin/merchants` with the alert above).

### U-702 BUG? Invalid "Add bank" form answers 204 with empty body
- **What is unclear:** `Admin::BankConnectionsController#create` handles an invalid `BankConnectionRequestForm` with `flash.now[:alert] = …; return new`, but no template is rendered for the `create` action, so Rails replies **204 No Content**. The form is submitted with Turbo disabled, so the browser stays on the page with no feedback; the alert is lost.
- **Evidence for / against:** [V] `../oracle/http/POST_admin_bank_connections.json` case `invalid_blank_aspsp → 204`, empty body; [I] `app/controllers/admin/bank_connections_controller.rb:43-50`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (bug to keep or fix)
- **Proposed default:** re-render the "Add bank connection" page with 422, the alert (joined form errors) and the submitted values.

### U-703 BUG? Cash-transaction "Delete" button is a form nested inside the edit form
- **What is unclear:** `_form` renders `button_to … method: :delete` (its own `<form>` with `_method=delete` and a CSRF token) inside the outer `form_with` (PATCH). Nested forms are invalid HTML; browsers drop the inner `<form>` tag, so clicking "Delete" submits the **outer** form with both `_method=patch` and `_method=delete` fields (Rack keeps the last → probably destroy) plus all edit fields; Turbo's confirm comes from the button's `data-turbo-confirm`. The actual browser outcome was not observed.
- **Evidence for / against:** [I] `app/views/admin/cash_transactions/_form.html.erb:15-18,123-130`; the oracle never captured the edit form (U-706); request specs call `DELETE` directly (`spec/requests/cash_spec.rb:243-268`). Contrast: the LLM settings view explicitly avoids nesting (`app/views/admin/settings/preferences/llm.html.erb:63`).
- **Who/what can resolve:** run a real browser against the edit page.
- **Human question?** no
- **Proposed default:** Kotlin UI renders Delete as a separate form outside the edit form, `DELETE /admin/cash_transactions/:id` with confirm "Delete this transaction?".

### U-704 Bundle download under Turbo Drive
- **What is unclear:** The export form (`POST …/data_exchange/export`) is not marked `data-turbo="false"`; Turbo intercepts form submissions via `fetch` and expects HTML, so in a real browser the `application/octet-stream` attachment may not trigger a download. The system spec uses the non-JS `rack_test` driver, which follows the plain form post.
- **Evidence for / against:** [I] `app/views/admin/settings/data_exchange/show.html.erb:3-6`; [V] `spec/system/data_exchange_round_trip_spec.rb:29-49` (rack_test, `spec/support/system_spec_helper.rb:15`); oracle only exercised the HTTP endpoint (`../oracle/http/POST_admin_settings_preferences_data_exchange_export.json` → 200).
- **Who/what can resolve:** manual browser test.
- **Human question?** no
- **Proposed default:** in the port submit the export as a normal (non-Turbo) form post so the browser downloads `obr-export-<UTC yyyymmdd-HHMMSS>.obrbundle`.

### U-705 Non-English developer copy in the UI
- **What is unclear:** The repo rule says all developer-written UI copy is English (`AGENTS.md` "Language"), yet code contains Polish strings: chart tooltip lines "Udział:", "Transakcji:", "Δ vs poprz.:" and `pl-PL` currency formatting (`app/javascript/controllers/chart_controller.js:33,136-140`); multi-select search placeholder "Szukaj…" and "Brak wyników" (`multi_select_controller.js:97,116`); bank-account label "Alternate IBAN-y (np. Revolut PL+LT):" (`app/views/admin/bank_accounts/show.html.erb:53`); styleguide demo labels ("Saldo", "Wydatki", "Wpływy", "Top sprzedawca", "30 dni", "Brak transakcji w tym okresie"). Seeded Polish category/merchant names are data and are not affected.
- **Evidence for / against:** [I] files above; `AGENTS.md` lines 7-23.
- **Who/what can resolve:** product owner.
- **Human question?** yes (translate in the port or keep parity)
- **Proposed default:** translate to English ("Share:", "Transactions:", "Δ vs prev.:", "Search…", "No results", "Alternate IBANs (e.g. Revolut PL+LT):") and keep amounts formatted per the reporting currency.

### U-706 Several oracle UI captures do not show their intended state
- **What is unclear:** `admin_command_palette_open`, `admin_privacy_mask_toggled`, `mobile_admin_analytics_dashboard`, `mobile_admin_bank_transactions_index`, `first_run_after_setup_dashboard` show the sign-in page (session lost); `admin_cash_transactions_show`/`_edit` show the cash index with "This transaction was auto-generated and isn't editable here." (an ATM-link row was used); `admin_cash_transactions_new_invalid_submit` shows the filled form without the 422 error state. Command palette, privacy mode, mobile layout, the cash edit form and the cash validation re-render are therefore documented from code only.
- **Evidence for / against:** [V] titles/H1/flash of the listed `../oracle/ui/*.html`; the HTTP oracle does contain the 422 (`../oracle/http/POST_admin_cash_transactions.json` case `invalid_amount`).
- **Who/what can resolve:** re-run the UI capture signed in, with a `source=manual` cash row.
- **Human question?** no
- **Proposed default:** treat 40-ui.md code-derived descriptions as the contract for these screens.
- **Update (investigator, oracle run 3):** root causes were a capture-script defect (the invalid-submit step clicked the sidebar sign-out button, the first `[type=submit]` on the page) and an ATM-link fixture row. Both fixed; all listed captures except `first_run_after_setup_dashboard` (browser not signed in by design) now show the intended state. `GET /admin/cash_transactions/:id` for an editable row lands on the edit form [V].

### U-707 Unused UI components and controllers — port or drop?
- **What is unclear:** Components/wrappers used only by the styleguide: `_bulk_action_bar`, `_category_picker`, `_confirm_dialog` (confirm button not wired), `_skeleton`, `_tabs`, `_toast`, form `_ajax_select` (expects a JSON search endpoint that does not exist), `_checkbox_group`, `_color_picker` (value span never filled), `_date_range_picker`, `_file_upload`, `_tags_input`, `_time_picker`; Stimulus `bulk_select_controller.js` is referenced nowhere; `file_upload`, `tabs`, `tags_input` controllers only via those partials. `_category_picker`'s comment claims usage that does not exist.
- **Evidence for / against:** [I] grep of `app/views` excluding the styleguide (no render calls); `app/views/admin/styleguide/index.html.erb`.
- **Who/what can resolve:** product owner / migration lead.
- **Human question?** yes (scope)
- **Proposed default:** do not port unused components; keep the styleguide only for components the Kotlin UI actually uses.

### U-708 BUG? Page `<title>` concatenates when a page renders several page headers
- **What is unclear:** `_page_header` calls `content_for :title, …`, which appends. The styleguide's title becomes "Styleguide · Open BankingTitle only · Open BankingWith subtitle · …". Real pages render one header, so only the styleguide is affected; also the merchant edit page shows "Edit:  · Open Banking" after a blank-name validation error (uses the unsaved value).
- **Evidence for / against:** [V] `../oracle/ui/admin_styleguide.html` `<title>`, `../oracle/http/PUT_admin_merchants__id.json` case `invalid_blank_name` (title "Edit:  · Open Banking"); [I] `app/views/admin/shared/components/_page_header.html.erb:3`.
- **Who/what can resolve:** n/a (cosmetic).
- **Human question?** no
- **Proposed default:** set the title once per page (last/first header wins); use the persisted name in the edit title.

### U-709 Copy/count inconsistencies on dashboard and AI enrichment pages
- **What is unclear:** (a) Dashboard empty state "<n> transactions awaiting classification" is not pluralised ("1 transactions …") while the banner uses `pluralize`. (b) AI Enrichment "What's left": the hint under "Without a merchant" says "The numbers below add up to this", but "Ready to send to LLM" counts **groups** (distinct normalized title+counterparty) not transactions, and "Awaiting approval" counts merchants, so 24 ≠ 0 + 3 + 13 in the oracle. (c) Auto-sync empty state says "Add one in Settings → Bank connections" although connections live under "Bank Integrations".
- **Evidence for / against:** [V] `../oracle/ui/admin_analytics_dashboard.png` ("1 transactions awaiting classification"), `../oracle/ui/admin_llm_enrichments_index.html` (24/0/3/13); [I] `app/views/admin/analytics/dashboard/index.html.erb:389-394`, `app/views/admin/llm_enrichments/index.html.erb:32-45`, `app/views/admin/transaction_syncs/_auto_sync_panel.html.erb:13-16`.
- **Who/what can resolve:** product owner.
- **Human question?** yes (which numbers the panel should show)
- **Proposed default:** pluralise; show transaction counts in all four rows (or drop the "add up" claim); point the empty state at "Bank Integrations → Bank Connections".

### U-710 Spend-change KPI colours: more spend shown green, less spend red
- **What is unclear:** The dashboard "Spend change" card passes `trend: :up` for a delta ≥ 0; `_stat_card` colours `:up` green and anything else red, so spending more looks positive and spending less negative (the oracle shows "-100%" with a red pill). Top movers use the opposite (increase red). Intent unclear.
- **Evidence for / against:** [V] `../oracle/ui/admin_analytics_dashboard.png`; [I] `app/views/admin/analytics/dashboard/index.html.erb:334-341`, `app/views/admin/shared/components/_stat_card.html.erb:19-27`, `:640-683` (movers).
- **Who/what can resolve:** product owner.
- **Human question?** yes
- **Proposed default:** invert for spend (increase red, decrease green), consistent with top movers and the chart's `delta_sign_inverse` flag.

### U-711 Does the TPP credential edit page re-display the stored private key?
- **What is unclear:** `_form` renders `form.text_area :private_key_pem` (and `application_id` text field), which in Rails outputs the current decrypted value into the page, contradicting the copy "Never logged or shown after save." The oracle HTML shows `application_id` filled ("fake-app-pko") but an **empty** private-key textarea although the showcase seeds an RSA PEM, so either the capture scrubbed textarea content or the value is not rendered for a reason not visible in the view.
- **Evidence for / against:** [I] `app/views/admin/tpp_credentials/_form.html.erb:33-47`, `app/services/seeders/showcase.rb:166-183`; [V] `../oracle/ui/admin_tpp_credentials_edit.html` (empty textarea, filled application id input).
- **Who/what can resolve:** inspect the raw HTTP response of `GET /admin/tpp_credentials/:id/edit`; security owner.
- **Human question?** yes (security: should secrets be re-rendered on edit?)
- **Proposed default:** never render stored secrets; leave secret fields blank with a "leave blank to keep" hint (as the LLM API-key field does) and keep the stored value when blank.

### U-712 Breadcrumb record labels are resolved without tenant scope
- **What is unclear:** `breadcrumb_label_for_id` derives a model from the URL segment and calls `Model.find_by(id:)` unscoped. It only runs while rendering pages whose controller already authorized the record, so no foreign label is shown today; but the Audit Log (`/admin/versions/:id`, itself unscoped) and any future page with an unscoped id segment would expose other tenants' record names.
- **Evidence for / against:** [I] `app/helpers/admin/base_helper.rb:174-190`; [V] breadcrumbs "Admin › Bank Connections › PKO BP" in `../oracle/ui/admin_bank_connections_show.html`.
- **Who/what can resolve:** n/a.
- **Human question?** no
- **Proposed default:** in Kotlin, compute breadcrumb labels from the already-loaded, user-scoped record.
