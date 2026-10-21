### U-001 Target stack for the Kotlin service is not defined
- **What is unclear:** The brief refers to a target stack in CLAUDE.md, but no project-level CLAUDE.md exists and Context Fabric has no prior Ruby→Kotlin decisions. Web framework (Spring Boot vs Ktor), persistence (JPA vs jOOQ/Exposed), job runner, UI technology are open.
- **Evidence for / against:** `/home/ubuntu/.claude/CLAUDE.md` only contains TraceVault instructions; `/project-workspace` has no CLAUDE.md; Context Fabric `wiki_find` exact `kotlin|spring|ktor` → no matches.
- **Who/what can resolve:** migration lead / architecture owner.
- **Human question?** yes (migration choice)
- **Proposed default:** Spring Boot 3 + Kotlin, jOOQ (or Spring JDBC) + Flyway, JobRunr, server-rendered templates keeping Hotwire JS.

### U-002 Oracle environment deviates from the brief: no Docker daemon
- **What is unclear:** Nothing functional — recorded for reproducibility. Docker was unavailable (`tcp://localhost:2375` refused, no socket, no sudo). Postgres 17.11 (zonky embedded binaries) and Redis 7.4.2 (built from source) were run in user space on 127.0.0.1:5432/6379 instead.
- **Evidence for / against:** investigator session log; `select version()` → `PostgreSQL 17.11`; `redis-cli ping` → PONG.
- **Who/what can resolve:** n/a (environment). Re-running `oracle.sh` with Docker-provided services should give identical results.
- **Human question?** no
- **Proposed default:** keep as documented.

### U-003 Oracle ran in RAILS_ENV=development, not test
- **What is unclear:** Brief says RAILS_ENV=test unless the README says otherwise. The test environment disables CSRF (`config/environments/test.rb: allow_forgery_protection = false`), uses the `test` ActionCable adapter and `:null_store`, which would hide real behaviour. The inventory and spec run used test; the HTTP/UI oracle used development (CSRF on, Redis cable, real Sidekiq worker). Side effects of development mode visible in the samples: detailed exception pages for 500s (production renders `public/500.html`), Bullet footer, `annotate_rendered_view_with_filenames` HTML comments, dev-only `/admin/debug*` routes.
- **Evidence for / against:** config/environments/{test,development}.rb; oracle samples.
- **Who/what can resolve:** n/a.
- **Human question?** no
- **Proposed default:** treat status codes, redirects, flash messages and JSON bodies as the contract; ignore dev-only page decorations.

### U-004 External systems exercised only through in-memory fakes
- **What is unclear:** Enable Banking and LLM providers were replaced in the oracle by the repo's own fakes (`spec/support/fakes/enable_banking_client.rb`, `spec/support/fakes/llm_client.rb`) via a temporary, uncommitted initializer. Real wire behaviour (JWT acceptance, pagination quirks of real ASPSPs, real LLM outputs, rate limits) is only documented from code and `spec/services/enable_banking/adapter_spec.rb` (WebMock).
- **Evidence for / against:** `/workspace/ruby-service-investigator/oracle/zz_oracle_fakes.rb` (oracle script); exception: `POST /admin/settings/preferences/llm/test` bypassed the fake and reached OpenAI with a fake key (operation run `llm_connection_test` failed with `Incorrect API key provided`).
- **Who/what can resolve:** a run against the Enable Banking sandbox with real TPP credentials and a real LLM key.
- **Human question?** no (needs credentials, not a decision) — but see the parity-policy question.
- **Proposed default:** contract tests against the fakes' interface + a manual sandbox smoke test before cut-over.

### U-005 Routes not exercisable with meaningful input
- **What is unclear:** Framework routes were called only with invalid input: ActionMailbox ingresses (postmark/relay/sendgrid/mandrill/mailgun), the ActionMailbox conductor (GET → 500 because `action_mailbox_inbound_emails` does not exist), ActiveStorage blob/representation/disk/direct-upload routes (no blobs exist, tables absent). The Grape mount itself (`MOUNT /`) has no sample of its own (covered by its 58 endpoints). Real bank redirects to `/callback` with a valid state were only exercised by specs (`spec/system/oauth_callback_success_spec.rb`), not by the oracle. Password reset with a valid token was not exercised (needs the e-mailed token).
- **Evidence for / against:** `../oracle/index.json`; `../oracle/http/GET_rails_conductor_action_mailbox_inbound_emails.json`.
- **Who/what can resolve:** scope decision (are framework routes part of the contract?).
- **Human question?** yes (scope) — folded into the framework-routes question.
- **Proposed default:** do not port ActionMailbox/ActiveStorage/ActionText/turbo-native routes.

### U-006 First-run `/setup` capture required truncating users
- **What is unclear:** Nothing functional. To capture the first-run flow the oracle truncated `users` (cascade) at the end of the run; the setup samples are appended as extra cases to `GET_setup.json`/`POST_setup.json` and screenshots `setup_first_run*.png`.
- **Evidence for / against:** `oracle.sh`.
- **Who/what can resolve:** n/a.
- **Human question?** no
- **Proposed default:** n/a.
