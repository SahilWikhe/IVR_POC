# Security policy

This repository currently contains planning documents for a proposed AI restaurant phone receptionist. The implementation controls and release requirements are described in [docs/SECURITY.md](docs/SECURITY.md). No supported deployed application versions or audited security/compliance status are asserted.

## Reporting a vulnerability

Do not publish credentials, private caller information, voice recordings, exploit details, or an active vulnerability in a public issue or pull request.

If this repository's GitHub **Security → Report a vulnerability** option is available, use it to submit a private report. Private vulnerability reporting is a repository setting; this document does **not** assert that it has been enabled. The maintainer must verify and enable an appropriate private reporting channel before accepting a live pilot.

If private reporting is unavailable, use an existing private contact channel already established with the repository maintainer or pilot team. If no private channel exists, open only a minimal public issue asking the maintainer to provide a private security contact, without technical vulnerability details, secrets, customer data, or proof-of-concept payloads. Do not invent an email address or send sensitive material to an unverified contact.

A useful private report includes the affected commit/version, feature or endpoint, prerequisites, expected and observed behavior, a minimally invasive reproduction using synthetic data, and likely impact. Redact secrets and personal data. Do not test against real restaurant callers or another tenant without explicit authorization. Keep the report private while the maintainer investigates.

## Maintainer responsibilities

- Establish and verify the private reporting channel, incident contacts, and release owners before live use.
- Acknowledge reports through that channel, assess impact and affected tenants, and coordinate remediation and disclosure. No response-time or bounty commitment is currently established.
- Treat credible reports of tenant isolation, callback authentication, arbitrary transfer, model/tool authorization, credential exposure, and privacy failures as priority issues.
- Rotate potentially exposed secrets and review access when needed; deleting a public secret from the latest commit alone does not remove the exposure.
- Follow the incident and release requirements in [docs/SECURITY.md](docs/SECURITY.md), and update this policy when supported versions and operating responsibilities are established.

Contributors and coding agents must follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Report observed security gaps accurately; documentation, mocks, successful builds and proposed safeguards are not proof that a production control exists.
