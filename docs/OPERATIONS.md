# Deployment and operations

Implementation evidence: see [current prototype status](IMPLEMENTATION_STATUS.md) and [ADR-009](adr/009-local-prototype.md). The requirements below include later pilot and production work; they are not all implemented.

Status: intended production design and runbooks. No infrastructure is deployed and no measured service level is asserted. Hosting, vendors, region, and commercial plans must be chosen in implementation milestone 0.

## Deployment topology

Deploy a static React/Vite dashboard behind HTTPS; a Fastify API handles validated telephony callbacks, staff sessions, and configuration/request operations. A separately deployable voice gateway handles persistent audio WebSockets, conversation orchestration, and approved phone control. A Node.js worker processes PostgreSQL outbox jobs, request delivery, cleanup, and future connector reconciliation. One monorepo does not require one process or release boundary.

The selected host must support the voice gateway's connection lifetime, bidirectional streaming, graceful draining, autoscaling, and provider callback reachability. Do not place persistent audio sessions on a runtime whose execution or connection limits cannot support them. Verify idle timeouts at every proxy/load balancer. Realtime calls use an independent connection budget from staff API traffic and worker jobs.

Keep PostgreSQL private, encrypted, backed up, and reachable only by authorized service roles. Use separate database roles for application/worker access and migrations; production application roles cannot bypass row-level tenant isolation. Use TLS for external and internal transport where supported. Store vendor credentials in an appropriate secret manager; application records contain references, not plaintext secrets. Allow outbound access only to selected providers and infrastructure endpoints. Managed workspace credentials and policies do not automatically become production credentials or networking.

Initially use PostgreSQL durable outbox/leased jobs rather than adding a separate queue service. Jobs are at-least-once: a lease, a fencing token, bounded retry count, deduplication key, and transactional state changes are required. Never hold a database transaction open across a provider call. Worker throughput, indexes, retention, and database load need measurement before increasing concurrency.

Raw recording is off. Use a separate restricted durable recovery journal, such as a versioned object store, outside PostgreSQL's restore history for deletion decisions and, before enabling live writes, dispatch intents and outcomes. This metadata store is required even when audio storage is disabled. If recording is separately enabled with appropriate approval, use separate private object storage with per-tenant ownership, expiring authorized access, lifecycle deletion, encryption, and a tested deletion process. Consult the [security design](SECURITY.md) for data retention and access rules.

## Configuration and environments

- Local and CI use synthetic tenants and fake providers by default. A visible environment label separates simulation from real calls and real booking capability.
- Staging uses isolated accounts/credentials and dedicated numbers or vendor sandboxes. Preview builds cannot acquire production secrets or contact guests.
- Production has a vetted region, release artifact digest, approved configuration revisions, server-only secrets, explicit enabled tenant/provider capabilities, and per-tenant budgets.
- Store service configuration in versioned schemas and fail readiness on invalid required settings. Do not log secret values during validation. Separate desired configuration from observed provider readiness.
- Snapshot ordinary restaurant facts for an active call. Recheck critical permissions, revocation, transfer destinations, knowledge withdrawal, and emergency disablement before executing an action; stale configuration cannot override a kill switch.

## Proposed service targets

These are initial engineering targets, subject to measured tests and restaurant agreement. They are not contractual guarantees.

| Signal                               | Initial target / response                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller turn to start of useful audio | p95 below 2 seconds for simple FAQ answers under defined pilot load; measure the full path                                                                |
| Staff API availability               | Aim for 99.5% monthly during pilot; agree coverage and exclusions before production commitments                                                           |
| Request/message persistence          | Never report saved until transaction commit; alert immediately on persistence failures                                                                    |
| Outbox processing lag                | p95 below 30 seconds under pilot load; alert if oldest pending item exceeds 60 seconds; dashboard inbox visibility follows request commit directly        |
| Staff acknowledgment                 | Restaurant-defined business-hours target; dashboard alerts on stale unacknowledged requests                                                               |
| Transfers                            | Record actual answered/no-answer/failure outcomes; do not set a success target until provider behavior is measured                                        |
| Booking outcome integrity            | Zero known false confirmations or duplicate bookings; incident review for any occurrence                                                                  |
| Recovery point / recovery time       | Proposed RPO at most 15 minutes and RTO at most 2 hours for durable records; verify backup/PITR capability and restoration drills before claiming support |

Keep persistence correctness separate from uptime and conversational quality. Vendor unavailability must lead to an honest fallback even when the gateway itself is healthy.

## Capacity, costs, and abuse limits

Estimate phone minutes, realtime audio/model usage, transfer legs, database/storage, and worker costs from selected provider prices and measured call duration. Do not publish invented cost estimates. Define per-tenant and global concurrent-call limits, maximum call duration, model usage budgets, tool rate budgets, and provider rate limits. Warn operators near limits and route excess calls according to the restaurant's configured fallback.

