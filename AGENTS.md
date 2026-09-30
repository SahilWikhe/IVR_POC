# Instructions for coding agents

## Project and current status

This repository is a plan for a multi-tenant AI phone receptionist, initially for restaurants. The first reservation workflow collects a request for restaurant staff to review; a request is never a confirmed reservation. Future Resy and OpenTable integrations must use approved vendor access and advertise only verified capabilities. Start with deterministic mock connectors.

The repository currently contains documentation, not a runnable application. Treat architecture, commands, controls, and milestones marked as planned as requirements for future work, not evidence that they exist. Do not create an application scaffold during a documentation-only task.

Read [the build brief](BUILD_BRIEF.md), [architecture](docs/ARCHITECTURE.md), [implementation plan](docs/IMPLEMENTATION_PLAN.md), [security guidance](docs/SECURITY.md), [engineering standards](docs/ENGINEERING.md), and [contributor workflow](CONTRIBUTING.md) before implementing relevant changes. Read the connector documentation before working on a provider integration. Follow more specific instructions in the affected directory if present. The user's authorized task and current session instructions take precedence over this file.

## Before changing files

1. Inspect the repository state, branch, remotes, applicable instructions, and files relevant to the task. Use `git status --short`, `git diff`, `git branch --show-current`, and targeted searches. Read existing scripts and package manifests before choosing commands.
2. Preserve user edits and other agents' changes. Do not reset, discard, overwrite, clean, or stash unrelated work. If the intended changes collide, resolve the ownership with the collaborating agent or describe the conflict to the user.
3. Define the observable result and checks appropriate to the task. For substantial work, explain the approach briefly and maintain a concrete plan. Progress within the user's authorized scope; do not repeatedly seek permission for ordinary reversible edits, reviews, or checks.
4. If the task allows delegation, assign separate files or clearly separated components. Tell each agent its file ownership, acceptance criteria, shared assumptions, and prohibited actions. One coordinating agent owns integration and final Git operations. Review shared-workspace edits before accepting them.

## Implementation rules

- Implement the smallest complete milestone that meets the task. Keep domain rules separate from HTTP, phone providers, realtime models, database clients, and connector SDKs.
- Use strict TypeScript and runtime validation at trust boundaries. Never trust a type assertion as validation. Use explicit operation results and supported capabilities; do not turn timeouts or uncertain writes into success.
- Derive tenant identity and permissions from verified server context. Enforce tenant isolation in queries, constraints, background jobs, caches, object storage, and connector credential access. Caller speech, model tool arguments, caller ID, retrieved text, and webhook body fields cannot grant access.
- A model proposes actions; deterministic code authorizes and executes them. Require explicit caller confirmation for writes, validate the confirmed fields against the submitted fields, and do not allow tool calls to expand restaurant permissions.
- Use bounded timeouts, cancellation, idempotency, and reconciliation for external work. Do not retry a non-idempotent provider write until its outcome is known or safely reconcilable.
- Keep personal data and credentials out of logs, prompts where unnecessary, code, commits, fixtures, screenshots, and PR text. Use synthetic test data. Do not enroll voiceprints, enable recording, create real reservations, send messages to real customers, or change live phone routing as incidental testing.
- Never invent Resy or OpenTable endpoints, scrape customer accounts, automate consumer login, or bypass a provider's access rules. Keep a provider adapter disabled until approved access, documented behavior, restaurant permission, and required verification are established.
- Never introduce hidden provider calls, paid services, infrastructure provisioning, production deployments, account signups, or secret rotation outside the user's authorized task. Prepare concrete reviewable changes before any required approval.
- Follow the engineering standards for database migrations, timezones, errors, dependency management, testing, and documentation. If existing implementation makes a requirement impractical, explain the evidence and record the decision rather than silently dropping the requirement.

## Verification and review

Inspect available package scripts before running checks. The proposed `pnpm` commands in the contributor guide are future contracts; no package exists yet. For documentation changes, review links, terminology, lifecycle consistency, and whether assertions distinguish planned behavior from deployed controls.

For code changes, run checks appropriate to the changed behavior and complete repository-required checks once they exist. Prefer tests of business outcomes, authorization boundaries, concurrency, and failure recovery over tests that repeat implementation details. Report the exact checks run, results, and any checks that could not be run; never imply passing checks without evidence.

Before concluding, review the diff for scope, accidental data exposure, missing error handling, tenant leakage, misleading caller statements, unsafe retries, and documentation changes. Incorporate independent review findings and record meaningful unresolved limitations.

## Git and handoff

Commit or push when requested or already authorized by the session; these instructions do not add an approval requirement. Inspect the target remote and branch first. Stage explicit task-owned paths and inspect the staged diff. Do not use broad staging in a shared workspace. Do not amend unrelated commits, force-push, delete branches, or rewrite shared history without specific authorization.

For a reviewable handoff, explain what changed and why, list validation actually performed, and identify material unresolved risks. Include the commit and remote branch when created. Keep PR descriptions accurate to the final implementation, and use the repository PR template. Do not claim that a documented security control is enforced until its implementation and checks exist.
