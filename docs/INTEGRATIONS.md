# Integration design and enablement

Implementation evidence: see [current prototype status](IMPLEMENTATION_STATUS.md) and [ADR-009](adr/009-local-prototype.md). The requirements below include later pilot and production work; they are not all implemented.

Status: **design for implementation; no provider integrations are implemented or enabled.**

The first restaurant pilot accepts reservation **requests** for staff review. A request does not hold a table, show live inventory, or become a reservation when a staff member acknowledges it. The platform will have shared adapter contracts so an authorized Resy or OpenTable connection can be added for individual restaurant locations later. There is no assumption that either vendor currently offers the required access, operations, sandbox, or commercial permission to this project.

See [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md), and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for service boundaries, persistence, controls, verification, and delivery order. This file specifies integration behavior; it does not authorize provider access or public launch.

## 1. Operating modes

Each tenant location has one explicitly selected reservation mode:

| Mode                 | What the caller can do                                                                 | Meaning of success                                                               | Deployment rule                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `REQUEST_ONLY`       | Submit a reservation request after reading back the details and obtaining agreement    | Request persisted in the restaurant's dashboard inbox; table remains unconfirmed | Initial production pilot mode after launch gates pass                                          |
| `DETERMINISTIC_FAKE` | Exercise simulated availability, writes, conflicts, and failures using seeded fixtures | Synthetic test result; no real table or vendor account is affected               | Development and isolated test tenants only; UI, logs, and conversations visibly say simulation |
| `AUTHORIZED_LIVE`    | Use only enabled, verified capabilities of an official vendor connection               | Vendor result accepted under the confirmation rules below                        | Disabled until every applicable enablement gate passes                                         |

The request adapter advertises `submitRequest`, not `createReservation` or `checkAvailability`. It must never return a fake provider reservation reference. The deterministic fake is a separate adapter, cannot be selected for a real restaurant, and cannot use production telephone routing or provider secrets. Simulated booking success is not evidence that a live adapter works.

The restaurant's reservation system remains authoritative for inventory, availability, seating duration, table combinations, and final booking status. PostgreSQL stores workflow records and provider references; it is not an independent inventory engine. A generic calendar event must not be treated as a restaurant table reservation.

## 2. Capability matrix and uncertainty

`UNKNOWN / NOT VERIFIED` means no product promise or live capability can be enabled on the basis of this document. It is different from a verified `UNSUPPORTED` result.

| Capability                                    | Request-only adapter             | Deterministic fake          | Resy live adapter                        | OpenTable live adapter                   |
| --------------------------------------------- | -------------------------------- | --------------------------- | ---------------------------------------- | ---------------------------------------- |
| Save request in staff dashboard               | Planned MVP                      | Simulated                   | Platform workflow, independent of vendor | Platform workflow, independent of vendor |
| Read live availability                        | Unsupported                      | Simulated                   | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Create reservation                            | Unsupported                      | Simulated                   | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Find write by idempotency/correlation key     | Not a vendor write               | Simulated                   | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Read reservation details                      | Staff workflow only              | Simulated                   | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Change or cancel reservation                  | Unsupported in MVP               | Simulated if fixture exists | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Vendor-side idempotency                       | Not applicable                   | Controlled test behavior    | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Reservation change webhooks                   | Not applicable                   | Simulated                   | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Customer record access                        | Unsupported in MVP               | Synthetic fixtures only     | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Table hold/offer expiry                       | No holds                         | Simulated                   | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Official API access and restaurant permission | Not needed for dashboard request | Not needed                  | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |
| Sandbox, quotas, production approval          | Not applicable                   | Local fixtures              | **UNKNOWN / NOT VERIFIED**               | **UNKNOWN / NOT VERIFIED**               |

Maintain a versioned capability manifest for each adapter release and an installation-specific allowlist for each tenant location. Effective permissions are the intersection of product scope, adapter verified support, installation permission, restaurant policy, caller authorization, and current health. Neither a model nor a dashboard label can add a capability. Provider health can remove permission to start an action, but cannot change the meaning of an already attempted write.

Resy and OpenTable must be assessed independently. Access granted to one restaurant, product, region, or vendor must not be assumed transferable to another. For **each** vendor, resolve:

