# Security Review: deskcomm-agenda-horarios

## Scope

Focused six-file production diff security review, immutable 17a67d3da..1adb4ee92, PR #2523.

- Scan mode: branch_diff
- Target kind: git_diff
- Target ID: target_sha256_f7f6cc2550b72f69cc0009c4f33452abb3ec4da64a6cbd4a07b1d66bf2794b3b
- Revision range: 17a67d3da6193f716562ee3adab5c8326a9037ce...1adb4ee9288c35ab4e5bbe9b2ad5a4b2e383e4c1
- Snapshot digest: codex-security-snapshot/v1:sha256:493620cdf76b89d216afe4be67ac39dc9b06652ca68302af64ffe8419b913eab
- Inventory strategy: diff
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: lib/agent-engine/agent/abertura/agenda-no-fechamento.ts, lib/agent-engine/agent/abertura/checkpoint.ts, lib/agent-engine/agent/abertura/ritual.ts, lib/agent-engine/agent/compromissos-do-contato.ts, lib/agent-engine/agent/inbound-turn.ts, lib/mcp/tools/agendamento.ts, SECURITY.md, artifacts/agenda-diff-review.md, docs/testing/agenda-horarios-e-fechamento.md

Limitations and exclusions:
- Only the immutable six-file production diff and relevant dependencies were reviewed.
- Existing prompt-injection exposure and full authentication deployment were not comprehensively assessed.
- Maintainer commits after 1adb4ee92 are outside this immutable scan.
- Excluded unchanged repository surfaces: This is an immutable diff review, not a whole-repository audit.
- Excluded production runtime and WhatsApp delivery: No production mutation or external message delivery was performed.
- Excluded commits after 1adb4ee92: New maintainer commits are checked separately and are outside this immutable scan.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | complete |
| Validation mode | Read-only source review and previously executed eight native PostgreSQL regressions with fictitious data |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

# Threat model: appointment facts and turn closing

Scope: immutable PR diff `17a67d3da6193f716562ee3adab5c8326a9037ce..1adb4ee9288c35ab4e5bbe9b2ad5a4b2e383e4c1`. Six changed production TypeScript files; tests and documentation are support evidence, not a full repository security audit.

Assets: tenant-private appointment titles, times, meeting links, contact context, persistent checkpoint integrity, and the already-sent customer response. Database integrity remains enforced by the existing native appointment writers.

Entry points and trust boundaries:
- Untrusted customer/history content enters the existing agent turn. Tenant/contact identifiers come from runtime context; the new closing query is parameterized and scopes both identifiers.
- Appointment records cross from PostgreSQL into the model context. The added local labels preserve instants and use the existing validated time-zone formatter. Appointment titles remain untrusted data; they do not become executable tool commands.
- Native appointment tool results cross into the complete model-message tape and the closing call. The closing model call has no tools. The existing pruning policy remains active.
- A bounded post-action read crosses the database boundary only when the opening has appointments or this turn used an appointment tool. Preview mode skips the read and does not treat proposed writes as completed.

Attacker capabilities: send arbitrary customer text, supply permitted appointment inputs through an authorized tool caller, and cause malformed or misleading data in text fields subject to existing writer validation. This diff adds no public endpoint, secret lookup, network destination, shell command, permission, or write capability.

Security objectives: do not disclose another tenant/contact's appointments; do not bypass native role/scope and ownership checks; do not expose credentials; do not replay an already-sent response after the supplemental read fails; preserve completed tool facts without expanding tool authority.

Assumptions/limits: native context authentication and appointment writers are existing dependencies inspected at their relevant boundaries. Existing prompt-injection exposure of customer and record text is not comprehensively reassessed. No production data, external WhatsApp send, or full deployment authentication was tested. Read-only source review is supported by the already executed eight PostgreSQL invariants with fictitious records and five isolated real-model scenarios.

Source anchors: `compromissos-do-contato.ts:62-73`, `agenda-no-fechamento.ts:26-47`, `inbound-turn.ts:4625-4715`, `mcp/tools/agendamento.ts:493-533,1018-1163`, and `lib/tempo/agora.ts:139-166`.

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| lib/agent-engine/agent/abertura/agenda-no-fechamento.ts | not recorded | No issue found | New helper calls the bounded parameterized read with trusted organizationId/contactId; no tools, writers or external requests. Agenda tool detection inspects current turn tape. Failure is not converted into empty agenda. Evidence: artifacts/agenda-diff-review.md |
| lib/agent-engine/agent/abertura/checkpoint.ts | not recorded | No issue found | Instruction only changes preservation of stale summary facts. No new permissions or tool capability. Existing contact/tenant scoped checkpoint writer remains unchanged. Evidence: artifacts/agenda-diff-review.md |
| lib/agent-engine/agent/abertura/ritual.ts | not recorded | No issue found | Existing same-contact appointment block receives precedence text. No new record source or output channel; appointment titles are still data. Evidence: artifacts/agenda-diff-review.md |
| lib/agent-engine/agent/compromissos-do-contato.ts | not recorded | No issue found | SQL keeps organization_id=$1 AND contact_id=$2, non-cancelled/current end filter, limit 6. Formatter adds validated local labels/ISO offsets, conserves instants and existing meeting-link readiness rule. Evidence: artifacts/agenda-diff-review.md |
| lib/agent-engine/agent/inbound-turn.ts | not recorded | No issue found | Complete result tape remains same turn; existing pruning retained; closing call has no tools. Fresh read uses job tenant/contact, preview skips it, read failure is caught after send instead of causing replay. Native insertCheckpoint remains tenant/contact scoped. Evidence: artifacts/agenda-diff-review.md |
| lib/mcp/tools/agendamento.ts | not recorded | No issue found | Only adds local labels to existing result payloads. Existing list guard refuses foreign contact/lead in a conversation; organizationId comes from trusted context. Writer actor/role/scope/idempotency/source checks and human outcome confirmation unchanged. Evidence: artifacts/agenda-diff-review.md |
