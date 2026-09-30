# Implementation status

Status: **restaurant pilot coding foundations, with a runnable synthetic demo and account-dependent acceptance still pending**. This document distinguishes delivered behavior from the target pilot in [architecture](ARCHITECTURE.md) and [the implementation plan](IMPLEMENTATION_PLAN.md). The application rejects production startup. This milestone has not forwarded a real restaurant number, booked a live table, or sent a customer message.

## Delivered components

| Area                     | Implemented behavior                                                                                                                                         | Evidence boundary                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace                | Strict TypeScript/pnpm workspaces, pinned Node/pnpm, shared validated contracts and required checks                                                          | Code/build evidence is recorded below; deployment is separate.                                                                       |
| Staff dashboard          | Overview, role-restricted inbox, simulator, knowledge/settings, phone operations and integration status                                                      | Synthetic browser workflows; no button enables an unapproved reservation provider.                                                   |
| Request workflow         | Deterministic simulator, canonical confirmation, atomic request/receipt/outbox save, staff claims and uncertain-fulfillment holds                            | Requests remain unconfirmed until staff record evidence; guest communication is separate.                                            |
| Persistence              | PGlite and native PostgreSQL adapters, five ordered migrations, forced RLS, composite tenant keys, transaction-local scope and fenced jobs                   | Native tests exercise a disposable PostgreSQL server; RDS TLS/deployment/restore requires live acceptance.                           |
| Demo authentication      | Loopback-only synthetic workspaces, opaque cookies, Origin/CSRF, bounded process-local sessions                                                              | Demo sessions expire on restart and cannot authorize customer environments.                                                          |
| Auth0 authentication     | Server-owned code/PKCE/state/nonce, verified signed tokens and fresh MFA, encrypted one-use login attempts, shared hashed sessions                           | Signed synthetic-provider and durable-session tests; real Auth0 configuration remains unverified.                                    |
| Restaurant authorization | Explicit versioned restaurant/membership operators, tenant suspension, session/revocation fencing, authority recheck inside business transactions            | Provider claims cannot grant roles. Viewer responses omit inbox caller data and free-text call outcomes.                             |
| Phone/audio              | Signed Twilio webhook/media admission, durable grants/generations/tombstones, OpenAI Realtime audio and bounded buffers/budgets                              | All live capabilities default off; actual signatures/audio/interruption and processing settings require dedicated-number acceptance. |
| Phone actions            | Model proposals, canonical Twilio readback before separate confirmation, transactional request/message save, one-dispatch admission and uncertainty handling | No model save/confirm tool, automatic uncertain retry, or availability/booking promise.                                              |
| Transfer and operations  | Approved bounded staff dialing, private untrusted handoff context, owner phone policy and bounded read-only Twilio reconciliation                            | No proof of human pickup or warm introduction. Unknown/stale/incomplete evidence retains capacity.                                   |
| Independent fallback     | Validated static announcement/staff-transfer TwiML and confined artifact generator                                                                           | Publication at an independent provider endpoint, forwarding loops and outage behavior require live tests.                            |
| Privacy/recovery         | Approved opt-in minimization, linked receipt coverage, independent DynamoDB journal adapter, contiguous replay and native runtime quarantine                 | Live IAM/durability, retention approval, provider deletion and restore/security drills remain required. Replay metadata is retained. |
| AWS delivery             | CloudFormation data/application separation, Fargate containers, TLS/RDS/secrets/logs, guarded main deployment and manual redeploy/logs/cleanup               | Prepared code; automatic deployment stays disabled until configured. No AWS resources have been provisioned in this milestone.       |
| Reservation connectors   | Request-only capabilities, deterministic fake adapter, disabled OpenTable/Resy extension points                                                              | Official approved vendor access and verified contracts are required before live connector implementation/enablement.                 |
| Startup and diagnostics  | Safe structured events, separate liveness/readiness, bounded authority checks, explicit proxy trust and production rejection                                 | No production-readiness claim; account acceptance and operating ownership remain launch gates.                                       |

