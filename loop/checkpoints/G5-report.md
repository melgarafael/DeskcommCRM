# Checkpoint G5 — Roteamento (fila, disponibilidade, worker, painel) — 2026-07-18
Status: COMPLETO

## 1. Entregue nesta fase

| Feature | Título | Commit | Verificação |
|---|---|---|---|
| G5-01 | Config de roteamento + disponibilidade/horário por atendente | a777b32 | gov-verifier PASS 2026-07-18 (1ª rodada) |
| G5-02 | Worker de roteamento via event_log | 7cb8686 | gov-verifier PASS 2026-07-18 (1ª rodada, sem findings) |
| G5-03 | Fila visível com posição + notificação de atribuição | 14b4ebd | gov-verifier PASS 2026-07-18 (re-verificado após falso-positivo de hash) |
| G5-04 | Painel admin de gestão de atendentes | 0ae26c0 | gov-verifier PASS 2026-07-18 (1ª rodada, sem findings; resumido após auth-error) |

(A fase abriu com uma sessão de reparo: `aeb2509 fix(main)` — o vitest varria o
worktree aninhado `.claude/worktrees/` do colega; excluído. Ver §4.)

## 2. Evidências (prova, não afirmação) — gates da fase G5

**Gate "config de roteamento por org + disponibilidade/horário por atendente"** —
G5-01 (migration 0039): `attendant_availability` (is_available, capacity,
schedule jsonb tz-aware, last_heartbeat_at) com RLS por-comando (SELECT org-wide;
write own-OU-manager; sem FOR ALL). `organizations.settings.routing` via Zod
(modos manual|round_robin, default manual; knobs max_retries/backoff_seconds como
config, nunca hardcoded). Elegibilidade em TS puro (`isAttendantEligible` =
disponível ∧ dentro do horário ∧ abaixo da capacidade), clock injetável.

**Gate "worker de distribuição via event_log (trigger nunca faz HTTP)"** — G5-02
(migration 0040): trigger AFTER INSERT emite `conversation.routing_requested` só
quando a conversa NASCE sem dono (WHEN assigned_to_user_id IS NULL AND status IN
open/pending). **Anti-eco POR CONSTRUÇÃO**: não há trigger de UPDATE, então o
próprio assign do worker não pode re-emitir — invariante prova count=1 após 2
assigns. Worker consome com claim (event_log status pending→processing→done/dead),
atribui via `fn_conversation_assign(reason='routing')` atômico (reuse G3-01);
idempotência do optimistic-lock (replay → 0 rows, não reatribui); sem elegível →
backoff da config + attempts++; manual → no-op.

**Gate "fila visível com posição"** — G5-03: fila ordenada por tempo de espera
(`last_inbound_at ASC`, fonte ÚNICA, tiebreak `id ASC`) com posição + "Aguardando
há X"; contagem = counts.unassigned (mesmo predicado). Coerência ordem↔posição
provada (3 conversas 30/10/2min → mais antiga = posição 1). Notificação de
atribuição = badge unread + realtime (fallback explícito do acceptance — não há
sistema de notificação no repo; decisão na spec §5, sem over-engineering). unread
zerado na atribuição via worker testado (7→0).

**Gate "painel admin de gestão de atendentes operante"** — G5-04: aba
"Atendimento" em app/app/team — roster agent+ com **status honesto** (isHeartbeatStale:
online-mas-stale >15min mostrado offline), carga atual (fonte única OPEN_LOAD_STATUSES
compartilhada com o worker), capacidade/horário editáveis inline (manager+), card
de modo de roteamento (manual|round_robin; 'load' desabilitado "em breve" — nunca
enviado à API) persistindo via /settings/routing. Teste config→worker (4/4): mudar
modo/capacidade/backoff reflete no comportamento do worker. Screenshot em
`evidence/G5/G5-04-attendants.png` (Bruno online-mas-stale exibido offline — vitrine
do status honesto).

Invariantes ao fim da fase: **112 verdes** no Postgres descartável (install+update
sempre verdes); flip do gov-4 (attendant_availability existe); 2 invariantes novos
(gov-4b worker, gov-5d fila/unread). Suíte unit: **192 verdes** (inclui
config-worker 4/4, eligibility 13, decide 10).

Screenshots em `evidence/G5/`: G5-03-queue, G5-04-attendants.
(G5-01/02 são schema/worker sem UI nova — verificados por invariantes, sem screenshot.)

## 3. Pendências (cópia auditável da inbox operacional)