- Whether an official integration program admits this product and whether the restaurant's account plan permits it.
- Which APIs, authentication methods, scopes, locations, and operations are actually authorized; whether guest lookup or customer fields have additional limits.
- Whether availability responses are advisory or held, how offers expire, and whether any required payment, deposit, card, policy acceptance, or seating fields exceed MVP scope.
- Whether booking acknowledgement is immediate confirmation or an asynchronous acceptance requiring a later status read.
- Whether a documented idempotency key exists, its retention window, and how a timed-out write can be identified without repeating it.
- Whether webhooks exist, their signatures, replay protections, ordering, delivery retry behavior, and whether they can prove a particular write's outcome.
- Whether sandbox/test accounts exist, which failures can be exercised, rate limits, account-level quotas, data retention terms, support escalation, and production approval requirements.

Keep official documentation URLs, authorized scope evidence, test results, contract/version notes, and review dates in an integration evidence record. Do not store credentials or private contracts in Git. Do not reverse engineer undocumented endpoints, scrape a booking website, reuse a consumer session, automate a user's account login, or assume a public booking link permits API writes.

## 3. Boundaries and common contract

The implementation baseline is Node.js with TypeScript, Fastify for server boundaries, PostgreSQL with tenant isolation, and a transactional outbox worker for deferred delivery and reconciliation. Provider-specific code stays behind adapters. The voice model requests a named action from the action service; it never receives provider credentials, selects a provider account, or calls an adapter directly.

The action service constructs trusted tenant, location, call, authorization, and configuration context. These values come from authenticated sessions or validated telephone routing, not caller speech, retrieved content, or arbitrary tool parameters. It resolves the authorized installation from server-side mapping and checks every capability again immediately before execution.

The following type-only sketch is a proposed contract, not shipped functionality. It is valid TypeScript and intentionally contains no network implementation. Runtime schemas, authentication, database policies, and state transitions remain mandatory in implementation.