## Local operation

Follow [README](../README.md) to install and start. Defaults are dashboard `http://127.0.0.1:5173`, API `127.0.0.1:3001`, and optional gateway `127.0.0.1:3002`. Server entrypoints load root `.env` if present. Secrets stay in that ignored file or the managed environment.

The ignored `.data/hostline` directory contains persistent synthetic PostgreSQL data. Seeds preserve edits on restart. One API process owns the embedded database and runs jobs. The standalone worker requires native PostgreSQL; it must not open the embedded directory. Native conformance uses a disposable local PostgreSQL instance with separate roles. Deployed operation requires separate migration/runtime/operator credentials and independent recovery authorization.

Demo login selects either synthetic restaurant; this is not a production membership feature. Simulator text history is retained for synthetic exercises, without enabling live recording or transcript retention. Enter synthetic guest details only.

## Phone-action behavior and limits

Phone authority lives in the API's tenant-scoped database record, rather than the gateway's socket map. Incoming-call replay returns sealed entry TwiML, a stream grant can be redeemed once, and a terminal callback creates an ended tombstone even if it arrives before incoming-call admission. Restart does not reopen those records. Controller generations fence superseded streams. Simulator endpoints reject phone-mode calls.

The model can prepare a reservation request/message or request the configured staff line. It cannot save or confirm a proposal, choose a tenant, submit an arbitrary timestamp, or choose a transfer number. Relative dates use the server-issued handle for the utterance that supplied the date. The backend binds canonical fields, restaurant configuration, proposal expiry, and the active call before producing readback TwiML.

Twilio `<Say>` plays the complete canonical readback outside and before `<Gather>`. The gather action is protected by a separate random call/proposal-bound token and verified provider signature; an accepted explicit response can atomically save the inbox item, call update, receipt, and outbox event. Ambiguous/no input does not save. This protocol avoids treating model speech or a model tool as confirmation. It does not establish caller identity, guarantee what a person heard, or make speech recognition infallible; real-provider acceptance must cover those practical limits.

Call-control dispatch is admitted durably before the external REST send. Only the atomic first-dispatch winner sends; uncertain outcomes are held for authoritative callbacks or reconciliation, without automatic repeat. Callbacks may arrive before the REST acknowledgment. Duplicate callbacks, late acknowledgments, and terminal events must preserve newer state. All capacity holds remain conservative until provider terminal evidence: lease expiry or closing a local socket does not prove that a provider call has ended. Unresolved holds can exhaust the small sandbox limit. The owner-triggered read-only check described below can establish terminal evidence; manual release and automatic recovery/redrive remain unavailable.

Transfers use only the restaurant's approved staff destination, checked again before dispatch. Dialing is bounded and busy/no-answer can return to a fresh bounded stream. Child-call callbacks are bound to the parent attempt. A connected line may be voicemail; the implementation does not verify human acceptance or provide a warm-transfer spoken introduction. Private staff dashboard context is described below. Saving a request records an unconfirmed staff-review item, never an availability promise or booked table. See [ADR-010](adr/010-phone-actions.md) and [call-control details](TWILIO_CALL_CONTROL.md).

## Phone operations and current authority

An authenticated owner can edit persisted versioned phone permissions through Origin/CSRF-protected compare-and-set updates. Fresh tenant policies allow calls, request saving, and transfers, but the three environment ceilings all default off. A restaurant toggle cannot enable an unconfigured provider. Calls are bound to their admission policy version; an edit invalidates old grants and pending consent, even if permissions are later reenabled. The API checks current authority before admission and writes. Dispatch admission is the serialized authorization boundary: an update admitted before a policy edit may still reach the provider afterward; later request confirmation checks current policy again.

The gateway checks authority before provider setup and model-response release, and checks again five seconds after the previous heartbeat completes. Each request has a three-second timeout, giving approximately eight seconds plus event-loop scheduling for idle change/outage detection. A successful response check may be cached for at most one second. Changed knowledge/policy, disabled authority, or an unavailable check closes affected audio and clears queued output. This is bounded revocation detection, rather than instant knowledge refresh. Deterministic control uses immediate API checks while it owns the call.

