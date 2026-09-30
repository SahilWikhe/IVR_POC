# Phone operations and staff context

Hostline's local phone-operations foundation gives restaurant owners persisted call permissions and a conservative way to investigate unresolved calls. Staff can inspect minimized phone-call details and AI-prepared handoff context. These controls do not activate an unconfigured phone service, prove a live provider integration, or remove the production startup gate. Read [implementation status](IMPLEMENTATION_STATUS.md) for checks actually performed and [voice setup](VOICE_SETUP.md) for dedicated-number prerequisites.

## Environment ceilings and restaurant policy

The environment controls the maximum available capability. `LIVE_VOICE_ENABLED`, `VOICE_ACTIONS_ENABLED`, and `VOICE_TRANSFERS_ENABLED` default to `false`. Enabling a restaurant setting cannot override one of those ceilings, supply credentials, configure a number, or authorize customer forwarding. Changing an environment variable takes effect when the relevant process restarts.

Each restaurant also has a versioned persisted phone policy: allow new calls, allow saving requests/messages, and allow staff transfers. New policy records permit all three, while the environment ceilings remain off. This keeps an unconfigured demo disabled and lets owners revoke an otherwise configured capability without editing process secrets. Staff-transfer permission also requires the restaurant's current `transferEnabled` setting and approved independent destination.

Only an authenticated owner can update policy. Updates require the exact dashboard Origin, CSRF protection, the current policy version, and an atomic compare-and-set; a stale edit must reload the current policy rather than overwrite it. Callers, AI tool arguments, browser-supplied tenant fields, staff viewers, and a phone number cannot grant permissions. Policy and handoff data use tenant-scoped transactions, ownership constraints, and forced RLS.

The API reloads current policy at admission and action authorization boundaries, including dispatch and confirmation. Each admitted call is bound to its policy version; an owner policy edit invalidates older calls, grants, and pending consent even if permissions are later reenabled. Turning off request saving prevents a new inbox write even if an earlier model proposal exists.

Policy updates serialize with durable dispatch admission. If a policy edit wins first, the prepared action is not admitted. If dispatch admission wins first, its one provider update may still be sent or complete after the edit. Revocation does not cancel that admitted update or turn an uncertain outcome into a known failure. A later confirmation still checks current policy before saving a request; outcome and terminal callbacks remain available to reconcile an admitted action.

The gateway checks policy before opening OpenAI, before releasing a new model response, and through a heartbeat five seconds after the preceding check completes. Each request has a three-second timeout, giving approximately eight seconds plus event-loop scheduling for idle detection of a change or outage. A successful response check may be reused for at most one second. Revocation, changed knowledge, expired authority, or an unavailable/invalid check clears queued audio and closes both peers. This is bounded detection, rather than instantaneous knowledge refresh. During deterministic call control, the API's immediate authorization checks govern dispatch and confirmation instead of the audio heartbeat. Closing audio does not prove the provider call ended, so its capacity hold remains until terminal evidence.

Turning a policy back on permits only new calls under capabilities already configured in the environment. It does not revive an old policy generation or ended call, reuse spent grants, repeat an uncertain dispatch, bypass a current configuration check, or book a table. At most one reservation request or message can be saved per phone call; FAQ answers and a configured transfer may continue afterward.

## What staff can see

The **Phone operations** dashboard shows recent phone calls and their local lifecycle outcomes. Viewers receive a minimal tenant-scoped list. Owner and staff roles may open permitted call details and AI-prepared context; only owners can change phone policy or use **Check provider status**. The browser never receives raw provider call/account/stream identifiers, grants, callback tokens, TwiML, credentials, raw audio, or a complete phone transcript.

AI-prepared handoff context is a bounded summary of the caller's reason for calling, proposed details, and known local outcomes. Caller and AI text is untrusted data. It cannot authenticate a person, change permissions, confirm a request, authorize another booking, or instruct staff software to execute commands. The dashboard labels this context and requires staff to verify details before acting. An unconfirmed proposal stays labeled **Unconfirmed request** or **Unconfirmed message**; a saved item links to the staff inbox and still does not imply a confirmed table.

This is private dashboard context, not a whispered introduction to the staff phone or proof that staff received or understood it. A staff line may be answered by voicemail or an automated attendant. Store and display only the bounded information needed for follow-up; retention/deletion, provider privacy settings, and customer-data use remain launch requirements.

## Read-only provider status checks

