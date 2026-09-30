# ADR-010: Durable phone actions with provider-controlled confirmation

Status: accepted for isolated development; real-provider acceptance and production readiness remain open. This supplements [ADR-005](../DECISIONS.md#adr-005-model-proposes-deterministic-services-authorize) and replaces the FAQ-only implementation boundary described in [ADR-009](009-local-prototype.md). ADR-009's synthetic-data, identity, production, and verification limits remain valid.

## Context

The dashboard and simulator already collect requests/messages and support staff review. The next phone milestone needs the same exact-field and tenant invariants while handling independently delivered voice frames, REST acknowledgments, and provider callbacks. A model's tool call or generated audio cannot establish that the caller approved the current proposal. An in-memory call map also loses replay protection on process restart.

Updating a Twilio call is a remote side effect. A timeout may happen after Twilio accepted it, and a callback can arrive before the REST response. Database transactions cannot atomically commit a remote call update. A disconnected local WebSocket or expired lease does not prove the provider has hung up the caller.

## Decision

Keep the Twilio bidirectional Media Streams/OpenAI Realtime bridge. Add a tenant-scoped API service for durable admission, grant redemption, proposal preparation, first-dispatch admission, callback reconciliation, and terminal state. The gateway verifies provider signatures against its configured public origin, validates account/call bindings, and uses a fixed internal service credential. The model does not receive that credential or choose tenant identity.

Persist voice records alongside phone-mode call summaries using tenant composite ownership constraints and forced RLS. Keep stream grants hashed, one-use, expiring, and bound to the provider call. Use controller generations to fence old streams. Persist terminal tombstones, including terminal events received before admission, so delayed incoming callbacks cannot reopen a call after restart. Maintain consistent transaction locking and version checks; provider network work runs outside database transactions. Retain no raw voice audio or complete phone transcript in these records.

Expose only narrow model proposals for a request/message or an attempt to reach the configured staff line. Validate fields against current restaurant policy and canonical domain rules. Relative dates use the server-issued handle for the utterance that supplied the date; a model cannot submit an arbitrary reference timestamp. Phone mode is excluded from the simulator's turn/confirmation routes. The model has no save, confirm, arbitrary dial, network, or database tool.

For a request/message, generate immutable canonical readback TwiML in the API. Place `<Say>` outside and before `<Gather>` so recognition cannot affirm or interrupt a partly played canonical readback. After the readback, gather a bounded explicit response through a separately random, call/proposal-bound action token. The gateway verifies the provider signature; the API verifies the token, active call, dispatch state, proposal, expiry, digest, current configuration, and exact consent. No input, ambiguous speech, or rejected agreement does not save.

An accepted confirmation atomically saves the inbox item, call update, callback receipt, audit evidence, and outbox event. A repeated matching callback returns its receipt; a changed payload under the same operation identity is rejected. Caller-visible results distinguish an unconfirmed reservation request from a booking. Consent permits this low-risk inbox action and does not authenticate identity or authorize sensitive future lookup/change.

Persist a control attempt before sending it. Atomically admit only the first dispatch winner, then send one bounded REST update to the fixed official Twilio host. Automatic SDK retry and redirects are disabled. Record definitive rejection separately from accepted or unknown outcome. A timeout, connection reset, malformed acknowledgment, or cancellation after dispatch remains uncertain and must not authorize another update. A valid signed callback may reconcile a dispatched attempt before the REST acknowledgment, and late acknowledgments must preserve newer or terminal state.

Staff transfer uses only the current restaurant's approved destination, with global and restaurant permission checks before dispatch. Refuse the configured incoming/public numbers as loop destinations. Bind child-call callbacks to the parent attempt, bound the dial duration, and resume a fresh bounded stream on supported busy/no-answer failure. Report a connected line truthfully: voicemail may answer, and this foundation does not prove a person accepted or deliver private staff context.

Keep capacity conservative until authoritative provider terminal status; never release unresolved provider capacity merely because a socket closed or a lease expired. A lingering hold can exhaust the small sandbox capacity. Automatic operator reconciliation and restore-independent recovery are separate launch work; no silent reset or uncertain redial is a safe substitute.

Keep `LIVE_VOICE_ENABLED`, `VOICE_ACTIONS_ENABLED`, and `VOICE_TRANSFERS_ENABLED` false by default. Action flags require an explicitly configured sandbox, and transfer additionally requires current restaurant permission. Production startup remains blocked. A successful deterministic test does not authorize restaurant-number forwarding or establish real-provider acceptance.

## Alternatives considered

| Alternative                                                           | Reason for the decision                                                                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the model read details and invoke a confirmation tool             | Model output and caller interpretation can diverge. Canonical provider readback plus a separate bound callback keeps save authority in deterministic code. |
| Place canonical readback inside speech gather                         | Recognition can interrupt the prompt, permitting partial playback before affirmation. Complete the canonical readback before recognition starts.           |
| Keep admission/grants only in gateway memory                          | Restart loses deduplication and can allow captured callbacks to reopen calls. Persist grants, generations, receipts, and terminal tombstones.              |
| Retry a call update after timeout or release capacity on lease expiry | Neither event proves provider outcome. Hold uncertainty and reconcile against authoritative evidence.                                                      |
| Switch all phone work to the free Conversations demo                  | Demo access and account features do not prove our custom endpoints/actions. Keep the custom number path and evaluate the demo independently.               |

## Twilio Agent Connect sandbox and custom-number path

Twilio's [Conversations / Agent Connect quickstart](https://www.twilio.com/docs/conversations/agent-connect/quickstart) describes a separate sandbox experience. The owner's console screenshot shows a prebuilt Retail/Owl Pet Supply agent, says demo usage is outside account billing/logs, and restricts calling/texting to upgraded accounts. Those are observations of that demo UI, not verified guarantees for this project or its provider usage. Support for connecting our custom agent endpoints to the free demo remains unverified; the quickstart page could not be retrieved through the current environment proxy.

The [official Agent Connect TypeScript repository](https://github.com/twilio/twilio-agent-connect-typescript/blob/main/README.md) and its [OpenAI Realtime example](https://github.com/twilio/twilio-agent-connect-typescript/blob/main/getting_started/examples/openai-realtime/src/index.ts) were inspected. The example uses a voice-capable Twilio number, a public TwiML/WebSocket endpoint, and the developer's OpenAI key for a Media Streams bridge. That Realtime mode does not require Conversation Orchestrator. This supports the selected custom-number architecture without requiring a switch to the separate demo or its prebuilt agent.

## Consequences and verification

Phone persistence survives process restart, but this is not restore-independent evidence or a production recovery epoch. Native PostgreSQL multi-connection locking, target role grants, provider callback ordering, actual speech/audio behavior, forwarding, and account/model access require separate evidence. Provider-side retention is not established by excluding audio from application records.

The readback adds an intentional provider speech step after natural conversation. It protects the canonical confirmation boundary but cannot guarantee attention, hearing, speech-recognition accuracy, or verified identity. Real-call acceptance must exercise interruption, rejection, ambiguous/no input, changed configuration, hangup, callback replay, acknowledgment races, transfer/voicemail, and outage behavior. Caller-visible claims remain bounded to known durable outcomes.

The subsequent [phone-operations foundation](../PHONE_OPERATIONS.md) adds bounded policy/configuration refresh checks, private staff dashboard context, and owner-triggered read-only provider reconciliation. These controls still require real-provider acceptance. Shared/distributed operational budgets, provider-hosted outage fallback, broader incident/recovery procedures, retention/deletion, durable identity/revocation, and restore quarantine remain launch requirements. Production rejection stays until those requirements and a restaurant pilot are reviewed. Record checks actually performed in [implementation status](../IMPLEMENTATION_STATUS.md); historical prototype results do not validate a later revision.

Revisit when real-call results require a different confirmation experience, when adding verified human handoff, when deploying replicas or native PostgreSQL, or when adding official reservation-vendor writes. Any replacement must retain exact current-field consent, server-derived ownership, first-dispatch admission, truthful uncertainty, and terminal replay protection.
