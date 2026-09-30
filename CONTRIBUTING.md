# Contributing

Hostline has a runnable local synthetic prototype. Start with [implementation status](docs/IMPLEMENTATION_STATUS.md), [the build brief](BUILD_BRIEF.md), [architecture](docs/ARCHITECTURE.md), [security guidance](docs/SECURITY.md), and [engineering standards](docs/ENGINEERING.md). Coding agents must also follow [AGENTS.md](AGENTS.md). Architecture and rollout documents contain requirements beyond the current implementation; code or a passing mock test does not establish a live integration.

## Scope and branch workflow

Choose an independently reviewable task from [the implementation plan](docs/IMPLEMENTATION_PLAN.md). State its observable behavior and acceptance criteria. The first pilot uses reservation requests for staff review; a saved request is never a confirmed table. Connector interfaces do not authorize live reservations or establish Resy/OpenTable access.

Inspect `git status`, the current branch, remotes, and relevant scripts first. During the current prototype phase, the owner requests direct commits and pushes to `main`, without creating pull requests. Temporary task branches may support local work, but validate and integrate their changes onto `main` before pushing. Preserve user changes and other agents' edits; do not reset, discard, stash, or reformat unrelated work. Stage explicit task paths and inspect the staged diff. Commit and push when requested or already authorized. Do not force-push or rewrite shared history without specific authorization.

In a shared workspace, assign distinct file ownership before parallel edits. One contributor owns common manifests, lockfiles, migrations, integration, and final Git operations. Resolve ownership conflicts directly rather than overwriting another contributor's changes.

## Local development

Use Node.js **24.19.0** (`.node-version`) and pnpm **11.19.0** (`package.json`). Install the committed dependency graph, then run the demo:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

The dashboard is at `http://127.0.0.1:5173` and proxies `/api` to `127.0.0.1:3001`. Use the exact configured origin. Default demo authentication is allowed only on loopback and uses synthetic Harbor Table and Juniper Kitchen workspaces. No Twilio, OpenAI, OIDC, or database-server credentials are needed.

The API stores data in `.data/hostline` using PGlite, PostgreSQL compiled to WebAssembly. Seeds are idempotent: restart preserves edited settings, requests, and receipts. Its transaction mutex prevents overlapping tenant contexts on the embedded connection. Run one API process per embedded data directory; do not start a separate worker against it. Internal jobs run in the API process. Session state is in memory and is lost on restart.

API, voice gateway, migration, and worker entrypoints load a root `.env` when present. Keep secrets in environment configuration or ignored `.env`; never put them in chat, committed files, fixtures, screenshots, or frontend variables. Copying `.env.example` leaves the phone gateway disabled.

```text
apps/dashboard/         React/Vite staff dashboard
apps/api/               Fastify auth, configuration, inbox, simulator APIs
apps/voice-gateway/     Optional Twilio/OpenAI voice/action sandbox
apps/worker/            Native PostgreSQL internal job worker
packages/contracts/    Shared Zod schemas and TypeScript contracts
packages/domain/       Conversation, time, confirmation, fulfillment rules
packages/database/     PGlite/pg adapters, migrations, synthetic seed
packages/connectors/   Capability gates, fake adapters, future-write rules
packages/config/       Validated server environment and startup gates
packages/observability/ Safe structured operational events
tests/                 Credential-free behavioral and browser tests
```

## Commands and prerequisites