```ts
export type ReservationCapability =
  'checkAvailability' | 'createReservation' | 'readReservation' | 'reconcileWrite';

export type CapabilityEvidence =
  | { readonly state: 'UNKNOWN' }
  | { readonly state: 'UNSUPPORTED'; readonly reason: string }
  | {
      readonly state: 'VERIFIED';
      readonly evidenceId: string;
      readonly reviewedAt: string;
    };

export interface AdapterManifest {
  readonly provider: 'resy' | 'opentable' | 'deterministic-fake';
  readonly version: string;
  readonly environment: 'sandbox' | 'production' | 'simulation';
  readonly capabilities: Readonly<Record<ReservationCapability, CapabilityEvidence>>;
}

export type TrustedActor =
  | {
      readonly kind: 'CALL';
      readonly callId: string;
      readonly callGeneration: number;
    }
  | {
      readonly kind: 'STAFF';
      readonly userId: string;
      readonly membershipVersion: string;
    };

export interface TrustedActionContext {
  readonly tenantId: string;
  readonly locationId: string;
  readonly installationId: string;
  readonly actor: TrustedActor;
  readonly configRevision: string;
  readonly deadlineAt: string; // Per-invocation timeout, not approval validity.
  readonly abortSignal: AbortSignal;
}

export interface AvailabilityQuery {
  readonly restaurantTimeZone: string; // Validated IANA identifier.
  readonly localDate: string; // Validated YYYY-MM-DD.
  readonly localTime: string; // Validated HH:mm, explicitly resolved.
  readonly startsAt: string; // Validated UTC instant, consistent with zone.
  readonly partySize: number;
  readonly seatingPreference?: string; // Preference, never a guarantee.
}

export interface ReservationIntent extends AvailabilityQuery {
  readonly guestName: string;
  readonly callbackNumber: string; // Validated, normalized E.164.
}

export interface ReservationOffer {
  readonly offerId: string; // Internal opaque reference, not model-supplied URL.
  readonly startsAt: string;
  readonly partySize: number;
  readonly expiresAt?: string;
}

export interface ReservationReference {
  readonly internalReservationId: string;
  readonly providerReference: string;
  readonly status: 'CONFIRMED';
  readonly startsAt: string;
  readonly partySize: number;
}

// Planned future reservation-read result; lookup remains disabled in the MVP.
export type ReservationRead =
  | {
      readonly status: 'CONFIRMED';
      readonly reservation: ReservationReference;
      readonly observedAt: string;
    }
  | {
      readonly status: 'CANCELLED';
      readonly internalReservationId: string;
      readonly providerReference: string;
      readonly evidenceId: string;
      readonly observedAt: string;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly internalReservationId: string;
      readonly observedAt: string;
    };

export type AdapterFailure =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED'
  | 'NOT_AUTHORIZED'
  | 'UNAVAILABLE_SLOT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE';

export type ReadResult<T> =
  | { readonly kind: 'OK'; readonly value: T }
  | {
      readonly kind: 'ERROR';
      readonly code: AdapterFailure;
      readonly retryAfterSeconds?: number;
    };

export interface AuthorizedWrite {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly fencingToken: number;
  readonly executeBefore: string; // Immutable UTC start deadline from approval.
  readonly intent: ReservationIntent;
  readonly offerId?: string;
}

export type WriteResult =
  | { readonly kind: 'CONFIRMED'; readonly value: ReservationReference }
  | {
      readonly kind: 'REJECTED';
      readonly code: AdapterFailure;
      readonly evidenceId: string; // Definitive evidence of no booking.
    }
  | {
      readonly kind: 'UNKNOWN';
      readonly operationId: string;
      readonly reason: 'TIMEOUT' | 'DISCONNECTED' | 'AMBIGUOUS_RESPONSE';
    };

export type ReconciliationResult =
  | { readonly kind: 'CONFIRMED'; readonly value: ReservationReference }
  | { readonly kind: 'NOT_CREATED'; readonly evidenceId: string }
  | { readonly kind: 'STILL_UNKNOWN'; readonly nextReviewAt: string }
  | {
      readonly kind: 'ERROR';
      readonly code: AdapterFailure;
      readonly mutationOutcome: 'UNKNOWN';
      readonly nextReviewAt: string;
    };

export interface ReservationAdapter {
  readonly manifest: AdapterManifest;
  checkAvailability(
    context: TrustedActionContext,
    query: AvailabilityQuery,
  ): Promise<ReadResult<readonly ReservationOffer[]>>;
  createReservation(context: TrustedActionContext, write: AuthorizedWrite): Promise<WriteResult>;
  readReservation(
    context: TrustedActionContext,
    internalReservationId: string,
  ): Promise<ReadResult<ReservationRead>>;
  reconcileWrite(context: TrustedActionContext, operationId: string): Promise<ReconciliationResult>;
}

export interface ReservationRequestReceipt {
  readonly requestId: string;
  readonly status: 'PENDING_STAFF_REVIEW';
  readonly tableConfirmed: false;
}

export interface RequestOnlyAdapter {
  readonly mode: 'REQUEST_ONLY';
  submitRequest(
    context: Omit<TrustedActionContext, 'installationId'>,
    operationId: string,
    intent: ReservationIntent,
  ): Promise<ReservationRequestReceipt>;
}
```

Return the method's typed failure with code `UNSUPPORTED` when disabled by the verified manifest; do not implement it using a guess. The runtime action service rejects new action attempts before reaching these methods. A reconciliation read error, including `UNSUPPORTED`, `NOT_FOUND`, or revoked access, preserves the mutation's `UNKNOWN` outcome and its hold; it does not establish `NOT_CREATED`. A definitive write rejection is valid only if no dispatch occurred or authoritative evidence establishes no booking. Future reservation reads distinguish confirmed, cancelled, and unknown provider status; they cannot treat every found reference as currently confirmed. Modification, cancellation, hold, deposit, payment, and customer lookup require separate contracts, scope, authorization, and tests; do not silently fit them into `createReservation`.

The trusted actor is a verified call-generation context or an authenticated, authorized staff context constructed by the server. The initial request workflow is call-originated; the staff variant prepares for explicitly approved dashboard fulfillment. A worker uses the originating actor and durable operation authorization plus its own scoped service identity, not a fabricated active caller session. Current authorization and revocation must be checked at the appropriate dispatch/reconciliation boundary as described in the architecture.

Adapters resolve provider references and secret handles from scoped storage. Availability queries exclude guest names and contact details; send only the documented fields needed for that operation. Model-visible results expose only necessary customer-facing facts; provider references, errors, and payloads are redacted as appropriate. Internal opaque IDs still require ownership checks and are not security credentials. This sketch's strings need runtime length, format, ownership, and enum validation before use.