Todos **open**, `proposal`/follow-up **não-vetantes**. Herdados de fases anteriores
(G2-G4) + os desta fase (G5). Decisão do dono no checkpoint.

- **INB-03 (G2-01)** — onboarding/whatsapp/session POST sem gate de role. Recomendo admin.
- **INB-04 (G2-02)** — race no guard de último admin (check-then-write). Recomendo constraint/trigger.
- **INB-05 (G2-03)** — api_audit_log SELECT segue admin-only. Recomendo manter + corrigir a nota da spec.
- **INB-08 (G3-03)** — view de lista de leads não existe (kanban é a superfície). Escopo de produto.
- **INB-10 (G4-03)** — crm_lead_activities/links org-flat (timeline de lead invisível vaza por query direta). **Pré-condição de exposição na G6** (MCP não deve expor payload de lead invisível).
- **INB-11 (G5-01)** — bloco attendant_availability duplicado no baseline.sql (idempotente, inócuo). Dedup em forward-fix.
- **INB-12 (G5-02)** — dois round-robins divergentes (worker decide.ts vs handoff). Unificar na G6-01.
- **INB-13 (G5-02)** — BUG pré-existente do agent-dispatcher: grava status processed/failed inválido no event_log_status_check → UPDATE viola constraint em runtime. Forward-fix TS (processed→done, failed→dead). **Bug real de runtime** — recomendo priorizar.
- **INB-14 (G5-04)** — RLS de user_organizations limita manager a ver só a própria linha via /team (a aba Membros mostra só ele pro manager). A G5-04 contornou com endpoint próprio. Recomendo RLS org-wide a manager+ (matriz §4 dá team=org:read a manager).

## 4. Riscos observados na construção

- **Worktree compartilhado do colega** (o maior risco operacional da fase): o
  trabalho do Vendaval/webhooks apareceu NESTE checkout (`.claude/worktrees/`,
  `app/page.tsx`, `graphify-out/`) em vez de isolado. Consequências reais: (1) o
  vitest varreu 5218 testes do worktree (sessão de reparo aeb2509 pra excluir);
  (2) o hash-check da G5-03 tripou por FALSO-POSITIVO (app/page.tsx mudou durante
  a verificação — re-verificado, §3 aplicado); (3) NNNN 0038 colidido (usei 0039).
  Mitigação: `git add` por caminho explícito protege os commits; o Maestro isolou
  o worktree. **Recomendação: manter o trabalho de outros terminais FORA deste
  checkout** (worktrees siblings, não aninhados).
- **Higiene de disco** (resolvido): volumes Docker dangling dos test:db acumulados
  travaram o loop 2x (disco 100%). `docker volume prune` recuperou 28GB. Padrão
  adotado: prune no teardown de cada sessão que sobe banco. Recomendação ao dono:
  prune automático no teardown do harness.
- **INB-13 (bug de runtime do agent-dispatcher)**: status inválido no event_log
  — o dispatcher de IA pode estar re-processando eventos. Fora do épico, mas real.
- **INB-10 (RLS residual)**: pré-condição da G6 (exposição MCP).

## 5. O que a PRÓXIMA fase (G6) precisa

- Aprovação deste checkpoint (`loop/checkpoints/G5.approved`).
- **INB-10 é pré-condição da G6** (o dono já concordou): a timeline/vínculos de
  lead ainda org-flat — a G6 (MCP tools + spec 14 pro Vendaval) NÃO deve expor
  payload de lead invisível sem fechar isto. Decidir antes da G6-03 (tools de leitura).
- **INB-12** (unificar round-robins) é candidato natural à G6-01 (crm_request_human_handoff v2).
- G6 é a última fase: MCP tools de governança (assign/tags/queue), ai_dispatch_mode,
  tools de leitura expondo assignee/tags/queue, e a **spec 14** (o contrato que a
  fase FG do Vendaval consome — o `.approved` da G6 é o gatilho dela).

## 6. Custo da fase

- 6 sessões (1 reparo de smoke + 4 features + o checkpoint), 2026-07-17→18.
- Incidentes recuperados sem perda de estado: reparo de smoke (worktree poluindo
  vitest); disco 100% 2x (volume prune, 28GB); hash false-positive G5-03
  (re-verify); implementer morto 2x (G5-03 API timeout, G5-04 auth-error — ambos
  resumidos do ponto exato); Docker travado (restart). O loop recuperou de todos.
- 2 migrations em tripla (0039 availability, 0040 routing-emit), install+update verdes.
- Zero features bloqueadas. 9 itens de inbox abertos (todos proposal/não-vetantes).
