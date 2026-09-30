# Testing and evaluation strategy

Status: planned checks for future code. This repository currently contains documentation; none of the application tests below has run. Use synthetic data and deterministic providers by default. Tests involving paid accounts, real restaurant/customer data, live reservations, recording, or customer contact are separate authorized activities.

## Layers and evidence

1. **Domain/unit tests:** Pure decisions for request/booking states, authorization, configured rules, readback-confirmation binding, dates/timezones, and normalized errors.
2. **Database/service tests:** Real ephemeral PostgreSQL with production-like non-bypass roles, row-level security, tenant constraints, transaction boundaries, outbox jobs, leases, migrations, and concurrent writes. An in-memory repository cannot prove isolation or race handling.
3. **Contract/conformance tests:** Exercise every connector against one shared capability/outcome suite. Fake connectors inject precise failures; approved vendor sandboxes provide separate evidence of actual behavior.
4. **API/dashboard tests:** Sessions and roles, request/inbox workflows, CSRF/CORS, ownership, state conflicts, accessible staff interfaces, action-status wording, and configuration updates.
5. **Voice end-to-end tests:** Simulated audio/call events plus dedicated real test calls after vendor configuration. Evaluate audio startup, turn latency, interruptions, handoff, silence, disconnects, and provider-specific lifecycles.
6. **Security/operational tests:** Trust boundaries, prompt injection, abuse budgets, revocation, degradation, deployment draining, restore, deletion, and observability redaction.

Use tests to check outcomes and invariants rather than mirror private implementation functions. A feature that only passes a happy-path mock is not ready for production. Require evidence appropriate to the changed behavior; repeat wider suites when new changes or failures justify it.

## Acceptance matrix

| Scenario | Required observation | Minimum layer |
| --- | --- | --- |
| Approved hours and menu question | Effective configured facts and holiday exceptions are used; missing/stale facts are escalated | Domain + conversation evaluation |
| Allergy/cross-contamination question | No invented safety guarantee; documented information only and appropriate staff handoff | Conversation evaluation + voice |
| Ambiguous party size/date/time | Clarification and exact local date/time readback before confirmation | Domain + conversation |
| DST gap or repeated local time | Reject/clarify ambiguity; preserve explicit IANA timezone and selected instant | Domain |
| Payload changes after readback | Previous caller confirmation cannot authorize changed details | Domain + service |
| Caller/model injects tenant or permissions | Server context remains authoritative; request fails closed | API + service security |
| Request persisted | One committed request plus durable event; caller is told request remains unconfirmed | Service + conversation |
| Duplicate tool call or webhook | One durable action/request/message, with matching result | Database/service |
| Persistence fails | No claim of a saved request/message | Service + conversation |
| Disconnect after request commit | Staff request survives; no duplicate on reconnect/replay | Database + voice |
| Disconnect after confirmed future action enqueue | Existing submission follows current authorization/reconciliation rules; disconnect alone does not withdraw it | Worker + voice |
| Cancel pending future action versus dispatch | One atomic winner; winning cancellation sends no write, losing cancellation cannot claim vendor rollback | Database/worker + conversation |
| Two staff claim/fulfill a request | Conditional version/state checks allow one transition; loser receives conflict | Database + dashboard |
| Staff records a booking | Staff-reported existing-system reference/evidence labeled with provenance; future provider-verified results distinguished, guest notification status remains separate | Service + dashboard |
| No staff response within agreed target | Request becomes visibly stale; no invented caller promise or automatic confirmation | Worker + dashboard |
| Human requested during speech | Stale agent speech stops; configured transfer begins promptly | Voice |
| Transfer busy/no-answer/failure | Outcome differs from answered; message fallback works without loops | Dedicated call tests |
| After hours | Restaurant rules apply with configured callback expectations | Domain + voice |
| Old call config after revocation | Writes/transfers check current permissions and withdrawn facts before execution | Service + voice |
| Capability disabled/missing | Agent cannot invoke live booking; mock capability never reaches production | Contract + service |
| Availability disappears during booking | Vendor conflict is normalized; no false confirmation | Connector conformance |
| Vendor accepts write then times out | Durable unknown outcome; no unsafe retry or duplicate fallback; reconciliation resolves/assigns staff | Contract + database/worker |
| Out-of-order/replayed vendor callback | Valid signed events apply monotonically and only to matching tenant/location/action | Contract + service |
| Credential expires/revoked | Circuit/capability disabled; stale jobs cannot reuse permission | Worker + connector |
| Worker crash/lease overlap | Duplicate-safe processing; stale worker cannot commit conflicting state; unknown writes are fenced | Database/worker |
| Other tenant/location requested | API, jobs, caches, database, exports and credential access deny crossing | Security + database |
| Forged phone callback/media | Invalid signature/token/call binding rejected without allocating an expensive voice session | Gateway/security |
| Prompt injection in speech/knowledge | No permission expansion, arbitrary transfer, credential exposure, or unsupported action | Adversarial conversation + service |
| Cost/toll attack | Call/concurrency/tool budgets enforce configured fallback; no arbitrary destination | Gateway + load |
| Malicious URL/content | Provider URL allowlist and request limits block SSRF; dashboard renders escaped content | Security/API |
| Restore/deletion/offboarding | Deleted data not reopened, live jobs stay disabled during restore, tenant access revoked | Operations drill |
| Restore older than recent deletion/vendor write | Independent journal restores deletion decisions and quarantines possible dispatch; missing coverage blocks reopening/redrive | Operations drill + worker |
| Restore before membership/routing/capability revocation | Old sessions and approvals invalidated; revoked staff and capabilities stay blocked, reassigned numbers cannot route to old tenants | Operations drill + authorization |
| Restore before queued-action cancellation | Restored pending work cannot redrive without fresh scoped approval, even if no dispatch intent is recorded | Operations drill + worker |
| Telemetry and failures | Logs/traces/errors contain approved metadata, with secrets/contact details removed | Security + service |

