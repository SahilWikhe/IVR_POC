# Account setup after the coding milestone

The code is prepared for an isolated restaurant pilot. Keep secret values out of Git, chat, frontend variables and command output. Configure runtime secrets in AWS Secrets Manager; use short-lived CLI/SSO access for setup. [Implementation status](IMPLEMENTATION_STATUS.md) distinguishes local evidence from live acceptance.

## AWS and release automation

Provide an authenticated AWS CLI session for the intended account, the region, application/voice domain names, and the DNS zone to use. Confirm the intended pilot environment and operating cost limits before creating resources. The managed coding workspace does not automatically inherit a local computer's CLI login.

Follow [AWS deployment](AWS_DEPLOYMENT.md) to create the bootstrap and retained data/network stacks, review the scoped GitHub OIDC role and permissions boundary, provision distinct migration/API/worker/privacy identities, and populate secrets. The database URL must name its actual target explicitly and use the provided RDS trust bundle. Prepare the external recovery manifest/checkpoint and explicit restaurant access before expecting API readiness.

Set the documented GitHub repository/environment variables and protected deployment environments. Main-triggered staging requires `AWS_STAGING_READY=true` and successful Checks for the selected revision; it is disabled until configured. `AWS_OPERATIONS_READY` separately enables status/logs/redeploy/cleanup workflows. Production remains blocked in code. Cleanup deletes only the named application stack and preserves the data/network/recovery stack; deleting retained customer data is a separate procedure.

## Auth0

The user has authorized use of their authenticated Auth0 CLI. Run it from an environment that actually has that session. Inventory the current Auth0 tenant first, then use [Auth0 setup](AUTH0_SETUP.md) to create/configure a **Regular Web Application** for the server-side login flow, exact HTTPS callback/logout/origin settings, and required MFA.

Runtime values are `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `SESSION_SECRET`, and distinct `SESSION_ENCRYPTION_SECRET`. Only the client secret and session keys are secret values. `OIDC_REQUIRE_MFA` defaults true. Use the explicit identity operator to provision the approved restaurant and verified issuer/subject membership; never use email matching or provider-supplied role claims as authorization.

Verify real login, MFA, logout, session restart, role change, suspension and revocation. Hostline logout revokes its application session, rather than every Auth0 SSO session.

## Twilio and OpenAI

Provide a dedicated Twilio test number and its account SID/auth token, plus an OpenAI API key with access to the configured Realtime model. Set secrets on the service that needs them. The voice gateway and API share a separately generated `VOICE_SERVICE_TOKEN`; their tenant, account, phone number and public/internal URLs must agree. [Voice setup](VOICE_SETUP.md) lists exact variables and signature requirements.

All live voice/action/transfer flags default false. Configure signed webhooks and media against the dedicated number, publish the reviewed [independent fallback](PHONE_FALLBACK.md), and run the documented call scenarios before changing a restaurant's existing-number forwarding. Supply an approved independent staff destination and verify it does not forward back into the same route.

## Restaurant and future providers

Supply the pilot restaurant's timezone, hours/holiday closures, menu/services, approved FAQs, staff destinations and inbox owner. Approve the AI greeting, follow-up workflow, privacy notice, retention/hold decisions and incident contact. Reservations initially become staff-review requests, not confirmed tables.

OpenTable and Resy remain disabled until the restaurant/vendor supplies approved API or partner access and documented capabilities. The connector boundaries are prepared; unsupported endpoints will not be invented. Voiceprint enrollment, ordering, payments and sensitive reservation lookup/change are outside this first pilot.
