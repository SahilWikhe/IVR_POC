# ADR-011: Auth0, shared authorization, and AWS pilot foundations

Status: accepted for the configurable restaurant pilot; deployed operation and production readiness remain unverified. This implements the provider choice beneath [ADR-008](../DECISIONS.md#adr-008-external-staff-identity-local-authorization). See [implementation status](../IMPLEMENTATION_STATUS.md) for evidence.

## Context

A restaurant dashboard needs revocable access across API instances, reliable tenant isolation, and MFA. The phone gateway needs persistent WebSockets and private controller access. Main-branch releases should update infrastructure and services without mixing replaceable application resources with customer data. A PostgreSQL restore must not revive deleted caller content or superseded authority.

## Decision

Use Auth0 Universal Login as a Regular Web Application through the existing maintained OIDC client. The backend owns authorization code, PKCE, state, nonce, signed-token validation, fresh MFA verification and cookies. Browser code receives no provider token. Encrypt login grants using a distinct authenticated-encryption secret; store only opaque session hashes. Shared PostgreSQL versions fence membership changes, suspension and revocation. A business transaction rechecks authority while holding the current session/membership/tenant locks; no provider request runs inside that transaction. Offline operators explicitly provision restaurants and access with expected versions and audit events. See [identity operations](../IDENTITY_OPERATIONS.md).

Keep the loopback synthetic demo separate, including its process-local sessions. Viewer access excludes inbox caller details and free-text call outcomes. High-impact operator changes remain outside the public dashboard. Local application logout does not revoke all Auth0 SSO sessions, and login MFA does not establish a separate per-operation step-up mechanism.

Prepare AWS CloudFormation data/network and application stacks, an immutable container image, Fargate API/voice/worker services, public/private HTTPS ALBs, private encrypted RDS, managed secrets, and CloudWatch. GitHub uses short-lived OIDC credentials. Automatic staging deployment consumes the exact successful main Checks revision and remains disabled until configured. Redeployment selects a verified immutable revision; application cleanup preserves the data stack. Production startup rejection remains effective. See [AWS deployment](../AWS_DEPLOYMENT.md).

Use a retained DynamoDB installation journal outside PostgreSQL's restore domain. Fixed-role runtime reads verify the current manifest, actual RDS instance resource and endpoint, and the contiguous database checkpoint. Missing evidence quarantines native API and worker work. Retention is explicitly approved and defaults off. Only the separate privacy operator admits deletion of closed/ended records, journals the irrevocable minimal decision, and minimizes caller content while retaining replay identities and uncertainty state. Historical replay sources remain explicit across epoch changes. See [privacy operations](../PRIVACY_OPERATIONS.md).

## Consequences and evidence

Signed synthetic-provider tests establish protocol validation, not live Auth0 tenant policy. Native PostgreSQL tests establish local pool/locking/RLS behavior, not RDS TLS or operations. AWS transport tests inspect SDK commands and failure handling without creating resources. A CloudFormation template or mocked journal does not establish cloud durability, IAM enforcement, backup recovery or provider availability.

Logical in-place SQL rollback cannot be detected solely by matching database fields. Operators must rotate the independent epoch before controlled recovery, replay deletion evidence, invalidate restored grants/sessions/approvals, and explicitly reauthorize current security/routing. Missing or incomplete journal coverage keeps the installation closed. Live phone-provider writes remain a separate uncertainty boundary; this deletion journal does not prove Twilio termination or reservation success.

Revisit when adding multi-location subject selection, operation-specific MFA, approved vendor reservation writes, or production traffic. Those changes need separate capabilities, dispatch/reconciliation evidence, privacy decisions and real-provider acceptance.