## 4. Location, credential, and data mapping

- Create an `integration_installations` record per authorized tenant/provider account and a location-scoped `connector_instances` record for each explicit mapping between a platform location and the official vendor location identifier. Record environment, enabled scopes, approved capabilities, adapter version, authorizing administrator, consent evidence, status, and revocation time. Both ownership and account/location/environment mapping must agree before secret resolution or dispatch.
- A provider account can represent multiple restaurants. Test its exact location access and reject mismatches. Never take tenant/location ownership from an unsigned webhook payload, a provider reference alone, the caller's requested restaurant name, or a model argument.
- Keep credentials in managed secret storage; PostgreSQL stores opaque secret references, scope metadata, and rotation status. Only the connector runtime can resolve those references after authorization. Never put secrets into prompts, browser state, logs, traces, URLs, fixture files, or Git.
- Use the least scopes needed. Installation, reauthorization, disconnection, scope expansion, and secret rotation require an authorized tenant administrator and audit event. Verify callback state, single use, expiry, and redirect allowlists for any documented OAuth flow; the actual provider authentication method remains unverified.
- Make request and response mappings explicit and versioned. Preserve provider schema identifiers internally; never assume the two vendors use identical party-size, seating-area, guest, cancellation-policy, or reference formats. Reject unexpected or oversized fields instead of propagating them.
- Store guest names and contact details only where needed for fulfillment. Dietary notes may contain sensitive personal information; collect the minimum, restrict access, and refer allergy questions to staff without safety claims. Raw recordings are off; integrations do not add recording or unrestricted transcript storage.
- Use the restaurant's IANA timezone and the server-recorded start timestamp of the relevant caller utterance to resolve conversational dates. Persist that reference timestamp/utterance with the proposal; do not substitute call-start, host, or later worker time. Validate the local date/time and UTC instant together, explicitly handle nonexistent and repeated daylight-saving times, and read back the actual date, time, party size, and location. Freeze the confirmed date/time/zone through queues and retries. A new relative-date correction uses the new utterance's timestamp and requires a new readback/confirmation.
- An availability offer can become stale. Verify the provider's expiry/hold semantics and recheck according to official documentation. Changing the time, party size, location, policy, or required commitment requires a new caller confirmation.
- Map a documented conflict or unavailable slot to a safe customer response. Treat malformed success, missing reservation reference, asynchronous acknowledgement, transport timeout, and unexpected status conservatively. Keep normalized internal error codes separate from redacted provider diagnostics.

## 5. Request-only fulfillment and staff operations

The first delivery channel is an authenticated **dashboard inbox**. Saving a request and its outbox event in one transaction makes the request available to that inbox. Initial implementation does not automatically send email, SMS, Slack, or other external messages. Restaurant staff can follow their approved existing contact process and record what happened. A future channel requires its own consent, credentials, templates, delivery receipts, failure handling, and enablement review.

1. The action service collects necessary details, checks restaurant rules, reads them back, and obtains agreement to submit an **unconfirmed request**. It states the configured follow-up expectation without inventing a response deadline.
2. Persist the request, confirmation evidence, call reference, tenant/location ownership, and outbox event atomically. Deduplicate retries using the internal operation ID; successful persistence returns the same receipt. The AI can say the request was saved only after transaction success.
3. An authenticated staff member with location-specific permission explicitly acknowledges the inbox item. Acknowledgement records who saw it and when; it does not mean the table is available, a booking exists, or the guest was contacted.
4. A staff member claims the request with an expiring lease and versioned compare-and-set update. Two users cannot simultaneously advance the same request into fulfillment. Lease expiry releases review work; it does not make an uncertain vendor write safe to repeat.
5. In the MVP, staff check and book through the restaurant's current reservation system or manual process. Before leaving the dashboard to perform a booking, the staff member explicitly starts fulfillment and the platform records `IN_FULFILLMENT` with an operation/actor reference. An expired review lease cannot release this item for a second booking: an interrupted or abandoned fulfillment requires checking the existing system and recording reconciliation evidence. Staff record a real reservation reference or a permitted manual evidence note, exact final date/time/party size, and the reason for rejection if applicable. The dashboard must distinguish **staff-reported booking** from **provider-verified booking**. It cannot technically fence writes made directly in a third-party website; staff procedures and visible in-progress/uncertain warnings are necessary controls.
6. If final details differ from the request, staff must obtain and record guest agreement before marking it accepted. A future dashboard button that performs a vendor write needs an explicit staff approval, authorized connector capability, fresh availability rules, and the same operation/uncertainty controls as an AI-initiated write. Claiming a request is not approval to write.
7. Track guest contact separately: pending contact, contact attempted, and confirmation/rejection communicated, including channel, staff actor, timestamp, and evidence type. A staff checkbox is staff-reported notice, not proof that the guest received a message. A provider booking reference or inbox acknowledgement must not automatically set guest notice to delivered.
8. Close the workflow only under a documented rule, such as confirmed fulfillment plus recorded guest notice or a recorded rejection outcome. Keep stale/unacknowledged requests visible, with agreed review targets and escalation to the dashboard administrator. An after-hours request stays pending until authorized staff act.

