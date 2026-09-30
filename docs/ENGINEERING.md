# Engineering standards

These are implementation requirements for the planned restaurant receptionist. No source scaffold, automated enforcement, or production service exists yet. Follow [architecture](ARCHITECTURE.md), [security guidance](SECURITY.md), and [the implementation plan](IMPLEMENTATION_PLAN.md) alongside this document. A documented requirement is not proof that a control is implemented.

## Boundaries and ownership

The planned Node.js/TypeScript workspace contains a React/Vite dashboard, Fastify API, persistent WebSocket voice gateway, Node.js worker, and shared domain, contracts, connectors, configuration, and observability packages. Keep process-specific startup and shutdown code in each application.

- `domain` owns business invariants and lifecycle transitions. It must not import HTTP frameworks, database clients, voice SDKs, or provider adapters. Prefer pure functions; use explicit injected interfaces for required effects.
- `contracts` owns runtime schemas and versioned HTTP, event, job, and tool payloads. Share safe contracts, not server secrets or database models, with the browser.
- `connectors` implements documented capabilities behind an interface. Unsupported operations are explicit. Mock adapters exercise the same result semantics as future approved vendor adapters.
- `config` validates environment and tenant configuration. Load server secrets only in server processes. Client configuration must use an explicit safe allowlist.
- `observability` provides common redaction, structured event fields, trace propagation, and metrics. It does not become a hidden authorization mechanism.

The voice gateway streams audio and controls call state. It must not block the audio loop with long database transactions, delivery jobs, or unbounded provider calls. API and worker operations reuse domain and authorization rules so background execution cannot bypass them. Do not place authoritative business logic solely in a dashboard, prompt, or connector SDK wrapper.

## TypeScript and runtime contracts

Enable `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` when establishing the scaffold. Avoid `any`, unchecked casts, non-null assertions, and disabled lint rules without a narrow explanation. Represent unknown input as `unknown` until validated. Use exhaustive discriminated unions for action outcomes and lifecycle states; do not collapse unsupported, rejected, pending, failed, and unknown outcomes into a boolean.

Validate HTTP bodies, query parameters, headers where relevant, provider callbacks, WebSocket setup, tool arguments, job payloads, database JSON, and remote responses at entry. Use one chosen runtime schema library consistently; Zod is a reasonable candidate to confirm during scaffolding. Limit field sizes, collection sizes, audio/session duration, request bodies, and allowed values. Reject or explicitly strip unknown fields according to the endpoint contract.

Separate external identifiers from internal call, request, tenant, and booking identifiers. Never infer authorization from an identifier's format or unpredictability. Version externally persisted events and jobs so producers and consumers can coexist during rolling deployments. Define compatibility and retirement rules before changing an existing contract.

Prefer readable small modules with explicit dependencies and descriptive names. A useful abstraction represents a business boundary or repeated rule; do not wrap every function or speculate about unused future industries. Comment reasons and non-obvious invariants rather than restating code. Record unfinished safety behavior as a tracked gap with a blocked capability, not a permissive TODO.

## Deterministic action execution

An action must pass server-side tenant resolution, authorization, capability checks, validated parameters, restaurant rules, and required caller confirmation before execution. Resolve the tenant from the verified inbound phone routing or authenticated staff context; tool arguments cannot select it. Bind a confirmed field set to the authorized action and re-confirm if material fields change.

Persist an action identifier and normalized input fingerprint before externally observable writes. Reusing an idempotency key with different input is an error. Scope keys to tenant, operation, and appropriate call/request context. Make uniqueness a database constraint rather than an in-memory convention. Return an existing outcome for an exact replay when permitted.

Future live bookings need an immutable persisted `execute_before` bound to the approved intent, distinct from confirmation-token expiry and request timeouts. Derive it before approval from caller-agreed wait limits, offer validity, and restaurant policy. Gate first dispatch atomically and recheck immediately before send after intervening waits; proven-unsent expiry is terminal and requires fresh agreement/new linked work. Never extend the deadline on retry or treat an already-sent/uncertain write as expired without reconciliation. This does not expire saved request-only inbox items.

The request-only MVP stores a reservation request directly in the authenticated staff inbox and queues internal follow-up events atomically. Its caller statement can report that the request was saved; it must not report a confirmed table, staff acknowledgment, or future external-channel delivery until the relevant evidence exists. Future provider reservations require a verified provider success and reference. A timeout after submission is an uncertain outcome and requires reconciliation, not an invented failure or an automatic second booking.

Use deterministic mock scenarios for supported operations, unsupported operations, expired availability, conflicting capacity, duplicate invocation, rate limits, timeout-before-write, timeout-after-write, and credential expiry. No mock may suggest that an approved Resy or OpenTable integration already exists.

## Asynchronous work and errors

