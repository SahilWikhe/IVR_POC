## Change

Describe the concrete problem and resulting behavior. Link the relevant plan milestone or issue. Explain what a caller, restaurant staff member, or operator can observe.

## Validation

List checks actually performed and their results. For any relevant check not run, explain why and its impact. During the documentation phase, application lint/typecheck/tests/build are unavailable.

## Security and reliability review

Mark each item complete or not applicable with a reason. These checkboxes are review prompts, not proof that a control is enforced.

- [ ] Tenant and role authorization is enforced at the relevant boundary, including jobs and connector access.
- [ ] Runtime inputs and remote responses are validated; secrets and personal data are minimized and redacted.
- [ ] Caller confirmation, idempotency, timeouts, uncertain writes, and retry/reconciliation behavior are handled where relevant.
- [ ] Caller-facing status distinguishes a reservation request from a confirmed booking.
- [ ] Failure recovery, concurrency, transfers, and timezones are covered by meaningful validation where relevant.
- [ ] Provider capabilities use approved access; mocks and unverified integrations are identified accurately.
- [ ] Migrations, compatibility, deployment prerequisites, and recovery procedures are documented where relevant.
- [ ] Affected documentation and architecture decisions are updated.

## Risks and rollout

Describe material unresolved limitations, blocked capabilities, and any deployment or data changes. State whether the change is documentation-only, local/mock-only, or requires an operational rollout. Do not imply a live integration, configured CI gate, or completed deployment without evidence.