The canonical `reservation_requests.workflow_state` values are `PENDING_STAFF_REVIEW`, `ACKNOWLEDGED`, `IN_REVIEW`, `IN_FULFILLMENT`, `BOOKED_AWAITING_GUEST_NOTICE`, `DECLINED_AWAITING_GUEST_NOTICE`, `CLOSED`, and `NEEDS_RECONCILIATION`. Acknowledgement actor/time, review lease actor/token/expiry, active fulfillment operation, guest-notice state, and booking-evidence source are separate fields. `request_fulfillments` records final details, evidence, agreement to changed details, and reconciliation; `guest_notices` records contact provenance. Allowed transitions, permission checks, leases, versions, and audit events belong in the data model and action service, not only the UI.

Caller ID and knowledge of a request number do not authorize access to an existing reservation's personal information. Initial calls may submit a new request or ask for staff assistance; existing-reservation lookup, change, and cancellation are disabled until operation-specific verification rules and tested connector capabilities exist. Staff roles need tenant/location authorization independently of caller verification.

## 6. Confirmation, concurrency, and uncertain writes

The following rules apply before enabling any live write, including a future staff-triggered write:

1. **Issue confirmation through the action service.** A short-lived, opaque confirmation token binds the call/session or authorized staff actor, tenant, location, configuration revision, exact normalized intent, offer reference/expiry, and permitted operation. Before approval, derive an absolute `execute_before` as the earliest applicable caller-agreed latest start, verified offer expiry, and restaurant maximum-wait policy; explain the bounded wait and include the deadline in the approved snapshot/digest. Record the read-back and affirmative reply without requiring audio retention. The model cannot mint the token, select/extend this deadline, or treat a previous agreement to different details as permission.
2. **Consume once and persist first.** Atomically consume the token, create a unique operation/idempotency key, and record the immutable intent and `execute_before` plus outbox work under tenant isolation. Duplicate tool calls resolve to the same operation. Token expiry, changed details, denied capability, or revised rules require revalidation and fresh confirmation. The adapter receives the persisted deadline as `AuthorizedWrite.executeBefore`; `TrustedActionContext.deadlineAt` is only a per-invocation timeout. Neither a retry nor worker restart may recalculate the approved deadline. Credentials never form part of an idempotency key.
3. **Start one external attempt.** A worker claims the operation with a lease and monotonically increasing fencing token, then uses a compare-and-set state transition before sending. Persist attempt metadata and the minimal restore-independent dispatch journal entry before the network call. If the required journal cannot be written, do not dispatch. Workers check the current fence before storing results. Restrict one active sending attempt per operation with database constraints and state transitions. Before dispatch admission, cancellation of a caller-origin pending action from the same active call/current generation may atomically win the transition to `CANCELLED_BEFORE_DISPATCH`; if the worker has already won dispatch ownership, cancellation cannot imply that no booking exists and must enter the uncertainty/reconciliation path. Staff-origin pending-action cancellation needs a separately reviewed scoped permission/API contract and remains unavailable until that contract exists. Canceling an existing vendor reservation is also a separate future authorized operation.
4. **Do not overstate fencing.** A database fence rejects stale local writes; it cannot prevent a request already sent from completing at the vendor. If a sending lease expires or a worker crashes, the next worker reconciles the prior attempt. It must not blindly send the write again. A crash before dispatch may still be ambiguous unless durable evidence establishes that nothing was sent.
5. **Apply real vendor idempotency only when verified.** Reuse the same key only according to documented semantics and retention. An invented request header provides no guarantee. Vendor idempotency does not replace local uniqueness, concurrency protection, or confirmation checks. For providers without a documented reliable method, at-most-one dispatch plus reconciliation/manual review is the safe default.
6. **Classify outcomes conservatively.** Return `CONFIRMED` only for an authoritative successful result with a reservation reference and matching required details. `REJECTED` requires definitive evidence that no booking was created. A timeout, disconnect, server error that might follow commit, unclear acknowledgement, malformed success, or missing reference becomes `UNKNOWN`.
7. **Reconcile without creating.** Use a verified documented read/correlation mechanism or a trusted signed event whose semantics establish the outcome. Mere absence from a paginated, eventually consistent, or guest-search response is not proof of non-creation. Ambiguous name/phone matches do not establish identity or identify the write. If reliable reconciliation is unavailable, hold the operation for staff/vendor review and record evidence before any further action.
8. **Separate request-only fallback from uncertainty.** Before a write begins, disabled capability or provider failure can lead to an explicitly unconfirmed request after caller consent. After an unknown write result, do not create a second booking or a fresh actionable fallback request. Route the existing operation to `NEEDS_RECONCILIATION`, tell the caller that the result is uncertain, and ask staff to check it. Any inbox item references that same operation and prominently forbids duplicate booking until resolved.
9. **Communicate after durable state.** Persist the confirmed/rejected/unknown outcome before reporting it. Call disconnect does not undo an accepted booking. A durable success followed by a dropped response returns the same success on retry. Never automatically cancel a possibly accepted booking to recover from uncertainty.
10. **Reconcile after restore.** A restored database snapshot can contain a pending operation that already dispatched after the snapshot was taken. Pause external writes after recovery and compare operations with the independent dispatch journal before resuming. Known dispatched operations require reconciliation, never automatic replay. Missing or incomplete journal evidence does not prove no dispatch; quarantine affected work for review. Restore processing must also reapply the independent deletion ledger before contact data is exposed or connector work resumes. Keep journal entries minimal and access-controlled, with opaque operation/account identifiers rather than guest details or secrets.