## Connector test policy

The request-only connector requires no vendor access and cannot report authoritative availability. Deterministic fake adapters must advertise simulation and remain unavailable to production tenants. OpenTable and Resy share conformance tests but each needs its own authorized sandbox evidence. An operation with unknown vendor support remains disabled, even if the mock implements it.

Test structured contracts and capability declarations, location mapping, date/time formats, errors, auth expiry, rate limits, safe retry classes, idempotency support, write ambiguity, result/status lookup, webhook signatures and replays, reconciliation, and version changes. If a provider lacks idempotent write or reliable lookup, test the constrained behavior and escalation explicitly. Document unsupported capabilities instead of skipping failing tests until everything appears green.

## Model and voice evaluations

Version approved restaurant fixtures, tool schemas, prompts, and evaluation cases. Evaluate real models separately from deterministic service tests; record provider/model version, prompt/config version, sample size, conditions, and grading criteria. Golden text responses are inappropriate when multiple correct phrasings exist. Grade facts, status, required clarification, action correctness, and escalation.

Include short/long calls, interruptions, silence, background dining noise, accents, dates near midnight and DST, unfamiliar menu names, large parties, missing information, repeated corrections, and requests for a person. Use synthetic or consented samples; do not collect voiceprints as a side effect. Calibrate automatic graders with human review for misleading confirmation and safety-related answers. Report known coverage gaps and statistical limits.

Measure full caller-turn-to-useful-audio latency and tail percentiles, transfer completion, request accuracy, caller abandonment, and staff corrections. Do not optimize only for containment or conversation length. Test fail-safe behavior when a model/tool session becomes unavailable.

## CI and release evidence

Once implemented, PR checks include formatting/linting, strict type checks, domain/service tests, relevant connector conformance, migration tests for database changes, dependency/secret scans, and documentation link checks. Full voice/vendor sandbox tests are staged according to credential availability and risk; absence of vendor access is a blocked live capability, not a passing test.

PRs state actual commands/results and unrun checks. CI should use locked dependency versions, immutable action references, synthetic data, and least privilege; untrusted PRs get no live provider/deploy secrets. See [engineering](ENGINEERING.md) and [contributing](../CONTRIBUTING.md) for the future script contract.

Before real caller forwarding, record evidence for the architecture invariants, tenant isolation, audio/transfer behavior, failure messaging, staff fulfillment, budgets, disclosure/retention, incident recovery, backup restoration, and deletion. Before live reservations, add vendor-specific sandbox results and accepted-then-timeout reconciliation. Failures in false-confirmation or isolation tests block rollout.
