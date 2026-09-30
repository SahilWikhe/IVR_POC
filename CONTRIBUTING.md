# Contributing

This project is in its documentation phase. There is no runnable application, package manifest, test runner, CI workflow, database migration runner, or configured provider integration yet. The standards below describe how implementation work should proceed; they are not implemented controls.

Start with [the build brief](BUILD_BRIEF.md), [architecture](docs/ARCHITECTURE.md), [implementation plan](docs/IMPLEMENTATION_PLAN.md), [security guidance](docs/SECURITY.md), and [engineering standards](docs/ENGINEERING.md). Coding agents must also follow [AGENTS.md](AGENTS.md).

## Scope and branch workflow

Choose a small, independently reviewable task from the implementation plan. State its user-visible behavior and acceptance criteria before coding. The first pilot uses reservation requests for staff review, while mocks exercise future connector contracts. Building a provider adapter interface does not authorize live reservations or prove access to Resy or OpenTable.

Inspect `git status`, the current branch, remotes, and existing scripts first. Use a task branch when appropriate to the repository workflow; do not move or discard someone else's work to create one. Keep unrelated formatting, dependency upgrades, and refactors out of the change. Stage only explicit task paths and review the staged diff before committing. Commit and push when the user or established workflow authorizes them. Never force-push or rewrite shared history as a routine cleanup.

In shared workspaces, agree on file ownership before parallel edits. Avoid multiple agents editing a common manifest or migration sequence independently. The coordinating contributor resolves integration conflicts and checks the complete change.

## Planned development environment

The implementation baseline is a pinned, supported Node.js LTS release, strict TypeScript, and `pnpm` workspaces with a committed lockfile. Select and record exact versions in the scaffold milestone; do not assume they are installed or configured today. Use the same pinned versions locally and in CI. Provide `.env.example` with placeholder values and explanations only; actual credentials belong in the approved secret store or ignored local configuration.

Planned layout:

```text
apps/dashboard/       React + Vite staff dashboard
apps/api/             Fastify control API
apps/voice-gateway/   Persistent WebSocket and call lifecycle service
apps/worker/          Node.js delivery, reconciliation, retention jobs
packages/domain/     Provider-independent business rules
packages/contracts/  Runtime schemas and versioned API/event contracts
packages/connectors/ Capability contracts, mock adapters, approved vendor adapters
packages/config/     Configuration validation and environment loading
packages/observability/ Redacted logs, metrics, traces
```

Each application's runtime dependencies and start command must be explicit. The voice gateway needs hosting that supports persistent audio connections, draining, and the provider's connection limits. Do not assume that a generic stateless function runtime meets those requirements.

## Proposed command contract

The scaffold must define and document these scripts before contributors can use them. These commands are **planned, unavailable today**:

| Proposed command | Required purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Reproduce locked dependencies once the manifest and lockfile exist. |
| `pnpm dev` | Start a documented local environment using mock connectors by default. |
| `pnpm format:check` | Check formatting without modifying files. |
| `pnpm lint` | Check source and dependency boundary rules. |
| `pnpm typecheck` | Check every workspace with strict TypeScript. |
| `pnpm test` | Run deterministic unit and behavioral tests without provider credentials. |
| `pnpm test:integration` | Exercise real PostgreSQL isolation, constraints, jobs, and API contracts in a disposable test environment. |
| `pnpm test:e2e` | Verify staff workflows and simulated calls against the local test environment. |
| `pnpm build` | Build every deployable application and required packages. |

When implementation adds a script, document its prerequisites, expected environment, and what it excludes. Provider sandbox checks must be separate from credential-free defaults and require authorized sandbox access. Production migrations and deployment are separate operational procedures, never an incidental side effect of `dev`, `test`, or `build`.

Until the scaffold exists, documentation validation means inspecting the changes, verifying internal links, checking consistency across specifications, and checking Git whitespace. Do not report lint, typecheck, or tests as passed when those tools do not exist.

## Implementation and tests

Follow the [engineering standards](docs/ENGINEERING.md). Use deterministic validation and authorization outside model prompts. Keep restaurant requests distinct from confirmed provider bookings. Test outcomes including failures and retries, not only the happy path.

Meaningful tests include another tenant attempting to read a message, duplicate webhooks attempting a second write, a connector timing out after committing a booking, a worker crashing between storage and delivery, an ambiguous daylight-saving time, a failed transfer, and staff handling a request concurrently. Use synthetic restaurants and callers. Do not add tests solely to mirror private helper implementation, snapshot large unimportant output, or inflate coverage. A typo or other low-impact documentation change usually needs review rather than a new test.

For API or database changes, update schemas, migration notes, and compatibility handling. For authorization, connector write behavior, caller confirmation, retention, and time resolution, include tests that would fail if the intended invariant breaks. Review database migrations against a disposable database with representative synthetic data and the actual restricted application role.

## Documentation and decisions

Update affected documentation in the same change. Keep the build brief, architecture, security requirements, connector matrix, and implementation plan consistent. Document operational behavior when adding services, external dependencies, background jobs, or rollout steps.

The initial ADR-001 through ADR-008 records are in [docs/DECISIONS.md](docs/DECISIONS.md). Add subsequent architecture decision records under `docs/adr/` for decisions with lasting consequences, such as provider selection, identity provider, deployment runtime, data retention defaults, queue design, or a contract change; continue the numbering and link the relevant initial records. The future ADR directory is not yet required scaffolding. Each new record should contain status, context, decision, alternatives considered, consequences, validation, and links to related decisions. Mark superseded records explicitly rather than erasing the decision history.

## Pull requests and review

Use [.github/pull_request_template.md](.github/pull_request_template.md). Describe the behavior a reviewer can evaluate, the exact checks performed, and material limitations. Mark checks as not applicable or not run with a reason when appropriate; unchecked or documented controls do not establish safety.

Reviewers should verify the intended behavior, tenant and role authorization, caller-facing claims, bounded retries and uncertain outcomes, failure recovery, data minimization, migration compatibility, and test evidence. Changes to authentication, tenant isolation, provider writes, phone routing, and retention need review by someone responsible for those areas once maintainers are assigned. Independent agent review is useful evidence, but does not substitute for required repository or release approvals.

Merge requirements and branch protection are planned, not configured. The scaffold/CI milestone must establish automated formatting, lint, typecheck, tests, builds, secret scanning, and dependency review, then document which are blocking. Do not claim these gates exist before configuration is verified.

## Reporting security concerns

Do not publish credentials, caller records, or exploit details in a public issue or PR. Use the repository's private reporting mechanism once it is configured. Until then, privately notify the project owner through an already authorized channel, describe the affected component and reproduction using synthetic data, and avoid broadcasting sensitive details. Do not use live customer data to demonstrate a vulnerability.