Local request deduplication, vendor write idempotency, and customer agreement are separate controls. Do not deduplicate unrelated reservations solely because they share a name, phone number, time, or party size. Booking races are resolved by the vendor's inventory rules; an availability read does not reserve a table.

At first dispatch admission, atomically require database time `< execute_before` along with state/ownership/permission checks. Recheck immediately before network send after journal publication, queueing, rate-limit waiting, or backoff. If expired and reliably never dispatched, the platform records terminal `EXPIRED_BEFORE_DISPATCH` without creating a booking; fresh agreement and a new linked operation are required to try again. Do not reset or extend the old operation. If dispatch occurred or is uncertain, expiry does not establish failure/cancellation and cannot authorize a replacement write; continue reconciliation. These rules apply equally to future caller- and staff-approved live bookings. Saved request-only inbox items and reconciliation reads retain separate follow-up/timeout policies.

## 7. Rate limits and failure containment

- Use bounded timeouts, payload sizes, concurrency, and queue lengths. Apply limits per tenant/location, installation, provider account, and provider quota as needed; use fair scheduling so one restaurant cannot exhaust the shared connector pool.
- Retry safe reads with bounded exponential backoff and jitter, respect documented `Retry-After`, and stay within the caller's interaction budget. Retry a write only if its result is definitively non-committed and the documented vendor contract makes that retry safe, with the same operation key, valid agreement, and unexpired original `execute_before`; otherwise reconcile or require fresh agreement as appropriate. Reconciliation of a possible earlier dispatch continues after this start deadline.
- Use circuit breakers to stop **new** actions during repeated failures. Preserve reconciliation work for previously attempted writes and show uncertainty to staff. Health recovery does not automatically retry unknown writes or expand capabilities.
- Separate realtime conversation from slow connector work. Report a pending or uncertain outcome accurately when the interaction budget expires; a transport timeout is not a cancellation of the external operation.
- Validate outbound hosts against configured official provider endpoints. No model-supplied URLs, arbitrary redirects, fetch-to-callback URLs, or customer-controlled destinations. Check egress policy, TLS verification, and response size limits.
- Capture redacted metrics for latency, availability, rate limiting, unknown outcomes, reconciliation age, duplicated attempts prevented, request acknowledgement age, and guest-notice backlog. Alert through configured operational channels; do not expose contact details in metric labels.

