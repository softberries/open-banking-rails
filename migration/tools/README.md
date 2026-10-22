# Investigation tooling (reproducible)

| File | Purpose |
|---|---|
| `env.sh` | Environment used for every command (Ruby 3.4.8 via mise, local Postgres 17 / Redis 7, OTEL disabled, throwaway AR-encryption keys) |
| `inventory.rb` | `bin/rails runner inventory.rb <out>` → models.json, api_routes.json, mcp_tools.json, jobs.json, mailers.json, rake_tasks.json |
| `env_inventory.py` | `python3 -I env_inventory.py <src> env.txt env.json` — grep of every ENV read |
| `coverage_keys.py` | builds `inventory/coverage_keys.json` (every inventory entry → required doc anchor) |
| `check_coverage.py` | `python3 -I check_coverage.py <DIR> --write` — verifies every key's anchor exists in its doc and the key text is mentioned; writes `docs/coverage.json`; exit 1 on gaps or broken links |
| `oracle_seed.rb` | seeds two tenants with `Seeders::Showcase` (in-memory fakes) + PATs; writes `oracle/fixture.json` |
| `zz_oracle_fakes.rb` | oracle-only initializer (never committed to the app): swaps `EnableBanking::Client.new` / `Llm::Client.for` for the repo's fakes |
| `oracle.sh` | single entry point: reset+seed dev DB → start Puma (127.0.0.1:3000, pid file) + Sidekiq → `capture.mjs main` → truncate users → `capture.mjs setup` → trap kills servers |
| `capture.mjs` | Playwright (playwright-core 1.63.0, Chromium headless shell rev 1243) HTTP + UI capture |
| `oracle_index.py` | builds `oracle/index.json` (route key → sample file + case statuses) |

Run: `timeout 2700 ./oracle.sh` (expects the repo at `/workspace/ruby-service-investigator/src`).

## Resume run 2026-10-22 (Docker)
- Services: `docker run -d --name obr-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:17` and
  `docker run -d --name obr-redis -p 127.0.0.1:6379:6379 redis:7` (the repo's docker-compose is not used).
- `oracle.sh` now uses `docker exec obr-pg psql` / `docker exec obr-redis redis-cli` (wrapper at `$W/runtime/redis-cli`) and honours
  `ORACLE_OUT` (scratch output dir). Layout expected under `$W`: `scripts/oracle_seed.rb`, `oracle/{capture.mjs,zz_oracle_fakes.rb,test_key.pem}`
  with `npm i playwright-core@1.63.0` in `$W/oracle`. `test_key.pem` is any RSA key: `openssl genrsa -out test_key.pem 2048`.
- Results: inventory identical (models.json after normalising Ruby object addresses; env.txt differs only by its hand-added section);
  specs 825 examples / 0 failures in 650 s (`inventory/specs_run_docker.json`); oracle 205 files / 344 cases with identical case names and
  status codes (`oracle/reproducibility_2026-10-22.json`).
