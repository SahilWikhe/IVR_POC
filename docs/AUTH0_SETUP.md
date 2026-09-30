# Auth0 pilot setup

Hostline uses Auth0 Universal Login through its Fastify backend for frontend login. The React dashboard receives a signed, opaque, HttpOnly session cookie; it does not receive Auth0 tokens or a client secret. `openid-client` validates the authorization-code flow, PKCE, state, nonce, signature, issuer, audience, and token lifetime. Restaurant roles come from explicitly provisioned database memberships, not email addresses, Auth0 profile metadata, organization claims, or browser fields.

These are operator instructions prepared for the next infrastructure phase. No Auth0 account, application, factor, user, or live login was created during coding. Consult [identity operations](IDENTITY_OPERATIONS.md), [implementation status](IMPLEMENTATION_STATUS.md), and [the security requirements](SECURITY.md) before exposing the pilot.

## Application and exact URLs

Use a dedicated pilot Auth0 tenant and create a **Regular Web Application** for Hostline. The authorization-code exchange takes place on the backend. Configure the token endpoint authentication method as `client_secret_post`, matching the current `openid-client` integration. Select RS256 signing and Auth0 Universal Login. Keep public self-registration disabled for this staff-only pilot and arrange invited/operator-created staff accounts using your established account-management process.

Register exactly the dashboard HTTPS origin followed by `/api/auth/callback` as the allowed callback URL, for example `https://hostline.example.com/api/auth/callback`. Register the dashboard origin as the allowed logout URL and web origin. Use the actual controlled domain; do not register wildcards. The reverse proxy must route `/api/*` to the API, and the callback origin must match `DASHBOARD_ORIGIN`. Issuer is the exact Auth0 issuer identifier, typically `https://YOUR_TENANT.auth0.com/`; it is not a discovery-document URL. If using a custom domain, verify the discovery issuer and configure one consistent issuer everywhere.

Auth0 CLI command discovery is available when an operator has installed and authenticated that CLI in the correct account:

```bash
auth0 apps create --help
auth0 apps update --help
```

After checking your installed version's flags, the regular-application creation shape is:

```bash
auth0 apps create --name "Hostline Pilot" --type regular \
  --callbacks "https://hostline.example.com/api/auth/callback" \
  --logout-urls "https://hostline.example.com" \
  --origins "https://hostline.example.com"
```

Complete and verify `client_secret_post`, signing, and connection settings in Auth0. Application creation output can contain a client secret: use a private operator terminal, move the secret directly to the secret manager, and avoid chat, shared command logs, and checked-in files. Hostline does not need an Auth0 Management API credential for ordinary login.

## MFA and account recovery

`OIDC_REQUIRE_MFA=true` is the default. Hostline requests fresh authentication with `max_age=0` and the multi-factor `acr_values` request. The backend requires verified ID-token `amr` to contain `mfa`, records the successful MFA verification time, and enforces MFA when loading the resulting session. A claimed or missing MFA flag from browser state is insufficient.

Enable a usable factor before requiring MFA. Prefer TOTP or WebAuthn, and arrange recovery codes and a documented administrative recovery process. For a dedicated pilot tenant, Auth0's tenant-wide policy can require MFA on every application. The following commands change tenant-wide configuration and should be run only against the intended dedicated tenant after reviewing its existing applications:

```bash
auth0 api put "guardian/factors/otp" --data '{"enabled":true}'
auth0 api put "guardian/policies" --data '["all-applications"]'
auth0 api get "guardian/policies"
```

For a shared Auth0 tenant, use a reviewed application-specific post-login Action instead of replacing the tenant-wide policy. Factor availability and enforcement are separate settings; enabling a factor alone does not enforce MFA. Verify your Auth0 plan's available factors and recovery features. Keep the application requirement enabled and verify the actual returned ID-token claims with an authorized synthetic staff account before rollout.

Hostline logout revokes its database session and cancels its own pending or completed login attempt, including across API replicas. It does not currently perform Auth0's federated/provider logout or revoke every Auth0 account session. Fresh MFA is requested again for Hostline login. User disablement in Auth0 does not automatically invalidate an already issued Hostline session: explicitly suspend/revoke Hostline membership or identity access as part of offboarding.

## Environment inventory

Configure these through environment secrets or the selected deployment's secret manager. Never submit secret values in chat or place them in frontend variables.

| Variable                    | Purpose                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `AUTH_MODE=oidc`            | Enables hosted staff login; demo login remains restricted to synthetic loopback use.           |
| `DASHBOARD_ORIGIN`          | Exact controlled HTTPS browser origin.                                                         |
| `OIDC_ISSUER`               | Exact issuer, including the provider's required trailing slash.                                |
| `OIDC_CLIENT_ID`            | Regular Web Application client identifier.                                                     |
| `OIDC_CLIENT_SECRET`        | Backend token-exchange secret.                                                                 |
| `OIDC_REDIRECT_URI`         | Exact dashboard-origin callback URL.                                                           |
| `OIDC_REQUIRE_MFA=true`     | Requires verified MFA for login and session use.                                               |
| `SESSION_SECRET`            | Strong, persistent cookie-signing and derived CSRF secret; share consistently across replicas. |
| `SESSION_ENCRYPTION_SECRET` | Separate strong secret for AES-GCM encryption of pending state/nonce/PKCE payloads.            |
| `DATABASE_URL`              | Restricted runtime PostgreSQL connection, distinct from the migration connection.              |
| `DATABASE_CA_FILE`          | Trusted database CA bundle path; explicit certificate and hostname verification.               |
| `DATABASE_MIGRATION_URL`    | Privileged migration/operator connection; keep out of API and gateway deployments.             |

The legacy `OIDC_MEMBERSHIPS` startup mapping is removed. An Auth0 account alone does not grant restaurant access. Provision the restaurant and exact verified issuer/subject membership explicitly using [identity operations](IDENTITY_OPERATIONS.md). One active restaurant membership per identity is required by the current login selection flow; multi-restaurant switching is not implemented.

Pending login attempts expire for authorization after five minutes. Claiming an attempt clears its encrypted payload. Database sessions expire after eight hours absolutely or thirty minutes without validated requests, whichever happens first; activity never extends the absolute limit. Role, identity, and restaurant access versions are rechecked in the database on session use and through staff business transactions. Restore quarantine and data recovery are separate controls described in [privacy operations](PRIVACY_OPERATIONS.md).

## Acceptance before live rollout

Verify a real Auth0 login and MFA challenge, exact callback/proxy/cookie behavior, missing-MFA rejection, logout versus a delayed callback, membership/identity suspension and reenablement, replica session sharing, and session expiry using synthetic accounts. Check that demo sign-in is inaccessible remotely, runtime identities cannot assume the migration or broker identity, and secret values do not appear in browser storage or logs. Mocked and locally signed ID-token tests verify code boundaries; they do not establish actual Auth0 tenant settings or account recovery behavior. Production startup remains gated by the project's remaining readiness requirements.

References: [Auth0 regular web applications](https://auth0.com/docs/get-started/applications/application-settings), [MFA](https://auth0.com/docs/secure/multi-factor-authentication), and [step-up authentication](https://auth0.com/docs/secure/multi-factor-authentication/step-up-authentication).