## 8. Webhooks, media sessions, and revocation

Live webhooks are optional capabilities until verified for the selected provider. Polling or manual reconciliation is preferable to assuming an unsigned event is authoritative.

- Verify the exact official signature/authentication mechanism against the original raw body before parsing. Enforce body limits, verified delivery timestamp/expiry where the protocol provides it, key version, and documented canonicalization. IP restrictions can supplement verification but do not replace it.
- Bind a verified event to the installed provider account and its approved location mapping. Ignore any caller-controlled tenant identifier. For shared account-level endpoints, resolve the installation using verified provider routing and stored mappings, then enforce tenant isolation. If ownership is ambiguous, quarantine the event.
- Store a unique inbox entry by provider/account/environment/event ID, or an approved replay identifier where the official protocol lacks an event ID. Process the entry and state transition atomically. Record duplicates without repeating booking, message, or notification side effects.
- Check replay windows and nonce/timestamp rules where supported. Do not invent timestamp guarantees that the provider does not offer. Handle out-of-order events using verified sequence/version semantics or an authoritative read; never regress a terminal result because an older event arrived later.
- A webhook acknowledging dispatch or acceptance must not be translated to a confirmed booking unless its documented meaning supports that conclusion. Process only whitelisted event types and validate schemas; remove secrets and unnecessary personal data from retained payloads.
- Revocation immediately disables new provider actions, prevents new credential resolution, invalidates pending unconsumed approvals for that installation, and removes capability permission. Mark already attempted operations for reconciliation instead of erasing them. Reauthorization cannot automatically resubmit unknown writes. Document the minimal permitted reconciliation path after revocation; where access is unavailable, use authorized staff/vendor evidence.
- Rotate secrets and signing keys using the provider's verified overlap/expiry behavior, with auditable version changes. Test invalid, retired, missing, and future keys and revocation races. Keep retention/deletion rules for inbox data aligned with the security policy.

The phone provider and realtime voice provider are also provisional adapters. Evaluate official support for inbound call webhooks, bidirectional streaming, interruption, authenticated media connections, documented transfer status, regional service, failover, and retention before selecting either. Persistently connected streaming requires a deployment that supports the selected provider's transport and connection lifetime.

Map the called platform number to exactly one active tenant location only after validating the telephony event. A forwarded caller number is an unverified contact hint. Authenticate stream establishment through a documented provider mechanism and, where supported, a short-lived single-use server-issued session token bound to the verified call and location. Keep secrets and personal information out of URL query strings; if a provider requires a signed URL, redact it everywhere and constrain its lifetime and reuse. Reject stale/reused sessions and mismatched call IDs.

Transfer destinations are restaurant-approved, server-side allowlisted phone numbers. Verify that a destination cannot forward back into the AI route. A transfer request does not prove staff answered; use documented progress/outcome events and test unanswered, busy, rejected, disconnected, and provider-failure cases. Pass only necessary context using an authorized supported channel. Initial context is stored in the authenticated dashboard; no assumed external staff messaging channel is enabled. Raw call recording stays off by default, and any vendor audio retention behavior must be established and configured before the pilot.

## 9. Live connector enablement checklist

Each gate is required for each provider/restaurant location/environment. A disabled stub plus a successful fake test satisfies none of the live-access gates.