Onboarding sets conservative budgets; raising them is a reviewed configuration change. Permit only verified transfer destinations and avoid forwarding loops. Bound silence handling and conversation retries. Do not allow callers to request arbitrary outbound numbers. Reconcile provider usage records with internal call events to detect leaked sessions and unexpectedly expensive calls.

Load tests cover sustained WebSockets, audio backpressure, reconnect storms, database connection pool exhaustion, worker lag, and staff API responsiveness at the configured pilot limit. Autoscaling must drain established calls rather than abruptly terminating all streams. New releases cannot resume a terminated media stream without provider-supported lifecycle behavior.

## Monitoring and safe observability

Use structured events and traces keyed by opaque tenant, location, call, action, and job IDs. Never log raw audio, contact details, transcripts, authorization headers, API keys, or unredacted provider responses. Security/audit events record actor, action, resource identifier, result, and approved minimal metadata. Restrict telemetry access and retention.

Collect call setup and completion, media failures, interruptions, response latency percentiles, tool timeouts, unknown writes, transfer outcomes, requests saved, inbox publication, staff acknowledgment, job attempts/lease expiry, auth failures, connector health, isolation-denial events, and cost. Correlate without exposing a customer identity.

Alerts need an assigned owner and runbook: persistence failure, unknown vendor write, possible tenant leakage, failed signature bursts, queue lag/dead-letter growth, stale requests, transfer failures, provider outage, abnormal spend, and backup/deletion failures. Monitoring should notify on actionable changes rather than every unchanged heartbeat.

## Failure and incident runbooks

| Trigger                                      | Immediate behavior                                                                                     | Recovery and verification                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Voice/model outage                           | Use tested carrier/provider fallback or transfer/message route; do not fabricate answers               | Disable affected capability, verify test call, restore gradually                                               |
| Gateway/API outage                           | Carrier/provider-level fallback should work without the application if the chosen provider supports it | Route to configured staff/voicemail, repair service, verify no forwarding loop                                 |
| Database unavailable                         | Stop new writes; never claim a request/message was saved                                               | Restore connectivity, reconcile completed actions, check jobs after recovery                                   |
| Reservation vendor unavailable before write  | Explain limitation and offer a request with caller agreement                                           | Circuit-break adapter; retry read probes within budgets                                                        |
| Vendor write result unknown                  | Keep action unresolved; do not issue a second booking or fallback that may duplicate it                | Reconcile by supported vendor evidence or assign staff resolution; record evidence                             |
| Future booking waits beyond `execute_before` | Prevent first dispatch and record `EXPIRED_BEFORE_DISPATCH` only when no attempt was sent              | Require fresh agreement/new linked work; if dispatch occurred or is uncertain, continue reconciliation instead |
| Credential revoked/expired                   | Disable affected tenant capability and refuse stale worker actions                                     | Rotate through approved secrets workflow, verify authorization, re-enable narrowly                             |
| Worker lease expires                         | Permit a new worker only with correct fencing; retain durable result ledger                            | Ensure stale worker cannot commit a conflicting result or duplicate an unsafe write                            |
| Inbox request becomes stale                  | Flag for restaurant staff; use only agreed escalation process                                          | Record staff acknowledgment/follow-up, adjust staffing or expectations                                         |
| Security/tenant-isolation incident           | Disable affected access/actions, protect evidence, involve responsible owner                           | Scope impact, rotate affected credentials if needed, assess notification obligations, verify fix               |
| Unexpected cost/toll abuse                   | Apply tenant/global budgets and configured fallback                                                    | Stop leaked sessions, inspect redacted events, verify provider billing evidence                                |

Call termination cancels obsolete speech/reads but does not erase a committed request or an attempted vendor write. A committed future booking still waiting for dispatch remains subject to its immutable approved `execute_before`, including after queue, journal, or rate-limit delays. Reconciliation is durable and continues after a caller disconnects or that deadline passes. Do not promise that an already attempted write was canceled merely because its network request was aborted or its start deadline expired.

Before a future vendor write, a same-call cancellation can atomically win against first dispatch admission. Winning cancellation leaves a terminal no-dispatch outcome; losing the race returns pending/unknown status rather than a promise of cancellation. Disconnect by itself is not such a cancellation. Already saved request changes go to staff in the first release, and canceling an existing vendor reservation remains a separate disabled capability.

## Deployments, migrations, and rollback

Build reproducible artifacts from reviewed commits with locked dependencies and pinned workflow actions. Scan dependencies/secrets and run behavior/security tests. Production deploy credentials must not be available to untrusted PR code. Use least-privilege, short-lived deployment identity where supported. Record deployment/version/config IDs without secrets.

Use backward-compatible expand/migrate/contract database changes. Test migrations against empty and representative prior schemas, large-table locking impact, and rollback strategy. Do not automatically reverse a destructive migration. Drain voice sessions, deploy compatible gateway/API/worker versions, then enable new behavior for one pilot tenant. Tool schemas and connector contract versions need compatibility rules for in-flight calls.

