# Restaurant AI receptionist

A phone receptionist that answers restaurant questions through natural conversation, collects reservation requests, takes messages, and connects callers to staff. Restaurants keep their existing number by forwarding calls to a platform number.

**Status: planning and documentation only.** There is no application, runnable development environment, deployed infrastructure, or live reservation integration yet. The documentation describes the intended implementation and its release gates; it does not claim that controls or repository settings are already enforced.

## Agreed first release

- One restaurant location per pilot, one language, and restaurant-approved hours, menu facts, and FAQs.
- Reservation **requests** in a staff dashboard. Staff check the restaurant's authoritative reservation system and record the outcome. A saved or delivered request is not a confirmed table.
- Messages and configured transfers to staff, including unanswered-transfer and after-hours behavior.
- A shared, tenant-isolated platform with reusable connector contracts. OpenTable and Resy adapters remain disabled until authorized access and supported operations are verified for each restaurant.

Direct booking, reservation lookup or changes, ordering, payments, voiceprints, and synthetic-voice detection are later phases. Voice recognition and synthetic-voice detection must never establish identity on their own.

## Documentation

| Document | Purpose |
| --- | --- |
| [Build brief](BUILD_BRIEF.md) | Product scope and example customer experience |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Milestones, dependencies, deliverables, and acceptance gates |
| [Architecture](docs/ARCHITECTURE.md) | Components, call lifecycle, APIs, and trust boundaries |
| [Data model](docs/DATA_MODEL.md) | Tenant ownership, relationships, state, and transaction invariants |
| [Integrations](docs/INTEGRATIONS.md) | Request fulfillment and optional OpenTable/Resy adapter foundations |
| [Security design](docs/SECURITY.md) | Threat model, privacy rules, and implementation controls |
| [Engineering standards](docs/ENGINEERING.md) | Code structure, coding practices, and future checks |
| [Testing strategy](docs/TESTING.md) | Functional, security, connector, and voice evaluation scenarios |
| [Operations](docs/OPERATIONS.md) | Deployment, reliability, monitoring, recovery, and rollout |
| [Decisions](docs/DECISIONS.md) | Initial architecture decisions and reconsideration criteria |
| [Architecture review](docs/ARCHITECTURE_REVIEW.md) | Review findings, resolutions, and open release dependencies |
| [Contributing](CONTRIBUTING.md) | Human contribution and review workflow |
| [Agent instructions](AGENTS.md) | Workflow and constraints for coding agents |
| [Security reporting](SECURITY.md) | Private vulnerability-reporting guidance |

Start with the implementation plan, then read the architecture and the documents relevant to the change. Contributors and agents must also read their root instructions.

## Proposed implementation baseline

A TypeScript/pnpm monorepo with a React/Vite staff dashboard, Fastify API, a separately deployable voice gateway for persistent audio WebSockets, and a Node.js background worker. PostgreSQL holds tenant-scoped records and a transactional outbox with leased jobs. An external OIDC provider handles staff sign-in. Phone and realtime voice providers sit behind adapters; Twilio and OpenAI Realtime are candidates whose current capabilities and account access need verification.

The existing managed workspace is a development environment. Production hosting, regions, identity provider, vendors, and accounts are still to be selected. No commercial provider access or security certification is implied by these documents.

## Next implementation milestone

Complete vendor and pilot discovery, then scaffold the repository and build a deterministic conversation simulator with a mock restaurant, a request inbox, and tenant isolation. Real calls follow after the simulator's acceptance and security checks pass. Future command names in these docs are a scaffold contract, not commands that work today.