- [ ] Official access and commercial terms confirmed for this product; current documentation and permitted operations recorded.
- [ ] Authorized restaurant administrator consent recorded; tenant account, provider account, environment, and exact location mapping verified.
- [ ] Authentication method and least-privilege scopes verified; secrets isolated, rotation/revocation tested, and no secrets in the model or browser.
- [ ] Required booking fields, availability/offer semantics, timezone behavior, and authoritative confirmation meaning verified.
- [ ] Rate limits, timeout behavior, response schemas, and errors mapped with safe customer wording.
- [ ] Idempotency support and retention established; unknown-write reconciliation tested, or an explicit staff/vendor review route proven safe. No capability is enabled if its failure modes cannot be contained.
- [ ] Runtime manifest and location capability allowlist reviewed; unsupported functions stay unavailable and paid/deposit/payment actions stay out of MVP scope.
- [ ] Sandbox/approved test environment conformance suite passed, including duplicate dispatch, crash windows, late response, conflict, and unknown outcome. If no sandbox exists, use the vendor's approved testing procedure and record its limitations before deciding on live access.
- [ ] Webhook signature/replay/ownership/order/revocation tests passed if webhooks are enabled; otherwise their capability remains disabled.
- [ ] Cross-tenant access tests, worker scope checks, staff role tests, confirmation binding, and dashboard evidence labeling passed.
- [ ] Request-only degradation before dispatch and no-duplicate handling after uncertainty verified end to end, including caller disconnect and failed guest contact.
- [ ] Data processor terms, region, retention, required disclosures, and recording-off configuration reviewed for the pilot.
- [ ] Staff trained on acknowledgement, booking evidence, guest notice, uncertainty, and reconciliation; support/escalation responsibility recorded.
- [ ] Controlled test number and restaurant launch approval completed; enable only the verified capabilities for this location, monitor, and keep a disable-new-actions switch ready.

## 10. Conformance and contract testing plan

Every reservation adapter must pass the same relevant suite with provider-specific fixtures and evidence. Test the request-only adapter independently from simulated/live booking adapters. Do not use live customer data or production reservations for routine CI.

Required scenarios include:

- Manifest enforcement rejects unknown/unsupported operations; fake adapters are rejected in production routing.
- Tenant A cannot use Tenant B's installation, location, guest data, provider reference, request, offer, or confirmation token, including through a privileged worker or webhook.
- Ambiguous conversational dates, daylight-saving gaps/repeated times, stale offers, changed party size, and expired confirmations cannot trigger an unapproved write.
- Concurrent tool calls and staff clicks consume one confirmation and create one operation; two workers cannot dispatch a second attempt after a crash/expired lease with uncertain outcome.
- Vendor conflict, rate limit, authentication expiry, malformed success, asynchronous acknowledgement, response lost after commit, late completion after call disconnect, and reconciliation unavailable produce the correct durable states and caller wording.
- An unknown write cannot create an independent actionable reservation request or manual duplicate booking workflow. Confirmed/rejected reconciliation requires documented authoritative evidence.
- Request persistence and outbox are atomic; replay and worker restart do not duplicate inbox entries. Staff acknowledgement remains separate from booking evidence and guest notice.
- Unauthorized staff actions, expired review leases, stale versions, changed final details without guest agreement, and revocation during a pending action are rejected safely.
- Invalid webhook signatures, replay, incorrect environment/account/location, schema drift, oversized bodies, duplicate/out-of-order events, and key rotation cannot alter unauthorized records or repeat side effects.
- Telephone forwarding, caller-ID variations, transfer loops, failed transfer, audio/session interruption, media session replay, model tool injection, and missing configuration produce safe fallback behavior.

Offline contract fixtures must be sanitized, versioned, and clearly identified as examples or vendor-approved samples. A vendor adapter requires official schema tests and approved integration tests in addition to the fake suite. Record which failures cannot be tested in a vendor environment; do not report simulated evidence as a live verification result.

## 11. Dependencies and unresolved decisions

The local prototype does not require vendor credentials or live access. The implementation plan can proceed with the request-only workflow and isolated simulation while these dependencies remain open:

1. Pilot restaurant location, current reservation process, timezone, approved follow-up expectation, authorized administrators, and staff inbox ownership.
2. Resy **and** OpenTable eligibility, official access, contractual permissions, schemas, capabilities, test environments, and reconciliation semantics; all remain unverified independently.
3. Phone and realtime provider selection, regional requirements, connection authentication, transfer/failover support, audio retention controls, and deployment transport limits.
4. The pilot's identity-verification policy for any future existing-reservation operation. Voiceprints and synthetic-voice detection are outside the MVP and cannot unlock connector capabilities.
5. Approved retention, data region, guest contact workflow, operational review targets, and human escalation procedure for unresolved writes.

No public product claim should describe live Resy/OpenTable availability, booking, modification, or customer lookup until the corresponding capability is implemented, authorized, and verified for the restaurant using it.
