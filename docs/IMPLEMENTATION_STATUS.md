# Implementation status

Status: **local synthetic prototype, with an optional unverified FAQ phone sandbox**. This document distinguishes delivered behavior from the target pilot in [architecture](ARCHITECTURE.md) and [the implementation plan](IMPLEMENTATION_PLAN.md). The application rejects production startup. This milestone has not forwarded a real restaurant number, booked a live table, or sent a customer message.

## Delivered components

| Area                   | Implemented behavior                                                                                                                                         | Evidence boundary                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace              | TypeScript/pnpm workspaces; Node.js 24.19.0 and pnpm 11.19.0; shared Zod contracts; lint/typecheck/test/build scripts                                        | Local verification is recorded below. Manifests and CI config do not establish deployment.                                                                                     |
| Staff dashboard        | Overview, inbox, call simulator, settings/knowledge editing, integration status, synthetic workspace selection                                               | Browser scenarios exercise the local application. No dashboard action enables a vendor integration.                                                                            |
| Simulator              | Approved FAQs/menu/hours, calendar validation, reservation/message collection, canonical readback, explicit confirmation, simulated transfer outcomes        | Deterministic text simulation; no model, audio, live transfer, or verified voice confirmation.                                                                                 |
| Request submission     | Call/proposal/config binding, expiry, exact confirmed fields, transactional request/call/receipt/outbox save, duplicate retry handling                       | Saved requests remain unconfirmed. No availability claim or external reservation write.                                                                                        |
| Staff workflow         | Assignment, optimistic versions, review/fulfillment leases, uncertainty hold, staff-reported evidence, separate guest communication record                   | Recording evidence or communication does not make a provider call or send a notification.                                                                                      |
| Persistence            | Persistent PGlite PostgreSQL engine; `pg` adapter; SQL migration; tenant composite keys; forced RLS under restricted roles; transaction-local tenant context | PGlite exercises real PostgreSQL behavior. Native provisioning, pool/TLS behavior, and deployment grants require separate evidence.                                            |
| Internal jobs          | Transactional outbox, bounded discovery of opaque references, leased/fenced completion, fulfillment expiry, quarantine of unsupported work                   | Internal processing only. No email, SMS, customer callback, staff notification, or live reservation job.                                                                       |
| Demo authentication    | Loopback-only synthetic workspaces; opaque signed cookies; exact Origin/CSRF checks; server-derived tenant/roles; rotation/logout                            | Bounded in-memory sessions expire after eight hours or process restart. No multi-instance/shared-session support.                                                              |
| Development OIDC       | Code/PKCE/state/nonce flow; fixed issuer, explicit subject/tenant/role mapping; one-use login grants                                                         | Provider composition tested with mocks. Requires a real IdP, HTTPS origin, native DB, and provisioned tenants. Durable memberships/revocation and verified MFA remain missing. |
| Phone/audio gateway    | Disabled-by-default Twilio webhook/media admission, bound stream grants, OpenAI Realtime audio, buffer/duration/concurrency limits, interruption handling    | Mocked transports/protocol checks. Real signatures, media timing, playback, failures, and account settings require test-number verification.                                   |
| Phone actions          | FAQ context from a token-authenticated internal endpoint; AI disclosure and sandbox limitation instructions                                                  | Live reservation/message submission and human transfer are unavailable. The sandbox does not deliver the full target phone workflow.                                           |
| Reservation connectors | Request-only capabilities; deterministic fake adapter; disabled OpenTable/Resy; future-write deadline/uncertainty rules                                      | No approved vendor access or live endpoints. Simulation rules are not a durable production dispatch/recovery service.                                                          |
| Logs and startup gates | Safe structured event fields; no default request-body/credential logging; environment validation; production rejection                                       | Full telemetry, retention/deletion, incident operations, and restore-independent recovery remain launch requirements.                                                          |

## Local operation

Follow [README](../README.md) to install and start. Defaults are dashboard `http://127.0.0.1:5173`, API `127.0.0.1:3001`, and optional gateway `127.0.0.1:3002`. Server entrypoints load root `.env` if present. Secrets stay in that ignored file or the managed environment.

The ignored `.data/hostline` directory contains persistent synthetic PostgreSQL data. Seeds preserve edits on restart. One API process owns the embedded database and runs jobs. The standalone worker requires native PostgreSQL; it must not open the embedded directory. Native identity/database checks need a provisioned environment and separate migration/runtime credentials.

Demo login selects either synthetic restaurant; this is not a production membership feature. Simulator text history is retained for synthetic exercises, without enabling live recording or transcript retention. Enter synthetic guest details only.

## Verification record

