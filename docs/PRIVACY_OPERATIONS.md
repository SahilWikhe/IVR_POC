# Caller-content minimization and recovery authority

This revision implements caller-content minimization, independent recovery-authority contracts, and bounded journal replay. It does not approve a restaurant's retention period, delete provider-held data, establish legal compliance, or verify a cloud restore. Missing policy means cleanup is off. Live integrations and production startup remain gated; see [implementation status](IMPLEMENTATION_STATUS.md).

The explicitly authorized local debug transcript feature is separate from this database workflow. `VOICE_DEBUG_TRANSCRIPTS` defaults off and is restricted to the loopback GPT-Live demo. Its private text files can contain caller contact details and are never added to the recovery journal, ordinary logs, or dashboard. Files under `.data/voice-transcripts` expire 24 hours after creation; each enabled component cleans its own files at startup and every minute while running. Cleanup resumes on the next enabled start after downtime. Disabling capture stops collection but does not immediately delete existing files. Keep these files out of exports, backups, and Git, and see [voice setup](VOICE_SETUP.md) for bounds and interpretation. No audio recording or provider-retention change is introduced.

## Explicit policy and operator identity

`retentionPolicySchema` accepts a disabled versioned policy or an enabled policy containing a policy ID, version, approval reference, and `closedAfterDays` from 1 to 3,650. These bounds constrain configuration; they are not recommended legal retention periods. A configured approval reference records the operator's reviewed decision and does not independently prove customer authorization. The restaurant/platform must approve purposes, regions, retention values, exceptions, and provider responsibilities before enabling cleanup. No default duration is silently activated.

The dedicated `hostline_privacy` PostgreSQL role can minimize supported content and maintain privacy/recovery records under FORCE RLS. Ordinary API and worker roles cannot modify those records or advance recovery checkpoints. `createPrivacyPersistence` uses a separate restricted native PostgreSQL login, or an explicitly selected initialized offline embedded database with the application stopped. It runs no migrations or demo seeding. Each transaction checks that the assumed role cannot log in, bypass RLS, own tables directly or transitively, administer roles/databases, or replicate, and cannot assume application, worker, or auth-broker roles. Native login privileges receive the corresponding checks. Do not reuse those runtime logins, a database owner, or a superuser for this operation. Use the configured verified database CA for native cloud connections; keep credentials in secrets.

Each transaction enters one verified tenant context, uses bounded statement/lock timeouts, and participates in the restaurant lock order. Policy writes use an expected-version check. Holds contain only call/approval identifiers and an expiry; their legal basis, approver, expiry review, and operational ownership are external decisions. The SQL roles do not provide a public deletion API or authenticate a caller's privacy request.

## Scheduled minimization and admission

A batch examines at most 25 calls. New deletion admission requires a non-active call older than the approved cutoff, every linked inbox item closed and old enough, no current privacy hold, and an ended physical phone call with no unresolved dispatch control. Active calls, `IN_FULFILLMENT`, `NEEDS_RECONCILIATION`, pending guest notice, uncertain provider controls, and young records are retained for resolution. Expired staff/provider leases never establish safe deletion or permission to repeat a booking. Unsupported or oversized records/receipts block completion.

Planning creates a minimal stable decision. Immediately before journal submission, admission reacquires the tenant lock and verifies the current policy version, cutoff, closed records, supported receipts, and holds. A hold or policy edit that wins before admission prevents that decision. Admission is then durable and **irrevocable**: later policy disablement or a new hold stops future admissions and does not revoke an already admitted deletion. Interrupted admitted work resumes under its original event ID even after new cleanup is turned off. Ordinary closed-record workflows cannot reopen the admitted business work. An unexpected later active/uncertain state prevents automatic scheduled completion and requires quarantined recovery review.

After admission, the independent journal must durably acknowledge the exact decision digest and event ID before any caller content is minimized. A journal outage leaves caller data and the admitted decision intact. A timeout after the external journal committed is uncertain; reuse the same event ID or reconcile through journal replay. Do not invent acknowledgment or record deletion complete before it exists. Provider calls are not part of this workflow.

Minimization is one tenant transaction across all supported copies:

| Surface                | Removed                                                                                               | Preserved                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Call session           | Draft, messages, proposal/canonical readback, free-text outcome                                       | Call IDs, mode/status, timestamps, inbox link, version                                                 |
| Closed inbox item      | Guest name/phone, request/message payload, free-text booking evidence and guest-notice note, assignee | IDs, closed status, guest-notice/evidence category, timestamps, version                                |
| Phone handoff          | Summary and potentially sensitive reason category                                                     | Call/control IDs and timestamp                                                                         |
| Voice control          | Sealed entry/control TwiML, dial destination, free-text outcome                                       | Provider/account IDs, generation, terminal/uncertain state, grant hashes, attempt identity, timestamps |
| Linked replay receipts | Canonical TwiML, transcript/draft/request content, free-text result                                   | Receipt key/fingerprint and supported minimal response/tombstone shape                                 |

The module changes no resolved business state, recreates no inbox item, and performs no booking, dialing, delivery, or notification. Outbox/jobs and security audits currently contain references rather than caller payloads; they are retained. Request IDs, provider IDs, grant hashes, and fingerprints remain restricted pseudonymous evidence. The first release retains replay tombstones indefinitely because deleting one could allow an old signed incoming event to recreate a call. A separate reviewed replay/backup horizon and admission design are needed before shortening that evidence retention. Caller-content deletion is not complete erasure of all linkable metadata.

New receipts have a composite tenant/call association. Unlinked legacy receipts block tenant cleanup rather than being silently ignored: an older callback receipt can retain canonical guest details despite an otherwise clean inbox. Unknown receipt shapes also block completion. An authorized reviewed backfill/reconstruction is needed before using old databases whose receipt association is absent; this phase provides no unsafe generic JSON scrubber.

Unresolved holds must not retain contact details indefinitely without review. The current scheduler conservatively skips them and requires operational escalation; it does not silently enforce a maximum lifetime by erasing evidence needed to resolve an uncertain booking. Record that conflict, responsible owner, and approved resolution using the privacy/security policy.

## Independent authority and runtime quarantine

`RecoveryAuthority` is injected behind three bounded operations: read the current manifest, append an immutable deletion decision, and read a contiguous deletion page. Each operation has a three-second caller deadline and cancellation signal; even an adapter ignoring cancellation cannot make the operation wait indefinitely. Fake authorities are synthetic-test evidence only.

The manifest binds an installation ID, an external epoch, and the actual database resource identity. It records a current security version, explicit security reauthorization, complete journal coverage, a global journal sequence, and an approved `replaySources` lineage. The bounded source list includes the current epoch/resource and explicitly reviewed historical sources. A single installation journal survives epoch and database changes; historical entries retain their original source binding.

Runtime readiness compares the expected service binding, independently read manifest, and restricted database checkpoint. Missing/unavailable authority, changed epoch/resource/security version, missing external reauthorization, incomplete journal coverage, or a checkpoint behind/ahead of the journal keeps protected data/actions quarantined. No database flag alone provides restore-independent authority. Old service processes remain fenced under their expected epoch and must not automatically adopt a new one.

A physical RDS restore changes its database resource identity; the deployment must verify that identity independently against the actual connection target. A logical/in-place restore may leave that identity unchanged. Controlled logical restore therefore requires an external epoch rotation, isolation of the old fleet, and an enforced recovery procedure. Matching checkpoint values cannot magically detect an unauthorized SQL overwrite or a privileged operator bypassing restore custody.

An appended deletion immediately advances independent evidence. Normal batch results report `needsReplay` while the fleet checkpoint remains behind. The operator must replay **all** intervening installation journal entries, including concurrently appended decisions for other tenants, before reopening access. No “set checkpoint to latest” shortcut is safe.

## Bounded replay and controlled restoration

`replayRecoveryJournal` reads contiguous pages of at most 25 entries and defaults to four pages per pass, with an explicit maximum of twenty. It validates entry sequences, digest, installation ownership, current page epoch, and approved source lineage. A gap, malformed entry, unsupported receipt, unknown source, conflict, or incomplete coverage stops progress. It advances checkpoints with compare-and-set only after applying every entry through that point. Partial passes remain quarantined and can continue from the persisted contiguous checkpoint.

Scheduled replay requires the current binding and admitted decisions. Restore replay requires an explicitly selected, quarantined recovery operation. It reapplies independently journaled minimization even when an older database copy shows active/uncertain call or fulfillment states. It removes restored caller content while preserving those states and their replay/uncertainty evidence; it does not reopen or redrive business work.

