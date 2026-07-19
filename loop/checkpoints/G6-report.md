# Checkpoint G6 — Contrato externo MCP + hardening (a fase final do épico) — 2026-07-18
Status: COMPLETO

> **O `.approved` desta fase é o gatilho da fase FG do Vendaval.** Aprovar a G6
> fecha o épico de Governança de Atendimento (G1→G6) inteiro.

## 1. Entregue nesta fase

| Feature | Título | Commit | Verificação |
|---|---|---|---|
| G6-00 | Pré-G6: RLS por role em crm_lead_activities/links (INB-10) | f121724 | gov-verifier PASS 2026-07-18 (1ª rodada) |
| G6-05 | Forward-fix: agent-dispatcher status inválido no event_log (INB-13) | 3d68c4d | gov-verifier PASS 2026-07-18 (1ª rodada) |
| G6-06 | RLS de user_organizations: SELECT org-wide para manager+ (INB-14) | ee908ed | gov-verifier PASS 2026-07-18 (1ª rodada) |
| G6-01 | MCP tools de governança (assign/tags/queue + handoff v2) | d60c068 | gov-verifier PASS 2026-07-18 (re-verificado após falso-positivo de hash externo) |
| G6-02 | ai_dispatch_mode respeitado pelo dispatcher nativo | 80664d4 | gov-verifier PASS 2026-07-18 (1ª rodada) |
| G6-03 | Tools de leitura expõem governança | ddcc511 | gov-verifier PASS 2026-07-18 (1ª rodada) |
| G6-04 | Contrato de governança para agentes externos (spec 14) | f25cd3e | gov-verifier PASS 2026-07-18 (1ª rodada) |

3 mini-features de correção (G6-00/05/06 — os INB-10/13/14 que o dono aprovou),
depois o núcleo MCP (G6-01/02/03) e o contrato (G6-04).

## 2. Evidências (prova, não afirmação) — gates da fase G6

**Gate "MCP tools de governança + handoff ciente de fila/horário"** — G6-01: 3 tools
novas (crm_assign_conversation com idempotência sob CORRIDA provada evento=1 e
não-clobber de transfer concorrente; crm_manage_tags conv|contact|lead com o
normalizador da G3-05; crm_get_queue_status read-only documentado), todas no
catalog.ts (sanity 1:1) + audit em toda escrita. Handoff v2 usa o roteamento G5
(target opcional, fallback fila+posição, retorno estruturado). **INB-12 fechado**:
os dois round-robins divergentes unificados — `loadEligibleAttendants` extraído,
compartilhado por worker+handoff+queue, um algoritmo só.

**Gate "ai_dispatch_mode respeitado pelo dispatcher"** — G6-02: auditoria provou a
flag AUSENTE em código (só docs/plano). Implementada em organizations.settings jsonb
(Zod enum native|external, `.catch('native')` fail-safe duplo). O dispatcher pula
org 'external' ANTES do claim (continue puro — status='pending', consumed_by intacto)
→ o Vendaval consome. skipped_external é o único skip não-consumidor. Native inalterado.

**Gate "tools de leitura expõem assignee/tags/stage/queue"** — G6-03: as 4 read
tools ganham campos aditivos (assignee_kind, assigned_to_user_name, tags,
queue_position / owner_user_name, stage, tags), teste de shape provando que
consumidores atuais não quebram. queue_position usa a MESMA ordenação da fila do
inbox (G5-03), com teste de coerência tool↔inbox. LGPD: só id+nome, zero email/phone.

**Gate "spec 14 publicada com refs arquivo:linha verificadas"** — G6-04:
`docs/specs/14-contrato-governanca-agentes-externos.md` (estilo edge-contract,
cabeçalho "Verificado em 2026-07-18 contra gov/G6 @ ddcc511"). Documenta as 8 tools
de governança com I/O exatos dos schemas reais, assignee_kind, handoff, visibility_mode
+ o que o agente externo lê, ai_dispatch_mode, e as proibições (cross-org,
is_blocked, force_human, bot_silenced_until — 4 mecanismos distintos). Seção
"mudanças requeridas em consumidores" = insumo do FG-01. Cobertura BIDIRECIONAL
verificada (TOOL_CATALOG=16, as 8 de governança todas na spec, nenhuma omitida);
~20 refs arquivo:linha abertas e conferidas 1 a 1.

**Pré-condições fechadas (as 3 mini-features do dono):**
- G6-00 (migration 0042): activities/links de lead só visíveis a quem vê o lead
  (EXISTS + fn_can_view_lead), FOR ALL de links dropada — pré-condição da G6-03
  (o MCP não expõe payload de lead invisível). Write org-scope preservado (a
  timeline polimórfica escrita por service role/IA não quebrou).