Every external call needs an explicit deadline, cancellation where supported, bounded response size, and documented retry policy. Propagate call termination to work that no longer needs to run. Preserve already committed tasks that must finish safely after the caller disconnects.

Avoid detached promises and unhandled rejections. A task needing durable completion belongs in a persisted job; process memory and `setTimeout` are not a reliable queue. Close database clients, streams, and sockets during graceful shutdown, drain established sessions within a bounded period, and make interrupted jobs recoverable.

Use typed error categories such as validation, forbidden, unsupported, unavailable, rate-limited, and uncertain-write. Preserve internal cause and a safe correlation identifier, but expose a concise caller/staff message without vendor secrets or raw payloads. Distinguish retryable from terminal errors. Never catch and silently turn a failure into a successful result.

Retry only safe operations with exponential backoff, jitter, an attempt cap, and a total deadline. Respect provider rate limits and `Retry-After` where defined. An external write is safe to retry only when documented idempotency covers it or reconciliation proves a retry cannot duplicate it. Use circuit breakers and concurrency limits where justified, and document how a tripped dependency affects caller fallback.

## PostgreSQL, isolation, and migrations

Every tenant-owned record includes `tenant_id`. Use tenant-scoped queries and composite foreign keys or equivalent constraints so a record cannot reference another tenant's parent. Choose uniqueness scopes deliberately, including message/action idempotency and external provider references. Provider callback identifiers may require a separate verified routing mapping; do not accept an arbitrary tenant supplied in a callback body.

Enable and test row-level security on tenant tables. The application role must not own protected tables or have superuser/`BYPASSRLS` privileges. Set tenant context transaction-locally before queries and clear it automatically at transaction end; pooled connections must never retain a prior tenant's context. Test isolation through the actual application role. RLS supplements explicit application authorization and tenant-safe constraints.

Keep a separate, tightly controlled migration role. Any privileged cross-tenant worker or administration role must be deliberately scoped, audited, and tested; do not give normal API or worker execution a bypass role for convenience. Parameterize queries and allowlist identifiers when dynamic SQL is unavoidable.

Transactions should be short and not await remote calls. Atomically persist business changes and outbox events in one transaction. A worker obtains a job lease with an expiry and unique ownership token; updates must check current lease ownership so a stale worker cannot overwrite a replacement worker's outcome. Reclaim expired leases, cap attempts, and support quarantined jobs and controlled redrive. Treat outbox consumption and delivery as at least once; deduplicate business effects.

An external send may succeed just before the worker loses its lease or crashes. Use provider idempotency when available; otherwise distinguish delivery uncertainty and reconcile or allow controlled manual handling. Do not promise exactly-once external delivery based on a database lease.

Use checked-in, ordered migrations. Prefer expand/backfill/contract changes so old and new application versions can coexist. Validate against a disposable database with representative synthetic volume and the restricted application role. Document lock impact, timeout settings, data backfill, verification, deployment order, and recovery. Never run production migrations automatically when a web process starts. Destructive cleanup follows a separately reviewed retention/migration plan.

## Time, identifiers, and values

Store event instants in UTC and record the restaurant's IANA timezone. Resolve phrases such as “tomorrow” using that timezone and the server-recorded start timestamp of the relevant caller utterance. Persist the reference timestamp and utterance ID with the proposal; do not use call-start time or the later parsing/worker clock. Preserve the caller-confirmed explicit local date/time, timezone, and resolved instant through retries and midnight changes. A relative-date correction uses its new utterance timestamp and requires a new readback/confirmation; delayed replay cannot reinterpret an existing agreed date.

Reject impossible dates, detect nonexistent and repeated daylight-saving times, and clarify ambiguous times with the caller. Do not silently pick an offset or normalize a nonexistent time. Read back the exact calendar date, time, and relevant timezone before submission. Test midnight boundaries, holidays, overnight operating hours, and a daylight-saving change.

Distinguish recurring weekly hours from dated exceptions and reservation availability. A restaurant being open does not imply a table is available. Preserve provider identifiers as opaque strings; do not parse meaning from them. Use integer minor units or explicit decimal types for monetary values, with currency attached; never derive prices by floating-point arithmetic. Payments are outside the first pilot.

## Security in code

Apply the [security requirements](SECURITY.md) at code review and implementation. In particular:

- Authenticate staff and verify roles and location access on every operation. Browser controls and model prompts are not enforcement. Use secure sessions, explicit cross-origin configuration, CSRF protection where the authentication mechanism requires it, and step-up verification for sensitive changes.
- Validate provider signatures against documented request canonicalization using a supported implementation. Check replay protection and deduplicate callback effects. A signature verifies a provider event, not arbitrary privileges implied by its payload.
- Route by a server-controlled phone-number mapping. Restrict transfer targets, outbound destinations, tools, network egress, and callback URLs to approved values. Prevent transfers that forward back into the AI number and limit transfer attempts.
- Treat caller speech, knowledge text, connector output, and model output as untrusted data. Tool authorization stays deterministic. Do not allow model-selected URLs, credentials, SQL, shell commands, or arbitrary tool names.
- Keep credentials in a secret manager, scope them to the restaurant/provider where possible, and never bundle them into client code. Ensure logs and tracing redact credentials, phone numbers, and request bodies by default. Environment validation errors must name missing keys without printing their values.
- Enforce size, duration, rate, and cost budgets on calls and public endpoints. Scope limits across caller/session, tenant, and platform as appropriate so one restaurant cannot consume all capacity.
- Minimize stored personal data. Keep recordings off by default unless explicitly approved and configured. Transcript, message, action-audit, and backup retention are separate decisions; deletion jobs must cover relevant derived data and credentials according to policy.

Caller ID, voice matching, and synthetic-voice scores are not authentication. Voiceprints and fraud scoring are later, separately designed capabilities; do not introduce them into the MVP or collect enrollment samples incidentally. Do not solicit payment cards, passwords, or sensitive identifiers in free-form caller flows.

## Dashboard and operator experience

Display reservation requests as pending staff review and distinguish saved, delivered, acknowledged, and resolved status. Use server-enforced transition rules and optimistic version checks for concurrent staff updates. Handle stale data explicitly instead of overwriting another staff member's decision.

Validate and preview changes to hours, knowledge, actions, transfer destinations, and connector capabilities before publication. Track an approved configuration revision per call so debugging can reproduce what the caller was told. Explain failed saves and pending work; do not optimistically claim that a booking or external change succeeded.

Use accessible labels, keyboard interaction, visible focus, readable error text, and sensible loading states. Do not expose implementation details or raw model traces to restaurant staff unless they support a useful operational decision. Hide unnecessary caller details and require the appropriate permission before showing sensitive records.

## Dependencies and build hygiene

Pin the package manager and Node.js baseline, commit the lockfile, and use frozen installs in CI. Do not add dependencies that lack a clear use case, maintenance, and acceptable licensing. Prefer supported SDKs and well-maintained libraries for cryptography, signature validation, authentication, and database access rather than custom implementations.

Separate dependency upgrades from behavior changes where practical. Inspect advisories and transitive changes, document relevant exposure, and verify the affected feature after updating. Apply a time-bound remediation process for material vulnerabilities. Configure secret scanning and dependency checks during the CI milestone; no such tools are enforced merely because this document names them.

Keep generated artifacts, local environment files, caller recordings, credentials, and test output containing personal data out of Git. Examples use placeholders and synthetic records. Browser builds must be checked for accidentally included server configuration. Test and build scripts must not make live provider writes.

## Testing and observability

Tests should establish business behavior and safety invariants. Use fast domain tests, adapter contract tests, integration tests against real PostgreSQL with RLS, and a small set of end-to-end simulated call/staff workflows. The deterministic default suite must not need phone numbers, provider credentials, live customers, or a paid voice service.

Prioritize cases that can harm callers or restaurants: cross-tenant reads/writes, replayed webhooks, mismatched confirmation fields, concurrent staff changes, duplicate delivery, uncertain booking writes, expired leases, stale configuration, unsupported capabilities, ambiguous times, failed transfers, and incorrect reservation confirmation. Use explicit synchronization and fake clocks for races and timeout scenarios instead of sleeping arbitrary durations. Match tests to observable outcomes rather than internal function calls.

Emit structured events with safe call/action/job IDs, tenant context when permitted, component, operation, outcome, duration, and correlation IDs. Do not emit raw audio, transcripts, secrets, or phone numbers into general logs. Redact errors before logging and audit access to retained call records. Use low-cardinality metric labels; unique IDs belong in access-controlled traces/logs rather than metric labels.

Measure call setup and response latency, dropped streams, transfer outcomes, message delivery age, outbox lag, job lease expiry, unknown writes, authorization failures, provider errors, and cost budgets. Alerts require an owner and an operational response. Capture enough structured provenance to investigate behavior without storing unlimited conversation content.

## CI and review requirements

The scaffold milestone must add scripts and CI for formatting, lint, strict typechecking, meaningful tests, builds, migration validation, secret scanning, and dependency review. Establish required checks and branch protection explicitly. Until then, proposed checks in [CONTRIBUTING.md](../CONTRIBUTING.md) are unavailable.

Review the complete change for intended behavior, runtime validation, tenant/role access, action confirmation, bounded dependencies, uncertain outcomes, recovery after crashes, data retention, and backwards compatibility. Record completed checks precisely, including unavailable checks and residual risks. Document lasting decisions with ADRs and update the affected specifications in the same change.
