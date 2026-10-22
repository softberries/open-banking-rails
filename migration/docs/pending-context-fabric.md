# Context Fabric facts — status (project `ruby-to-kotlin-migration-demo`)

The first run (2026-10-21) queued these facts here because the Context Fabric server's authorisation expired. Status after the resume run (2026-10-22):

| kind | scope | fact (short) | status |
|---|---|---|---|
| gotcha | open-banking-rails | build Tailwind (`bin/rails tailwindcss:build`) before `bundle exec rspec`; specs need `ACTIVE_RECORD_ENCRYPTION_*` keys + Postgres; 825 examples | already in team memory (`repo_insights`) |
| convention | project-wide | [ruby→kotlin] parity policy (D-002) | **stored 2026-10-22** (id `334aa226…`) |
| convention | project-wide | [ruby→kotlin] unused Rails engines / dev routes not ported; Sidekiq Web → job-runner dashboard; grape-swagger → OpenAPI 3 (D-006) | already in team memory (AGENTS.md) |
| convention | project-wide | [ruby→kotlin] documentation-only features are out of scope (D-014) | already in team memory (AGENTS.md) |
| gotcha | project-wide | "no Docker daemon in the investigator sandbox" | **out of date** — on 2026-10-22 the Docker sidecar at `$DOCKER_HOST` worked; corrected fact stored |
| gotcha | project-wide | Playwright: use npm `playwright-core@1.63.0` to match `/opt/ms-playwright/chromium_headless_shell-1243` | **stored 2026-10-22** (re-verified by the Docker oracle re-run) |
