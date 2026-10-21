# Facts queued for Context Fabric `remember` (server auth expired mid-session)

Re-submit these with `remember` (project `ruby-to-kotlin-migration-demo`) once the context-fabric MCP server is re-authorised.

| kind | repo | paths | text |
|---|---|---|---|
| gotcha | open-banking-rails | spec/rails_helper.rb, config/initializers/active_record_encryption.rb | In a fresh open-banking-rails checkout, run `bin/rails tailwindcss:build` before `bundle exec rspec`, otherwise ~174 request/system specs fail with "The asset 'tailwind.css' was not found in the load path". Specs also need ACTIVE_RECORD_ENCRYPTION_* keys set (any `openssl rand -hex 32` values) and Postgres on POSTGRES_HOST/PORT; the full suite (825 examples) takes about 20 minutes. |
| convention | (project-wide) | – | [ruby→kotlin] Parity policy: the Kotlin rebuild preserves all Ruby behaviour for valid input, but fixes security/tenant-isolation defects and crashes (HTTP 500) on invalid input; any other deviation from Ruby behaviour needs an explicit recorded decision, and every fix is logged as a decision and covered by a test. |
| convention | (project-wide) | – | [ruby→kotlin] Unused Rails framework engines and their default routes (ActionMailbox ingresses/Conductor, ActiveStorage, ActionText, Turbo Native history routes), unused gems' tables and dev-only debug routes are not ported to Kotlin; the Sidekiq Web UI is replaced by the Kotlin job runner's own dashboard behind authentication, and grape-swagger docs are replaced by OpenAPI 3 served at the same docs URL. |
| convention | (project-wide) | – | [ruby→kotlin] Migration scope is what exists in the Ruby code at the migrated commit: features described only in ADRs, READMEs or wikis but not implemented are not ported; they are tracked as future features instead. |
