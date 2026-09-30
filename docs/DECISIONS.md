# Initial architecture decisions

Implementation evidence: see [current prototype status](IMPLEMENTATION_STATUS.md) and [ADR-009](adr/009-local-prototype.md). The requirements below include later pilot and production work; they are not all implemented.

Status: accepted planning baseline for the requested documentation. These records are design choices for future implementation, not evidence of running services. Revisit a choice with observed requirements and a recorded replacement decision rather than silently changing the architecture. See [the implementation plan](IMPLEMENTATION_PLAN.md) for unresolved providers and access gates.

## ADR-001: Restaurant requests before automatic booking

Context: the initial product needs repeatable restaurant workflows, while vendor access and booking semantics are unknown. A table reservation requires authoritative inventory and confirmation, not an ordinary calendar appointment.

Decision: launch approved FAQs, reservation requests, messages, and staff transfers first. Staff fulfill requests using the restaurant's existing process and record booking evidence and guest contact separately. OpenTable and Resy remain optional later adapters.

Consequences: the first release avoids blocking on vendor access, but depends on staff responsiveness and must clearly tell callers their table is unconfirmed. Dashboard delivery does not imply staff attention or a completed reservation. Staff fulfillment needs exclusive ownership and reconciliation after interruptions; it is not a casual boolean status toggle.

Revisit: enable live booking per restaurant only after official authorized access, capability verification, safe uncertain-write handling, and sandbox/pilot evidence. Request-only mode remains an available explicit configuration.

## ADR-002: Shared platform with explicit tenant and location boundaries

Context: businesses need reusable core behavior and distinct information, permissions, phone routing, and credentials.

Decision: one tenant-isolated core with explicit locations, tenant/location ownership in records, authenticated server context, PostgreSQL row-level isolation, composite ownership constraints, and current-policy checks for actions and jobs. Use narrow privileged interfaces for authenticated number resolution and job discovery rather than granting ordinary services unrestricted cross-tenant data access.

Consequences: local development and tests must exercise real non-bypass database roles, connection pooling, jobs, and cross-tenant failures. UUIDs and application filters alone are insufficient. One-location pilots do not remove ownership requirements.

Revisit: stronger physical isolation may be added for scale or specific contractual requirements. It must retain the same business authorization invariants.

## ADR-003: TypeScript monorepo with separate streaming runtime

Context: the staff dashboard, business APIs, persistent audio, and durable jobs share contracts but have different runtime and reliability requirements.

Decision: pnpm/TypeScript with React/Vite dashboard, Fastify API, persistent Node.js voice gateway, and Node.js worker. Domain code stays independent of vendor SDKs and transport. Runtime schemas validate untrusted inputs; shared types do not replace validation.

Consequences: versioned contracts and compatible deploy/drain procedures matter for active calls. Shared code does not justify one overloaded process. Long-lived audio requires hosting proven to support its connection limits and streaming lifecycle.

Revisit: change frameworks or hosting only for a concrete implementation constraint. Provider choices remain provisional; verify current official documentation before writing integration code.

## ADR-004: PostgreSQL transactional outbox before a separate queue

Context: committed requests, staff inbox publication, and action outcomes must survive disconnections without a dual-write gap.

Decision: persist business changes and an outbox event atomically. Use durable leased jobs, deduplication, fencing, bounded retries, and a result ledger. Add a dedicated queue only when measured throughput/operations justify it.

Consequences: delivery is at-least-once and jobs must be duplicate-safe. Lease expiry is not permission to repeat an uncertain external write. Database contention, batch size, and backlog need monitoring. Restricted dispatch discovers job references, then work executes within verified tenant context. A restore-independent, restricted recovery journal preserves deletion decisions and future live-write dispatch evidence; restored jobs remain quarantined until replay and reconciliation prove safe state. The journal adds a separate availability dependency and does not make vendor writes part of an atomic database transaction.

Revisit: introduce a queue adapter after measurements, preserving durable transaction and reconciliation semantics rather than pretending end-to-end delivery is exactly-once.

## ADR-005: Model proposes; deterministic services authorize

Context: speech, model outputs, retrieved knowledge, and provider data may be inaccurate or malicious. Natural-language understanding is not an authorization system.

Decision: named schema-validated tools with fixed permissions and server-derived context. Bind explicit caller agreement to a versioned exact proposal and expire it when material details change. Do not give the model arbitrary network, SQL, credential, tenant, or transfer-destination access.

Consequences: conservative clarification and evaluation are necessary; server validation cannot guarantee that the speech model interpreted every caller correctly. Sensitive future changes/lookup require separate verification, beyond caller ID or readback agreement.

Revisit: richer workflows need narrowly scoped capabilities, new tests, and documented verification rules rather than arbitrary business-authored executable instructions.

## ADR-006: Optional verified vendor capabilities

Context: OpenTable and Resy may have different commercial access, scopes, APIs, rate limits, and outcome semantics.

Decision: shared normalized contracts and conformance tests, independently gated vendor implementations, explicit unknown/unsupported/verified evidence, and per-installation permissions. Start with request-only and clearly labeled deterministic fake providers.

Consequences: no live API availability is assumed. No scraping, consumer-session reuse, undocumented endpoints, or staff-password automation. If an ambiguous write cannot be resolved reliably, automatic retry remains blocked and the capability may need to be restricted or withheld.

Revisit: enable each operation only with its own documented access, authorization, result integrity, and operating evidence. Completion of one vendor does not establish access to another.

## ADR-007: Minimal retained voice data; biometrics deferred

Context: audio, transcripts, names, callback details, and dietary notes create privacy obligations; recognition signals cannot prove caller identity.

Decision: raw recording is off by default, transcripts follow an explicit minimal retention policy, and provider processing/retention must be reviewed separately. Retain structured operational records and minimal audited outcomes. Defer voiceprints and synthetic-voice detection.

Consequences: operators need privacy-preserving diagnostics, consent/disclosure configuration, deletion/offboarding, and restore procedures that preserve deletion decisions. Turning off local recording does not mean no provider processes audio.

Revisit: future recording or biometric features require a separate product/security/privacy design, verified enrollment where applicable, explicit consent, deletion/revocation, spoofing and error evaluation, and stronger verification for sensitive actions.

## ADR-008: External staff identity, local authorization

Context: the platform needs reliable sign-in and MFA while restaurant membership and permissions remain application-specific.

Decision: use an external OIDC provider; validate tokens/callbacks/sessions and enforce current local memberships and role/location permissions on each action. Keep service identity separate from caller and staff identity.

Consequences: identity provider selection is an implementation dependency. A valid token does not authorize another tenant, revive revoked membership, or grant unrestricted support access. Cookie sessions require CSRF protection and secure lifecycle management.

Revisit: change identity vendors with a migration and account-linking plan. Do not build custom password authentication incidentally.