External `securityReauthorized` must attest completed **current** security/control-plane reconstruction before a recovery checkpoint permits normal access. That reconstruction includes invalidating restored sessions, media grants, call ownership, job leases and unused approvals; retaining canceled/revoked routing/actions; independently verifying current owner/membership, number/account/location and transfer destinations; and reconciling possible external writes. The separate `quarantineRestoredDatabase` operator helper performs local fencing while the independently read manifest remains unverified; it does not change that manifest, journal, or checkpoint. The privacy library does not set the external flag or prove reconstruction merely by replaying deletion entries. A restored old OIDC token, membership row, or database receipt cannot authorize recovery.

The independent journal contains only minimal IDs, policy/version, cutoff/time, decision kind, sequence, and digest. Keep it encrypted and restrict append/read/recovery privileges separately; no guest names, numbers, free-text notes, raw audio, canonical payloads, or credentials belong there. Its retention/integrity/backup coverage must support the oldest permitted restore and replay horizon. Journal gaps or expired coverage require independently authorized reconstruction; they cannot be repaired by asserting a complete flag.

## Operator CLI

[The privacy operator](../scripts/privacy-ops.mjs) uses strict reviewed JSON files and explicit commands. Run `node --import tsx scripts/privacy-ops.mjs --help` to see each input schema. Input files contain only identifiers, limits, policy, and manifest metadata; keep them outside Git. The reader rejects oversized files, symlinks, and special files. Credentials and connection URLs belong in secrets, never in those files.

| Command      | Purpose                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `inspect`    | Read minimal policy, checkpoint, and independent readiness metadata; it does not reopen access.             |
| `policy`     | Compare-and-set a reviewed versioned policy with `expectedVersion`, or `null` for its first creation.       |
| `batch`      | Admit and minimize up to 25 eligible calls for one tenant; an append requires subsequent contiguous replay. |
| `replay`     | Apply bounded contiguous pages in scheduled mode, or explicit restore mode with `--quarantined`.            |
| `manifest`   | Compare-and-set the external manifest against an exact prior manifest and an operator approval reference.   |
| `quarantine` | Fence a restored database while the external manifest remains unverified; requires `--quarantined`.         |

Example invocations after operator configuration, using already reviewed input files:

```sh
node --import tsx scripts/privacy-ops.mjs inspect --file /secure/operator/inspect.json
node --import tsx scripts/privacy-ops.mjs policy --file /secure/operator/policy.json
node --import tsx scripts/privacy-ops.mjs batch --file /secure/operator/batch.json
node --import tsx scripts/privacy-ops.mjs replay --file /secure/operator/scheduled-replay.json
```

Native database commands require `DATABASE_PRIVACY_URL`, `DATABASE_CA_FILE`, `AWS_REGION`, and the complete fixed recovery configuration: `RECOVERY_INSTALLATION_ID`, `RECOVERY_EPOCH`, `RECOVERY_DATABASE_RESOURCE_ID`, `RECOVERY_DATABASE_INSTANCE_ID`, and `RECOVERY_TABLE_NAME`. No additional free-form target is accepted in JSON. The CLI verifies the actual RDS connection target before opening persistence and before each database operation. Restore fencing instead uses the distinct `DATABASE_MIGRATION_URL` owner identity and requires the old fleet stopped. Manifest changes use the independently configured authority and do not open the database.

Exit status 2 means unavailable work, required replay, or partial replay remains. Re-run the appropriate reviewed bounded operation and inspect readiness. Successful CLI completion is evidence of that operation only; it does not approve retention, reconstruct current authority, or authorize reopening a quarantined installation. A manifest approval UUID records an external review reference and is not authentication or proof that a restore is safe.

## Remaining acceptance evidence

Synthetic tests use the PostgreSQL engine through PGlite and a separate fake authority. They cover policy defaults, role/tenant restrictions, supported copy minimization, legal-hold admission races, uncertain journal acknowledgment, unknown/legacy receipt blocks, deadline cancellation, contiguous concurrent replay, and changed-source restore quarantine. They do not establish deployed IAM, actual RDS identity/TLS, real provider retention/deletion, journal availability/immutability, or an operational restore drill.

Before the restaurant pilot, approve retention and holds, deploy/review the external authority with restricted service identities, bind the actual database resource, exercise a real deletion/restore with revoked members/canceled actions/reassigned numbers, verify retained tombstones and no old write redrive, and document provider deletion plus backup expiry. See [security guidance](SECURITY.md), [operations](OPERATIONS.md), and [testing](TESTING.md). Production rejection remains until those controls and evidence are reviewed.