- G6-05: dispatcher gravava status inválido no event_log (violava a constraint em
  runtime, evento preso em pending). Corrigido (processed→done, failed→dead), com
  invariante provando a violação com os valores antigos.
- G6-06 (migration 0044): manager voltou a ler a equipe inteira (era só a própria
  linha). fn_role_at_least SECURITY DEFINER — sem recursão. Write inalterado.

Invariantes ao fim da fase: suíte unit **282 verdes**; test:db verde (install+update);
novos invariantes gov-5e (lead children), dispatcher-event-status, gov-1b (team
manager read) + as suítes MCP (governance, read-governance). 3 migrations em tripla
(0042, 0044) + a spec 14.

## 3. Pendências (cópia auditável da inbox operacional)

Todos **open**, `proposal`/follow-up **não-vetantes** — nenhum bloqueou a fase.
Os que a fase G6 ENDEREÇOU (INB-10/12/13/14) já estão fechados.

- **INB-03 (G2-01)** — onboarding/whatsapp/session POST sem gate de role. Recomendo admin.
- **INB-04 (G2-02)** — race no guard de último admin (check-then-write). Recomendo constraint.
- **INB-05 (G2-03)** — api_audit_log SELECT segue admin-only. Recomendo manter + corrigir a nota da spec.
- **INB-08 (G3-03)** — view de lista de leads não existe (kanban é a superfície). Escopo de produto.
- **INB-11 (G5-01)** — bloco attendant_availability duplicado no baseline (idempotente, inócuo). Dedup em forward-fix.
- **INB-15 (G6-05)** — test:db colide entre terminais (porta/nome fixos em test-db.sh). Sufixo por PID resolve. Recomendo (deixa o loop confiável com 2+ terminais).
- **INB-16 (G6-04)** — console.error em messages.ts:110 (anti-pattern 14, pré-existente). Forward-fix TS trivial.

## 4. Riscos observados na construção

- **Worktree compartilhado** (o maior atrito da fase): o trabalho do Vendaval/webhooks
  ficou NESTE checkout (.claude/worktrees/, app/page.tsx, graphify-out/, AGENTS.md/
  GEMINI.md que regeneram). Causou: sessão de reparo do vitest (fase G5), 2
  falso-positivos de hash-check (G5-03, G6-01), colisões de NNNN (usei 0039/0042/0044
  contornando 0038/0041/0043 do colega), colisão de porta no test:db (INB-15), e um
  hook PreToolUse `graphify` de outro terminal que injeta a cada comando (ignorado
  por doutrina — ferramenta de outro orquestrador). **Mitigado**: o Maestro adicionou
  os arquivos regeneráveis ao `.git/info/exclude` (hash estável daí em diante) e `git
  add` por caminho explícito protegeu todos os commits. **Recomendação: o trabalho de
  outros terminais deve ficar FORA deste checkout** (worktrees siblings).
- **INB-15** (colisão de test:db) merece o forward-fix pra o loop rodar confiável com
  o time compartilhando a máquina.
- **Higiene de disco/Docker**: resolvida na G5 (volume prune) e mantida (prune no
  teardown). O `Docker.raw` de 51G segue como risco de médio prazo (decisão do dono).

## 5. O que a PRÓXIMA fase (FG do Vendaval) precisa

- **Aprovação deste checkpoint (`loop/checkpoints/G6.approved`) — que É o gatilho da FG.**
- A spec 14 (`docs/specs/14-contrato-governanca-agentes-externos.md`) é o insumo
  direto do FG-01: a seção §7 lista o que o Vendaval faz do lado dele (setar
  ai_dispatch_mode='external', consumir event_log pending, handoff v2, respeitar as
  proibições).
- Decisões do dono nos 7 INB abertos — nenhum bloqueia a FG, mas INB-15 (test:db)
  e INB-16 (console.error) são forward-fixes baratos; INB-04 (race do último admin)
  é o de maior valor de robustez.

## 6. Custo da fase / do épico

- **Fase G6**: 8 sessões (7 features + o checkpoint), 2026-07-18. Todas com PASS.
  1 rodada de reparo (nenhuma — todas as 7 passaram na 1ª; a G6-01 teve re-verificação
  por falso-positivo de hash externo, não por finding). 3 migrations em tripla.
- **Épico inteiro (G1→G6)**: 6 fases, ~30+ features, todas por maker≠checker sob
  hash-check. Provas de valor: um vazamento de dados cross-tenant pego e fechado
  dentro do loop (G3-02); 3 achados de segurança/bug do próprio loop virando features
  aprovadas pelo dono (INB-07→G4-00, INB-10→G6-00, INB-13→G6-05, INB-14→G6-06); o
  isolamento por atendente inteiro (G4); o roteamento completo (G5); e o contrato
  externo (G6) que destrava o Vendaval. Recuperação de ~8 incidentes de infra sem
  perder um commit (sessões descartáveis, estado durável no disco).