The **Phone operations** dashboard exposes minimized tenant call summaries to viewers and restricted call details/context to staff and owners. Handoff context is explicitly untrusted AI-prepared information; a proposal remains unconfirmed. Browser responses exclude provider identifiers, grants, tokens, XML, raw audio, and complete transcripts. Dashboard context does not prove a staff member received or accepted the call.

An owner can invoke **Check provider status**, a bounded read-only Twilio parent/child lookup. A confirmed terminal parent plus complete bound terminal child evidence may end only the still-current local record and release its hold. Unknown, unavailable, stale, truncated, or active-leg evidence retains capacity. The check never hangs up, redials, rewrites TwiML, resubmits a request, or manually releases uncertain capacity. See [phone operations](PHONE_OPERATIONS.md) for roles, credentials, endpoints, and investigation steps.

## Identity, deployment, and recovery coding milestone

Auth0 is the selected hosted provider. The BFF keeps tokens out of the browser and requires distinct signing/encryption secrets. Sessions have an eight-hour absolute and thirty-minute idle limit. Logout, callback cancellation, suspension, demotion and revocation share durable state; current authority is locked and rechecked during local business transactions. Fresh MFA is verified at login, without claiming provider-wide SSO logout or separate per-operation step-up. Restaurants and memberships are provisioned explicitly with expected versions; environment membership reseeding is rejected. See [Auth0 setup](AUTH0_SETUP.md) and [identity operations](IDENTITY_OPERATIONS.md).

Native runtimes stay quarantined until the independent manifest, actual RDS resource/endpoint and local contiguous replay checkpoint agree. Missing authority, incomplete evidence, a changed epoch/resource, or unavailable checks denies protected API and worker activity. Encoding a route or supplying forwarded headers cannot bypass these checks. [Privacy operations](PRIVACY_OPERATIONS.md) describes closed-record minimization, irreversible admission, unknown receipt holds, replay lineage and security reconstruction. This journal handles deletion evidence; it does not establish that a phone provider call ended or that a reservation exists.

The [AWS deployment guide](AWS_DEPLOYMENT.md) covers main-triggered staging, immutable image redeployment, CloudFormation readiness/rollback limitations, CloudWatch status/logs and application cleanup that preserves retained data. The code retains production rejection and false-by-default voice capabilities. The [account setup checklist](ACCOUNT_SETUP_CHECKLIST.md) records the remaining account/configuration inputs. The current milestone's verification is recorded below; earlier results remain historical.

## Verification record

Behavioral suites cover calendars/confirmation, connector uncertainty, auth/CSRF/roles, API transactions, PostgreSQL RLS/constraints/jobs/persistence, and mocked voice protocol handling. Browser tests exercise staff and simulated-caller workflows. `pnpm check` covers formatting, lint, typecheck, deterministic tests, and builds; `pnpm test:e2e` is separate.

### Initial prototype evidence

Local verification on 2026-09-30, before the durable phone-action revision:

- `pnpm check` passed: formatting, ESLint, strict TypeScript, the credential-pattern baseline, **81 tests across six suites**, and builds of the API, worker, voice gateway, and dashboard.
- `pnpm test:e2e` passed **four Chromium scenarios**: request-to-staff-booking/guest-communication lifecycle, persistent settings and workspace isolation, mobile navigation/vendor states, and inbox pagination. The pagination browser fixture models a large inbox; database tests separately exercise 207 real stored records.
- `agent-browser` inspection confirmed the rendered desktop dashboard, working demo login, and no reported browser errors.
- Built API and disabled gateway smoke checks started from a fresh nested data directory and returned healthy responses. No vendor connections were opened.
- `pnpm audit --json` reported zero known advisories. An esbuild override to patched 0.28.2 removes the discovered development-server advisory; remove the override only when resolved versions remain patched.
- The independent code review raised six actionable findings. All were fixed and rechecked: loopback dashboard exposure, inaccessible inbox pages, configuration/confirmation serialization, an invalid fulfillment action, concurrent socket admission, and failed model-response cleanup. Fresh-directory startup was additionally fixed during browser verification.
- `git diff --check` and local Markdown target checks passed. The credential-pattern check covers selected patterns only; it is not comprehensive secret detection. Host secret-scanning configuration and branch protection remain unverified.