Behavioral suites cover calendars/confirmation, connector uncertainty, auth/CSRF/roles, API transactions, PostgreSQL RLS/constraints/jobs/persistence, and mocked voice protocol handling. Browser tests exercise staff and simulated-caller workflows. `pnpm check` covers formatting, lint, typecheck, deterministic tests, and builds; `pnpm test:e2e` is separate.

Local verification on 2026-09-30:

- `pnpm check` passed: formatting, ESLint, strict TypeScript, the credential-pattern baseline, **81 tests across six suites**, and builds of the API, worker, voice gateway, and dashboard.
- `pnpm test:e2e` passed **four Chromium scenarios**: request-to-staff-booking/guest-communication lifecycle, persistent settings and workspace isolation, mobile navigation/vendor states, and inbox pagination. The pagination browser fixture models a large inbox; database tests separately exercise 207 real stored records.
- `agent-browser` inspection confirmed the rendered desktop dashboard, working demo login, and no reported browser errors.
- Built API and disabled gateway smoke checks started from a fresh nested data directory and returned healthy responses. No vendor connections were opened.
- `pnpm audit --json` reported zero known advisories. An esbuild override to patched 0.28.2 removes the discovered development-server advisory; remove the override only when resolved versions remain patched.
- The independent code review raised six actionable findings. All were fixed and rechecked: loopback dashboard exposure, inaccessible inbox pages, configuration/confirmation serialization, an invalid fulfillment action, concurrent socket admission, and failed model-response cleanup. Fresh-directory startup was additionally fixed during browser verification.
- `git diff --check` and local Markdown target checks passed. The credential-pattern check covers selected patterns only; it is not comprehensive secret detection. Host secret-scanning configuration and branch protection remain unverified.

These are local results, not evidence that GitHub CI has run successfully. Native PostgreSQL pooling/multi-connection locking, real OIDC interoperability, Twilio/OpenAI test calls, production deployment, and Resy/OpenTable remain outside current evidence.

## Configure the optional phone sandbox

The project owner has Twilio and OpenAI accounts and will supply environment secrets. [Voice setup](VOICE_SETUP.md) is the authoritative guide for variable names, signed webhook/media requirements, and limits.

Configuration needs the Twilio account SID/auth token and dedicated test number, OpenAI API key/model, public HTTPS gateway URL, and an internal service token plus approved synthetic tenant ID. API and gateway must share the token. `LIVE_VOICE_ENABLED` stays false until prerequisites are present. Never put secret values in docs, chat, Git, or browser code.

Run the demo, configure the disabled gateway, expose only the reviewed gateway through an approved HTTPS test endpoint, configure the dedicated Twilio test number according to the voice guide, and record real-call evidence. This sequence does not authorize forwarding a restaurant's main number or using real customer traffic. Keep FAQ-only limitations visible throughout testing.

## Remaining milestones and launch gates

1. **Verify real voice.** Prove provider authentication, call-to-tenant binding, audio codec behavior, interruption/playback accounting, disconnect cleanup, budgets, rate limits, and safe failure messaging on a dedicated test number. Verify provider processing/retention settings.
2. **Connect voice to requests.** Add durable call lifecycle and confirmation proving the caller heard and accepted exact current fields. Handle generation fencing, disconnect races, changed details, duplicate callbacks, and truthful outcomes before phone writes.
3. **Deliver human handoff.** Implement approved destinations, durable transfer attempts and uncertain-outcome reconciliation, private staff context, loop limits, and busy/no-answer/provider-failure fallback. Simulated transfer is not phone transfer.
4. **Complete identity and native database operations.** Select/test IdP and MFA; provision tenants; replace in-memory sessions/static memberships with shared revocable state; verify native roles/pooling, migrations, indexes, and backup/restore.
5. **Implement privacy and recovery.** Approved retention/deletion/offboarding, restore-independent security/deletion evidence, recovery quarantine, rotation, incident ownership, and audited support access. Future external writes also need durable dispatch/outcome evidence outside database rollback.
6. **Verify deployment.** Select host/region, TLS/network controls, persistent WebSocket routing/draining, shared budgets/monitoring, secret handling, fallback, and infrastructure/CI permissions. Verify branch protection/scanning. Remove production rejection only after requirements are implemented and reviewed.
7. **Run the restaurant pilot.** Approve knowledge, hours, destinations, inbox ownership, disclosures/privacy, contracts, and incident contacts. Test the dedicated number, then authorize and verify forwarding the restaurant's existing number.
8. **Enable vendor capabilities separately.** Obtain official Resy/OpenTable access and restaurant permission. Implement verified contracts, durable idempotency/reconciliation, and sandbox conformance before enablement. No scraping or consumer-login automation.

See [ADR-009](adr/009-local-prototype.md) for this development boundary and [architecture review](ARCHITECTURE_REVIEW.md) for applicable requirements. Voiceprints, synthetic-voice detection, payments, ordering, and reservation lookup/change are outside this milestone.
