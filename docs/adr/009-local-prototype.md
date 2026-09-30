# ADR-009: Runnable synthetic prototype with explicit launch gates

Status: accepted for local development. This supplements [ADR-001 through ADR-008](../DECISIONS.md); it does not replace the target architecture or authorize production rollout.

## Context

The restaurant product needs a reviewable end-to-end workflow before live calls or reservation access. The repository previously held design/security requirements. External identity, hosting, restaurant onboarding, and reservation-vendor access are not established. The project owner has Twilio/OpenAI accounts and will configure secrets separately.

Developers and agents need useful synthetic scenarios without paid calls or a database server. The request-only workflow also needs real transaction and isolation behavior; JavaScript-only mock persistence cannot exercise PostgreSQL constraints or RLS.

## Decision

Implement a TypeScript/pnpm monorepo with React/Vite, Fastify, shared runtime contracts/domain rules, PostgreSQL, and separate Node voice/worker entrypoints. Pin Node.js 24.19.0 and pnpm 11.19.0.

Use PGlite, PostgreSQL compiled to WebAssembly, for persistent local synthetic Harbor Table/Juniper Kitchen tenants. Execute tenant work under restricted roles, forced RLS, composite constraints, and transaction-local context. Serialize complete embedded transactions and process jobs inside the owning API. Supply a native `pg` adapter and explicit migration command; embedded tests do not prove native deployment behavior.

Restrict demo authentication to loopback and its synthetic database. Use opaque signed cookies, CSRF/exact-origin protection, role checks, bounded sessions/login attempts, and rotation/logout. Add optional development OIDC with code/PKCE/state/nonce and explicit subject memberships. Sessions remain in process memory, and native tenants require separate provisioning.

Deliver a deterministic simulator for restaurant facts, reservation requests/messages, exact confirmation, staff handling, and uncertainty states. Submissions write synthetic inbox records only. Keep staff-reported evidence separate from guest communication. Provide request-only/mock connectors and disabled OpenTable/Resy adapters.

Implement Twilio Media Streams/OpenAI Realtime as an optional FAQ-only sandbox, disabled by default. Do not reuse simulator button confirmation as proof of voice consent. Phone request writes and human transfer stay unavailable until their call lifecycle, confirmation, and failure behavior are implemented and verified on real provider calls.

Reject `NODE_ENV=production`. Deployment, shared authentication/revocation, live voice actions, provider proof, retention/recovery, and pilot operations remain incomplete. Removing the guard alone is not a release procedure.

## Alternatives considered

| Alternative                                       | Reason for the chosen approach                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Require native PostgreSQL for every run           | Necessary for later deployment proof, but adds setup before synthetic exercises. PGlite provides the engine while retaining a native adapter. |
| JavaScript-only mock persistence                  | Cannot validate PostgreSQL RLS, constraints, receipts, or persisted jobs.                                                                     |
| Require real OIDC to try the demo                 | Makes local exercises depend on identity/tenant setup. Loopback-only sign-in bounds the development mode.                                     |
| Enable phone request writes/transfers immediately | Requires verified audio confirmation, call generations, durable phone control, and provider fallback. These stay explicit milestones.         |
| Treat mocked tests as production readiness        | Cannot establish real telephony, recovery, operational identity, or approved restaurant routing.                                              |

## Consequences

The demo starts without external credentials and preserves synthetic edits. Sessions are ephemeral and one process owns each embedded directory. It is unsuitable for customer records or multi-instance hosting.

Development OIDC maps each configured subject to one workspace and needs native PostgreSQL, HTTPS identity endpoints, role grants, and tenant setup. It does not provide membership administration, shared sessions, durable revocation, or verified MFA.

The phone bridge can use the owner's accounts, but mocked protocol tests do not establish a live-call result. The dashboard/simulator currently deliver more of the workflow than the FAQ-only phone sandbox; UI/docs must keep that distinction clear.

Target [security](../SECURITY.md), [operations](../OPERATIONS.md), and [architecture](../ARCHITECTURE.md) requirements remain valid. Restore-independent evidence, deletion/retention, call ownership, transfer reconciliation, and future vendor dispatch must be completed before their capabilities launch.

## Validation and reconsideration

Behavioral suites cover confirmation/idempotency, tenant/role boundaries, calendars/DST, staff uncertainty, PostgreSQL-engine RLS/persistence, and mocked voice. Browser tests exercise local staff/simulator workflows. Actual command outcomes and remaining gaps belong in [implementation status](../IMPLEMENTATION_STATUS.md).

Revisit when selecting production hosting/identity, enabling phone writes/transfers, introducing multi-process operation, or adding official vendor access. Replace development shortcuts with reviewed implementations and migration plans while preserving tenant, confirmation, and uncertainty invariants.