The initial prototype also passed its [GitHub Actions push run](https://github.com/SahilWikhe/IVR_POC/actions/runs/36761172681). This verifies the configured checks on that earlier commit; it does not verify the phone-action revision. Branch protection and repository security settings remain unverified. Native PostgreSQL pooling/multi-connection locking, real OIDC interoperability, Twilio/OpenAI test calls, production deployment, and Resy/OpenTable remain outside current evidence.

### Durable phone-action revision — historical evidence

Local verification on 2026-09-30:

- `pnpm check` passed: formatting, ESLint, strict TypeScript, the credential-pattern baseline, **151 tests across 11 suites**, and API, worker, voice-gateway, and dashboard builds. Provider transports are fake; API/database tests use restricted tenant transactions against PGlite's PostgreSQL engine.
- `pnpm test:e2e` passed all **four Chromium scenarios**. `agent-browser` confirmed demo sign-in, the updated conversation overview, and no reported browser errors.
- `pnpm audit --json` reported zero known advisories.
- Built API and disabled gateway smoke checks passed from a fresh nested data directory. The API applied both migrations, health endpoints responded, and disabled incoming voice returned 503 without opening a provider connection. All 188 local Markdown targets across 20 documents and `git diff --check` passed.
- Independent review findings were fixed and rechecked: immutable initial grants on incoming replay, callback-before-acknowledgment races, monotonic transfer evidence, current-generation disconnect fencing, GA acknowledgment and cancellation handling, readback limits, conservative capacity, remaining transfer budgets, and explicit original-deadline checks immediately before dispatch. Additional API scenarios prove atomic rollback and one-slot concurrent admission.

The implementation commit `bdc4b68` also passed its [GitHub Actions push run](https://github.com/SahilWikhe/IVR_POC/actions/runs/36769213564). This establishes the configured hosted checks on that code revision, not branch protection or live-provider acceptance.

No real Twilio/OpenAI calls have been verified. Native PostgreSQL multi-connection behavior, provider enforcement, and the launch gates below remain outside this evidence. The earlier 81-test result and its hosted CI run remain historical.

This foundation saves at most one reservation request or message per phone call. It can continue answering questions or attempt a staff transfer afterward; additional saved items in the same call need a separately reviewed workflow.

### Phone-operations revision

Local verification on 2026-09-30:

- `pnpm check` passed: formatting, ESLint, strict TypeScript, the credential-pattern baseline, **219 tests across 15 suites**, and API, worker, voice-gateway, and dashboard builds. Tests include real tenant transactions through PGlite's PostgreSQL engine; all provider transports remain synthetic.
- New tests cover owner/staff/viewer permissions, exact Origin/CSRF, policy compare-and-set, disable/reenable epoch fencing, current configuration and generation, disabled deployment ceilings, preserved saved receipts, handoff rollback/privacy, forced RLS, migration from version two, and restricted migration-role backfill.
- Gateway regressions cover denied/unavailable authority before provider setup and response release, bounded heartbeat failure, immediate barge-in during a pending policy check, queued-output clearing, late heartbeat results while deterministic dispatch owns the call, and failed resume authorization closing both peers.
- Provider-status tests exercise the actual Twilio SDK through a fake HTTP adapter: fixed GET targets, cancellation/deadline, no redirect/retry, raw pagination validation, and exact child-array selection. API tests retain holds for active, missing, truncated, foreign, unavailable, or stale evidence; verified terminal parent/all-child evidence releases only the current version. Parallel probes, callback races, and late confirmation binding are covered.
- `pnpm test:e2e` passed **eight Chromium scenarios**. Four new scenarios verify persisted policy under disabled environment ceilings, older call access and conservative reconciliation, staff context with booking evidence/guest notice kept distinct, and viewer restrictions. `agent-browser` inspection confirmed the rendered phone operations page and navigation, with no reported browser errors.
- Built API, phone-operations schema, and disabled gateway smoke checks passed from a fresh nested data directory using all three migrations. Disabled incoming voice returned 503; no live provider connection was opened. `pnpm audit --json` reported zero known advisories.
- Independent implementation review found no remaining blocker for this local milestone after fixes to raw SDK page metadata/array ambiguity, terminal callback replay binding, stale displayed proposals, staff booking copy, dispatch-admission/revocation wording, and failed authority recovery. Review and tests establish local behavior, rather than provider or production acceptance.
- All **204 local Markdown targets across 22 documents** and `git diff --check` passed. The credential-pattern check is a limited baseline, rather than exhaustive secret detection.

Implementation commit `d8df6eb` passed its [GitHub Actions push run](https://github.com/SahilWikhe/IVR_POC/actions/runs/36775196176), including required checks, dependency audit, and all eight browser scenarios. This verifies the configured hosted workflow on that code revision; it does not verify branch protection or live-provider acceptance.

The earlier 151-test result, its hosted run, and documentation commit `e049a9f` describe the preceding phone-action revision. No real Twilio/OpenAI call, native PostgreSQL multi-connection verification, or production deployment is established by this phase.

### Identity, cloud, and recovery revision

Local verification on 2026-09-30:

- `pnpm check` passed formatting, ESLint, strict TypeScript, the credential-pattern baseline, **365 tests across 27 passing suites**, and builds of the API, worker, voice gateway, migration entrypoint, and dashboard. The 18 native cases are deliberately skipped in this default run and are checked separately below.
- `pnpm test:native` passed **20 checks** against a fresh PostgreSQL 17.11 database: 18 native cases and two configuration guards. These exercise multiple connections, forced RLS, component-specific role restrictions, shared sessions and access changes, phone admission/dispatch races, jobs, and restore fencing under a restricted original migration identity. This is local PostgreSQL evidence, not RDS TLS acceptance.
- **Eight Chromium scenarios passed against the compiled API and dashboard** with a fresh embedded database and same-origin static serving. The ordinary browser suite also passed. A separate built-service smoke applied all five migrations, checked API readiness and phone operations, and confirmed disabled voice returns 503 without provider connections.
- All three CloudFormation templates passed `cfn-lint` 1.57.1 with zero findings. The custom infrastructure guards and **18 infrastructure tests** passed, including retained resources, scoped recovery access, deployment-source restrictions, and the public/internal boundary. No stack was deployed or changed.
- `pnpm audit --json` reported zero known advisories. The credential-pattern baseline and `git diff --check` passed. These checks do not prove exhaustive secret detection or configured repository protection.
- Independent reviews covered signed OIDC/MFA and callback races, durable authorization inside business transactions, database TLS target validation, trusted-proxy handling, retention admission and independent journal acknowledgment, restored authority revocation, and deployment IAM/source controls. Reported findings were corrected and regression-checked. Uncertain provider outcomes and replay evidence remain preserved through privacy operations and restore fencing.
- Production dependency-layout smoke passed. An actual local Docker build was blocked by registry network access; the new hosted `container-build` job performs image construction and non-root/read-only API, dashboard, migration-gate, and disabled-voice smoke checks. Hosted evidence must be verified separately on the pushed revision.

No real Auth0 tenant, AWS account, RDS instance, or Twilio/OpenAI call was used in these checks. Account configuration, deployed controls, real restore drills, and live-call acceptance remain the next phase in the [account setup checklist](ACCOUNT_SETUP_CHECKLIST.md).

## Configure the optional phone sandbox

The project owner has Twilio and OpenAI accounts and will supply environment secrets. [Voice setup](VOICE_SETUP.md) is the authoritative guide for variable names, signed webhook/media requirements, and limits.

Configuration needs the Twilio account SID/auth token and dedicated test number, OpenAI API key/model, public HTTPS gateway URL, and an internal service token plus approved synthetic tenant ID. API and gateway must share the token and call scope. `LIVE_VOICE_ENABLED`, `VOICE_ACTIONS_ENABLED`, and `VOICE_TRANSFERS_ENABLED` default to false. Action/transfer flags require the complete isolated voice-sandbox configuration and corresponding current restaurant permissions. Never put secret values in docs, chat, Git, or browser code.

Run the demo, configure the disabled gateway, expose only the reviewed gateway through an approved HTTPS test endpoint, configure the dedicated Twilio test number according to the voice guide, and record real-call evidence. This sequence does not authorize forwarding a restaurant's main number or using real customer traffic. Enable actions and transfers only for their deliberate isolated acceptance checks; keep their current limits visible throughout testing.

Twilio's separate Conversations / Agent Connect demo sandbox is not this application's sandbox configuration. An [official Twilio OpenAI Realtime example](https://github.com/twilio/twilio-agent-connect-typescript/blob/main/getting_started/examples/openai-realtime/src/index.ts) supports the custom voice-number/Media Streams route used here. Support for pointing the free Conversations demo at our endpoints remains unverified. The demo cannot replace acceptance of our own caller-consent and callback lifecycle.

## Remaining milestones and launch gates

1. **Verify real voice.** Prove provider authentication, call-to-tenant binding, audio codec behavior, interruption/playback accounting, disconnect cleanup, budgets, rate limits, and safe failure messaging on a dedicated test number. Verify provider processing/retention settings.
2. **Accept the phone request and operations foundations.** Verify real canonical readback playback, speech-confirmation behavior, policy/config revocation, generation fencing, disconnect races, changed details, duplicate callbacks, provider status reads, and truthful caller outcomes. Complete broader recovery/operator procedures before customer writes; mocked tests do not prove audio delivery, live read permissions, or caller intent.
3. **Accept staff handoff and fallback.** Verify configured destinations, busy/no-answer, private staff context and the prepared independent fallback on real calls. Publish approved fallback TwiML, test carrier loops/voicemail and confirm incident procedures before customer forwarding. A warm spoken introduction remains outside the first request-only pilot.
4. **Configure and accept identity/database operations.** Auth0 and durable access are implemented. Configure the real tenant/client/MFA, provision restaurant and staff access, verify deployed role grants and RDS TLS, then exercise logout/revocation and backup/restore with current security authority.
5. **Approve and accept privacy/recovery.** Configure approved retention and the independent journal/operator roles, verify minimization and a real restore with revoked access and uncertain actions, approve provider processing/deletion and replay-metadata retention, and assign incident/offboarding ownership. Future vendor reservation writes need additional independent dispatch/outcome evidence.
6. **Configure and verify AWS deployment.** Select account/region/domains and costs, bootstrap the prepared stacks/secrets/roles, review GitHub environment controls, and prove TLS, WebSocket draining, alarms, readiness, redeployment and retained-data cleanup. Verify branch protection/scanning. Remove production rejection only after launch evidence is reviewed.
7. **Run the restaurant pilot.** Approve knowledge, hours, destinations, inbox ownership, disclosures/privacy, contracts, and incident contacts. Test the dedicated number, then authorize and verify forwarding the restaurant's existing number.
8. **Enable vendor capabilities separately.** Obtain official Resy/OpenTable access and restaurant permission. Implement verified contracts, durable idempotency/reconciliation, and sandbox conformance before enablement. No scraping or consumer-login automation.

See [ADR-009](adr/009-local-prototype.md), [ADR-010](adr/010-phone-actions.md), and [architecture review](ARCHITECTURE_REVIEW.md) for applicable decisions and requirements. Voiceprints, synthetic-voice detection, payments, ordering, and reservation lookup/change are outside this milestone.