Missing terminal callbacks conservatively retain capacity. An owner can request a provider status check for a permitted tenant call. The API uses configured server-side Twilio credentials and the official SDK to read the fixed account/call target and a bounded child-leg collection. It does not let the browser choose an account, provider identifier, host, redirect, or arbitrary lookup target. If the credential is unavailable, the check reports that limitation and keeps the hold; configuring an OpenAI key alone does not supply Twilio status access.

For this isolated sandbox, status reading requires optional API-side `TWILIO_AUTH_TOKEN` plus the server's configured `TWILIO_ACCOUNT_SID` and `VOICE_TENANT_ID`. The gateway already uses the account token for callback validation and its gated call-control update; the API needs access separately for an owner-triggered read. No API-key configuration is added in this phase. Missing API-side credentials leave the reader unavailable and do not trigger provider requests at startup. Production credential separation, scoped API keys, and verified role/access management remain launch requirements; keep values in environment secrets, never the browser or Git.

The check performs provider reads only, under a three-second deadline. It never hangs up a call, changes a number, modifies TwiML, redials staff, resubmits a request, repeats a prior control update, or manually clears a capacity hold. The API inspects one child-leg page with a limit of 20 records. More, partial, contradictory, unavailable, or unbound evidence remains unknown and cannot establish safe release.

Release requires fresh evidence bound to the same account, parent call, and known child attempts, with terminal parent and every applicable child leg, plus a still-current local record version. Evidence is fetched outside the tenant transaction and revalidated before the atomic local update. A concurrent callback or control change makes an older check stale; it cannot overwrite newer state. A nonterminal parent, an active child, a failed read, or a missing/unverified leg retains capacity. Provider terminal evidence ends the local call and preserves its replay tombstone; it does not retroactively prove that readback was heard, a person accepted a transfer, or a reservation was fulfilled.

Ordinary status reads are safely repeatable. They do not repair restored-database replay protection, provide restore-independent dispatch evidence, or authorize recovery of an uncertain external booking. This phase has no manual release, force hangup, or redispatch control.

## Handling an unresolved test call

1. Open **Phone operations** and inspect the call's current outcome. If further activity should stop, an owner can revoke the appropriate phone policy. A changed policy version invalidates prior calls and pending consent. The gateway's next bounded check closes affected audio; immediately reloaded API policy blocks new prohibited actions.
2. An owner selects **Check provider status**. Distinguish a confirmed terminal result from active, unavailable, stale, or incomplete evidence. Staff can inspect context, but cannot operate the provider check or override policy.
3. If the parent and applicable child legs are terminal and the local version remains current, the API records the terminal result and releases that hold. Otherwise retain it and investigate the provider/account state through the responsible operator. Do not reset records, delete tombstones, widen the call limit to conceal uncertainty, or repeat a previous dispatch.
4. After investigating, a new read-only check may establish fresh terminal evidence. Reenable restaurant policy only when the intended environment capability and test routing are ready. Reenabling does not reopen the old call.

The dashboard makes no outgoing notifications and does not itself forward a restaurant number. Dedicated-number testing, outage routing, carrier forwarding/rollback, live transfer verification, budgets, incident ownership, and approval of pilot knowledge/destinations remain separate work.

## API and role contract

| Route                                 | Access and behavior                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/phone/operations`           | Authenticated tenant-scoped minimal operations summary; viewer access is allowed.                                                                                      |
| `GET /api/phone/calls/:id`            | Owner/staff only; minimized proposal and labeled untrusted handoff context.                                                                                            |
| `PUT /api/phone/policy`               | Owner only, exact Origin and CSRF; `expectedVersion` prevents stale overwrite. Effective flags are persisted policy AND environment ceiling.                           |
| `POST /api/phone/calls/:id/reconcile` | Owner only, exact Origin and CSRF; `expectedVersion` binds the local snapshot. Returns a safe call summary, `ended`, `held`, or `unavailable` result, and explanation. |

An already-ended call is safe to inspect again. A still-active call whose version changes during the external read produces a stale-state conflict instead of applying outdated evidence. Internal service and provider identifiers remain server-side.

## Verification boundary

Credential-free tests can exercise owner/staff/viewer authorization, CSRF and stale-policy rejection, tenant RLS, bounded context exposure, current-policy mutation checks, heartbeat failure behavior, mocked provider reads, stale reconciliation, child-leg binding, and conservative release. Their final results belong in [implementation status](IMPLEMENTATION_STATUS.md). Prior phone-action test results describe the earlier revision and do not validate these controls.

Native PostgreSQL multi-connection behavior and grants, real Twilio read permissions and callback/leg behavior, live audio timing, real OIDC/MFA, multi-instance draining, provider retention, and restored-database recovery remain unverified. Production startup and default-off voice flags remain in place.
