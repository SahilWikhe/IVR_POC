# Hostline — restaurant AI receptionist

Hostline is a runnable local prototype for a restaurant phone receptionist. Its dashboard lets staff edit restaurant information, simulate conversations, collect unconfirmed reservation requests and messages, and track staff follow-up. Two synthetic restaurants demonstrate tenant isolation.

The separate Twilio/OpenAI Realtime gateway includes a durable phone-action foundation: restaurant FAQs, caller-confirmed requests/messages, and transfers to a configured staff number. Voice, request actions, and transfers are disabled by default and have not been verified through a real provider call. Production startup remains blocked. [Implementation status](docs/IMPLEMENTATION_STATUS.md) separates implemented behavior, verification evidence, and remaining work.

## Run the local demo

Use Node.js **24.19.0** and pnpm **11.19.0**. The versions are recorded in `.node-version` and `package.json`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Open **http://127.0.0.1:5173** and enter Harbor Table or Juniper Kitchen. Keep this exact origin: cookie-authenticated mutations verify the configured dashboard origin. The API listens on `127.0.0.1:3001`; Vite proxies `/api` to it. `pnpm dev` starts both processes and stops them together.

The demo needs no provider credentials or database server. PGlite runs PostgreSQL compiled to WebAssembly and persists synthetic data in `.data/hostline`. Restarting preserves edits and submitted requests; demo seeds do not reset existing records. Session cookies expire after eight hours or an API restart. Only one API process may open this embedded data directory; its internal job loop handles demo jobs.

Try a conversation in **Call simulator**, review the exact request details, and use the explicit confirmation button to save it. In **Requests**, claim an item, record staff handling or booking evidence, and record guest communication separately. A saved request does not reserve a table. The simulator is deterministic and does not call an AI model or telephone provider. Enter synthetic details only.

## Stack and verification

- TypeScript/pnpm workspaces; React, Vite, and Zod runtime contracts.
- Fastify API with signed opaque sessions, Origin/CSRF checks, role checks, and tenant-scoped persistence.
- PostgreSQL schema with forced row-level security, tenant composite keys, transactional receipts/outbox, and fenced internal jobs. PGlite supplies the default local engine; a separate `pg` adapter supports configured native PostgreSQL development.
- Optional OIDC authorization-code login with PKCE/state/nonce and explicit subject memberships. It needs an identity provider and provisioned native database tenants; it is not a one-command production setup.
- Separate persistent Node.js voice gateway using Twilio bidirectional Media Streams and OpenAI Realtime. OpenTable and Resy remain disabled capability adapters pending official access.
- Tenant-scoped durable phone state and callback receipts. The model prepares a proposal; Twilio reads the canonical fields before a separate speech-confirmation step can save it. The model has no confirmation tool.

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

`pnpm check` runs formatting, lint, strict typechecking, a credential-pattern baseline, credential-free tests, and builds. Browser tests are separate. `pnpm start` starts the built API; it does not serve or deploy the dashboard. The [contributor guide](CONTRIBUTING.md) describes individual commands and database prerequisites. CI is checked in; repository-required checks and security scanning settings require separate verification.

## Phone setup and release boundary

Read [Voice setup](docs/VOICE_SETUP.md) and [call-control behavior](docs/TWILIO_CALL_CONTROL.md) before starting `pnpm dev:voice`. Configure Twilio and OpenAI secrets in the environment or ignored `.env`, together with the dedicated test number, HTTPS gateway URL, and internal service token. Never paste credentials into chat or commit them. `LIVE_VOICE_ENABLED`, `VOICE_ACTIONS_ENABLED`, and `VOICE_TRANSFERS_ENABLED` all default to `false`; the action flags require the explicitly configured voice sandbox.

The intended pilot routes the restaurant's existing number through provider forwarding to a dedicated platform number, then through the voice gateway to OpenAI Realtime. First verify our implementation on a dedicated test number. Real readback/confirmation, transfer/fallback, provider privacy settings, and operational readiness need acceptance evidence before restaurant-number forwarding or public calls. A connected staff line may be voicemail; a saved reservation request remains unconfirmed. Setting `NODE_ENV=production` currently fails startup deliberately.

Twilio also offers a separate [Conversations / Agent Connect sandbox](https://www.twilio.com/docs/conversations/agent-connect/quickstart) for exploring its demo experience. Twilio's [official OpenAI Realtime example](https://github.com/twilio/twilio-agent-connect-typescript/blob/main/getting_started/examples/openai-realtime/src/index.ts) uses a voice-capable Twilio number, public endpoint, and OpenAI key for a custom Media Streams bridge. This project follows that custom-number path. Access to a free demo does not verify our endpoints, confirmation, transfers, or callbacks; custom-agent support in the free sandbox remains unverified.

Direct booking, reservation changes/lookups, ordering, payments, voiceprints, and synthetic-voice detection are later phases. Resy and OpenTable require approved vendor access and independently verified capabilities; no live connector is available today.

## Documentation

| Document                                                                                                                 | Purpose                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [Implementation status](docs/IMPLEMENTATION_STATUS.md)                                                                   | Delivered behavior, evidence, and launch gates                |
| [Build brief](BUILD_BRIEF.md)                                                                                            | Target pilot scope and example customer experience            |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md)                                                                       | Milestones, dependencies, and acceptance gates                |
| [Architecture](docs/ARCHITECTURE.md)                                                                                     | Components, call lifecycle, APIs, and trust boundaries        |
| [Data model](docs/DATA_MODEL.md)                                                                                         | Tenant ownership and transaction invariants                   |
| [Integrations](docs/INTEGRATIONS.md)                                                                                     | Request fulfillment and optional provider foundations         |
| [Voice setup](docs/VOICE_SETUP.md)                                                                                       | Disabled-by-default phone sandbox configuration               |
| [Twilio call control](docs/TWILIO_CALL_CONTROL.md)                                                                       | Canonical readback, bounded dispatch, and transfer behavior   |
| [Security design](docs/SECURITY.md)                                                                                      | Threat model, privacy rules, and required controls            |
| [Engineering standards](docs/ENGINEERING.md)                                                                             | Coding and review standards                                   |
| [Testing strategy](docs/TESTING.md)                                                                                      | Functional, security, connector, and voice scenarios          |
| [Operations](docs/OPERATIONS.md)                                                                                         | Reliability, recovery, and rollout requirements               |
| [Decisions](docs/DECISIONS.md), [ADR-009](docs/adr/009-local-prototype.md), and [ADR-010](docs/adr/010-phone-actions.md) | Architecture decisions, prototype boundary, and phone actions |
| [Architecture review](docs/ARCHITECTURE_REVIEW.md)                                                                       | Review findings and open dependencies                         |
| [Contributing](CONTRIBUTING.md) / [Agent instructions](AGENTS.md)                                                        | Human and agent contribution workflows                        |
| [Security reporting](SECURITY.md)                                                                                        | Private vulnerability-reporting guidance                      |
