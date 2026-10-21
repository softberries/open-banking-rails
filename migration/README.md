# Ruby → Kotlin migration specification (open-banking-rails)

Functional specification of this service at commit `cd3bf6054b54e7eb84fd4405919c70e41dfa2794`, produced for a Kotlin rebuild.
Start at [docs/00-overview.md](docs/00-overview.md). Decisions: [docs/decisions.md](docs/decisions.md). Open questions: [docs/unknowns.md](docs/unknowns.md).

- `docs/` — specification (00–80), `coverage.json` (every inventory entry → section, machine-checked), decisions, unknowns
- `inventory/` — machine-generated ground truth (routes, schema, gems, models, jobs, env, specs, coverage keys)
- `oracle/` — runtime capture: `http/` request/response samples per route, `ui/` screenshots + rendered HTML, logs
- `tools/` — scripts to reproduce the inventory, oracle and coverage check

The canonical copy lives in the project workspace (`/project-workspace/migrations/open-banking-rails`).