Rollback disables new behavior and restores a compatible application/config version; it cannot undo a booking or message already sent. Reconcile durable actions before deciding on any compensating business action. Critical kill switches must work even when a call has an older knowledge/config snapshot.

## Backups, deletion, and offboarding

Encrypt backups, restrict restoration access, validate point-in-time recovery capability, and run a documented restore drill before the pilot. Record achieved RPO/RTO with evidence. Restore into an isolated environment without enabling live provider jobs or outbound messages; inspect tenant isolation and reconcile state before reactivation.

Offboarding disables tenant phone routing/actions/credentials first, drains in-flight work, resolves unknown writes, removes access, and performs policy-approved deletion. Data deletion includes database records, derived exports, optional audio, transcripts, job payloads, and relevant provider-held data where supported. Audit events retain only policy-approved minimal evidence. Explain backup expiration and legal holds honestly.

### Recovery journal and restore quarantine

A tombstone only in the database is insufficient: restoring an older backup also removes newer tombstones and action receipts. Keep a restore-independent journal in separately managed, versioned, encrypted storage. Entries contain only approved minimal tenant/location/resource or operation IDs, action kind, deletion cutoff or dispatch intent, event/version/sequence, time, and necessary outcome evidence/reference. No credentials, caller contact fields, free-text notes, raw audio, or full canonical guest payloads belong in it. Pseudonymous IDs/provider references remain restricted and follow a reviewed retention policy.

- Before marking a deletion complete, durably acknowledge its decision in the journal, then execute/reconcile deletion. A journal outage prevents completion acknowledgment. Retry safely by a stable journal event ID.
- Before sending a future live mutation, require a durably acknowledged dispatch-intent journal entry. Recheck current authorization and dispatch ownership before the actual send. The journal is conservative evidence of possible dispatch, not proof that the vendor accepted it. Record final outcomes separately; a missing final receipt remains unknown. There is no distributed atomic transaction between PostgreSQL, the journal, and the vendor.
- Journal delivery uses authenticated service identities and narrow tenant-scoped access; only the recovery role can enumerate recovery markers across tenants. Track publication acknowledgments, integrity, lag and retention. Its retention must cover the maximum allowed backup age plus replay/idempotency windows, subject to reviewed data-minimization policy. If it cannot cover a backup safely, that backup cannot reopen live actions without an authoritative reconstruction process.
- Restore with call routing, external mutations, notification jobs, and deletion cleanup quarantined. Replay journaled deletion decisions before opening data access. Overlay dispatch intents/outcomes newer than the restore point, mark matching old queued actions non-dispatchable, and reconcile vendor outcomes. Never redrive an old live-write job merely because the restored database says it was pending.
- A restore also rolls back memberships, tenant suspension, consumed approvals, canceled pending actions, number assignments, routing allowlists, and connector revocation. Invalidate recovered staff sessions, media grants, call ownership, job leases and unused approvals under a new recovery/auth epoch managed outside database restore history; quiesce the old service fleet. Keep tenants, public routing and capabilities suspended until current state is reconstructed from an independently durable minimal security/control-plane journal or explicitly reauthorized by independently verified current owners/providers. A valid old local membership or OIDC token alone cannot reconstruct authority. Verify current dedicated-number/account/location ownership and transfer destinations before any call is routed.
- Never automatically redrive pre-restore pending mutations: a post-backup cancellation or revocation may be missing even when no dispatch intent exists. Require fresh scoped approval after recovery and current permission checks. Reconciliation of possible dispatch stays distinct from approval to create a new write.
- Require a recovery checkpoint and operator evidence that journal coverage is complete and current security/control-plane state is verified. Missing intervals, partial entries, unresolved writes, or expired journal coverage keep affected data/actions closed until authorized external reconstruction and staff/vendor resolution. Restoration drills must include a deletion, canceled queued action, revoked member/capability, reassigned number, and accepted-but-unrecorded booking after the backup point.

Deleting contact data must not erase the minimal replay/fencing evidence needed within the approved horizon. Define separate lifecycle policies for privacy data, recovery markers, audit evidence, and backups, including legal holds and safe destruction after the relevant recovery windows. See [DATA_MODEL.md](DATA_MODEL.md) for identifiers and [TESTING.md](TESTING.md) for drills.

## Pilot release checklist

Confirm approved restaurant configuration and disclosure, verified forwarding/transfer/fallback routes, staff inbox ownership, tenant isolation, budgets, secrets, provider retention controls, callback/media authentication, safe unknown-outcome handling, meaningful test evidence, incident ownership, restore drill, and deletion/offboarding behavior. [SECURITY.md](SECURITY.md) and [TESTING.md](TESTING.md) supply the corresponding gates. Enable real caller forwarding only after these checks and the restaurant's readiness agreement.
