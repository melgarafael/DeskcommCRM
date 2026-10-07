# Focused diff review receipt

Immutable range: 17a67d3da6193f716562ee3adab5c8326a9037ce..1adb4ee9288c35ab4e5bbe9b2ad5a4b2e383e4c1.
Policy: repository root SECURITY.md; no nested policy files found. All six changed production files inspected by the parent reviewer; no delegation.

## lib/agent-engine/agent/abertura/agenda-no-fechamento.ts
New helper calls the bounded parameterized read with trusted organizationId/contactId; no tools, writers or external requests. Agenda tool detection inspects current turn tape. Failure is not converted into empty agenda.

## lib/agent-engine/agent/abertura/checkpoint.ts
Instruction only changes preservation of stale summary facts. No new permissions or tool capability. Existing contact/tenant scoped checkpoint writer remains unchanged.

## lib/agent-engine/agent/abertura/ritual.ts
Existing same-contact appointment block receives precedence text. No new record source or output channel; appointment titles are still data.

## lib/agent-engine/agent/compromissos-do-contato.ts
SQL keeps organization_id=$1 AND contact_id=$2, non-cancelled/current end filter, limit 6. Formatter adds validated local labels/ISO offsets, conserves instants and existing meeting-link readiness rule.

## lib/agent-engine/agent/inbound-turn.ts
Complete result tape remains same turn; existing pruning retained; closing call has no tools. Fresh read uses job tenant/contact, preview skips it, read failure is caught after send instead of causing replay. Native insertCheckpoint remains tenant/contact scoped.

## lib/mcp/tools/agendamento.ts
Only adds local labels to existing result payloads. Existing list guard refuses foreign contact/lead in a conversation; organizationId comes from trusted context. Writer actor/role/scope/idempotency/source checks and human outcome confirmation unchanged.

Supporting evidence: tests/unit/agenda-horarios-locais-no-turno.test.ts; tests/unit/mcp-lista-agendamentos-periodo.test.ts; tests/unit/mcp-escrita-de-agenda-tem-horario-local.test.ts; tests/unit/o-agente-enxerga-os-compromissos-do-contato.test.ts; tests/unit/mcp-agendamento-tools.test.ts; tests/invariants/agenda-atual-no-fechamento.test.ts; tests/invariants/o-agente-nao-le-compromisso-de-outra-organizacao.test.ts; tests/invariants/agenda-mcp-nao-alcanca-contato-alheio.test.ts. Existing three-file native PostgreSQL run: 8 tests passed, fictitious records and captured channel. Tests validate read isolation and turn-closing integration; they do not certify the complete repository.

No plausible new security vulnerability identified in this immutable diff. Existing prompt-injection exposure of record/customer text and full authentication/deployment behavior are outside this focused review. No production data, real messages, credentials or provider payloads are contained in this receipt. Maintainer changes after the pinned head are reviewed/tested separately, not claimed as covered by this scan.