| Command                               | What it does                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`      | Reproduce locked dependencies.                                                                |
| `pnpm dev`                            | Start the local API and Vite dashboard together.                                              |
| `pnpm dev:api` / `pnpm dev:dashboard` | Start one component when debugging. Avoid a second API on the same data directory.            |
| `pnpm dev:voice`                      | Start the separate voice gateway; disabled without explicit sandbox configuration.            |
| `pnpm format:check` / `pnpm format`   | Check formatting / rewrite formatting. Limit writes to owned files in shared work.            |
| `pnpm lint`                           | Run ESLint on repository source.                                                              |
| `pnpm typecheck`                      | Check workspace source and tests with strict TypeScript.                                      |
| `pnpm test`                           | Run credential-free domain, connector, auth, API, PGlite, and mocked voice tests.             |
| `pnpm test:e2e`                       | Run Playwright dashboard and simulated-workflow tests; requires Chromium.                     |
| `pnpm build`                          | Bundle API, worker, and voice services; build the dashboard. No deployment occurs.            |
| `pnpm check`                          | Run formatting, lint, typecheck, deterministic tests, and builds. Browser tests are separate. |
| `pnpm start`                          | Start the built API. Does not serve or deploy the dashboard.                                  |
| `pnpm db:migrate`                     | Apply checked-in migrations to `DATABASE_MIGRATION_URL` with a dedicated migration identity.  |
| `pnpm worker`                         | Run internal jobs against provisioned native PostgreSQL using `DATABASE_URL`.                 |

Install the browser with `pnpm exec playwright install chromium` (CI also installs OS dependencies). Inspect Playwright configuration before using a custom environment. Browser tests use synthetic workspaces and may modify demo records.

Default database tests use PGlite's actual PostgreSQL engine for SQL constraints, RLS, transactions, and persistence. They do not exercise a native server's network pooling, TLS, identity grants, or operations. There is no separate `test:integration` script: credential-free database/API integration tests are part of `pnpm test`.

Provider sandbox checks are separate. Do not initiate real calls, forward a restaurant number, submit real reservations, or contact customers as incidental verification. Follow [voice setup](docs/VOICE_SETUP.md) and record which real-provider scenarios were actually verified.

## Native PostgreSQL and development OIDC

The `pg` adapter and OIDC flow are implemented; deployment/provisioning remains an operator task. Use a disposable development database, migrate through `DATABASE_MIGRATION_URL`, and configure a separate `DATABASE_URL` runtime identity. That identity must be able to assume `hostline_app` and `hostline_worker`, must not own protected tables, and must not be a superuser or have `BYPASSRLS`. Verify actual grants and forced RLS on the target server. PostgreSQL-backed API startup does not migrate or insert demo tenants.

Provision authorized tenant configuration through a controlled operator procedure; a subject mapping alone does not create a restaurant. Configure an HTTPS OIDC issuer/client, the dashboard's exact HTTPS origin, callback `/api/auth/callback`, a strong persistent session secret, and explicit `OIDC_MEMBERSHIPS`. Each verified subject maps to one tenant and one `owner`, `staff`, or `viewer` role. Provider claims and browser tenant fields do not grant membership. OIDC code/PKCE/state/nonce composition is covered with a mocked provider; verify a real identity provider separately.

Sessions live in one API process for at most eight hours. Shared session storage, durable membership administration/revocation, MFA verification, and production deployment controls remain launch gates. `NODE_ENV=production` is deliberately rejected; removing its guard does not complete those gates.

## Implementation and meaningful tests

Keep business rules independent of Fastify, UI components, database drivers, and provider SDKs. Use strict TypeScript plus runtime schemas at trust boundaries. Derive tenant identity and permissions from verified server context. Use parameterized queries, explicit transaction scope, tenant-safe keys, optimistic versions, and supported capabilities.

Prioritize tests for cross-tenant access, stale edits, duplicate confirmation, concurrent fulfillment, ambiguous dates/DST, failed callbacks, uncertain writes, expired leases, and attempts to expand model permissions. Use fake clocks or synchronization instead of arbitrary sleeps. Do not add tests solely to mirror private implementation or inflate coverage.

For database changes, include ordered migrations, runtime-role checks, compatibility notes, and recovery impact. For remote writes, require explicit confirmation, durable idempotency, bounded timeouts, and reconciliation. The existing future-write simulation is not a durable external operation service; keep live writes disabled until that service and provider contracts are verified.

Preserve truthful UI and caller status. Staff booking evidence is `STAFF_REPORTED`; guest communication is separate. Simulator confirmation uses a visible explicit button; it does not prove voice confirmation or audio readback delivery. Keep recordings, biometric enrollment, payments, and live customer messaging outside incidental development.

Phone work must preserve [ADR-010](docs/adr/010-phone-actions.md) and [call-control behavior](docs/TWILIO_CALL_CONTROL.md). Models may prepare requests/messages or ask for the configured staff line, but cannot confirm/save, choose tenant identity, or supply a dialing target. Canonical readback uses Twilio `<Say>` outside and before `<Gather>`; a verified call-bound callback and current proposal checks authorize the inbox write. Resolve relative dates from the server-issued handle for the date-bearing utterance. Simulator endpoints must reject phone calls.

Use durable call records, generation checks, one-use grants, callback receipts, and terminal tombstones. Persist dispatch admission before the one external call update; only its atomic winner sends it. Do not automatically repeat an uncertain update. Callback arrival before the REST acknowledgment is a valid race; late acknowledgments and duplicate callbacks must preserve newer or terminal state. Lease expiry and local socket closure do not prove provider termination or justify releasing unresolved capacity.

Voice, request actions, and staff transfers have separate false-by-default flags. Mocked consent or transfer tests do not prove real readback playback, speech recognition, voicemail handling, carrier forwarding, or live callback delivery. Record that evidence separately on a dedicated test number. A staff line being answered is not proof that a person accepted the call, and saved reservation requests remain unconfirmed.

Follow [phone operations](docs/PHONE_OPERATIONS.md) for owner-only policy writes, minimized staff context, and read-only provider reconciliation. Persisted restaurant policy can restrict configured capabilities but cannot override the environment ceilings. Bind calls and pending consent to the policy version; an edit invalidates earlier versions even after reenablement. Recheck immediately at API mutation boundaries, and describe gateway checks using their actual bounded polling/timeout behavior rather than claiming instant knowledge refresh.

Policy edits serialize with durable dispatch admission. An update admitted first may still reach the provider after revocation; do not describe that window as canceled or proven unsent. Later request confirmation rechecks current authority, while outcome callbacks preserve already-admitted evidence.

Provider status reads use fixed account/call targets and bounded complete child-leg evidence. Fetch outside the database transaction, then compare the current record version before releasing a confirmed terminal hold. Stale, unavailable, truncated, unbound, or nonterminal evidence keeps capacity held; do not add a manual release, force hangup, or uncertain redispatch. Browser responses must exclude raw provider IDs, grants, tokens, TwiML, credentials, audio, and full transcripts. Handoff context is labeled untrusted and does not confirm a proposal or prove staff acceptance.

## Documentation, decisions, and review

Update affected docs with the change, especially [implementation status](docs/IMPLEMENTATION_STATUS.md). Explain implemented behavior, checks run, and operational dependencies. Preserve incomplete requirements in architecture/security docs and link the gap rather than silently weakening them.

ADR-001 through ADR-008 are in [initial decisions](docs/DECISIONS.md). Later records include [ADR-009](docs/adr/009-local-prototype.md) and [ADR-010](docs/adr/010-phone-actions.md). Record consequential decisions with context, alternatives, consequences, evidence, and reconsideration criteria. Mark superseded records explicitly.

For the current direct-to-main workflow, keep a reviewable diff and record the concrete change, resulting behavior, verification, and limitations in the handoff. If the owner later requests pull requests, use [the PR template](.github/pull_request_template.md). Review tenant/role access, runtime validation, confirmed-field binding, retry uncertainty, privacy, migration impact, and failure recovery. Authentication, tenant isolation, provider-write, and phone-routing changes need independent review; agent review does not replace accountable launch approval.

GitHub Actions is configured to install dependencies, run checks, and run browser tests. Report its result only after observing the run. Branch protection, required checks, secret scanning, dependency-review enforcement, and protected deployment environments need separate verification. A workflow file alone does not prove enforcement. Default CI must not receive production secrets or make provider writes.

## Security reporting

Follow [SECURITY.md](SECURITY.md). Do not put credentials, caller records, or sensitive exploit details in public issues or PRs. Use synthetic reproductions and an already authorized private reporting channel. Do not use live customer data to demonstrate a vulnerability.
