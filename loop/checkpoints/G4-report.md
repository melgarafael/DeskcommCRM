# Checkpoint G4 — Escopo por atendente (RLS) + métricas + hardening — 2026-07-17
Status: COMPLETO

## 1. Entregue nesta fase

| Feature | Título | Commit | Verificação |
|---|---|---|---|
| G4-00 | Hardening: SECURITY DEFINER de escrita sem EXECUTE de anon (INB-07/09) | 0f7505b | gov-verifier PASS 2026-07-17 (re-spawn pós-timeout de API) |
| G4-01 | visibility_mode: RLS de conversas/mensagens por atendente | 122f4f6 | gov-verifier PASS 2026-07-17 (1ª rodada) |
| G4-02 | Inbox com escopo: minhas / fila / todas | b662993 | gov-verifier PASS 2026-07-17 (1ª rodada) |
| G4-03 | Escopo no kanban/leads para agent | bc30259 | gov-verifier PASS 2026-07-17 (1ª rodada) |
| G4-04 | Métricas por responsável (funil + performance individual) | 57c57cc | gov-verifier PASS 2026-07-17 (1ª rodada) |

## 2. Evidências (prova, não afirmação) — gates da fase G4

**Gate "visibility_mode por org aplicado em RLS (conversas/mensagens deixam de ser
flat para agent), com teste 2-tenants + 2-atendentes"** — G4-01 (migration 0035):
`fn_can_view_conversation` (stable security definer, campos da row) governa o SELECT
de conversations + messages (herança via EXISTS na conversa-mãe). Só o role agent é
restrito (own + fila no `own_and_unassigned`); viewer/manager/admin org-wide. Default
`own_and_unassigned` (G1-06a). Verificado com 7 vetores de vazamento (cross-org,
cross-atendente, fila por modo, msg herda escopo, fn anon negada) — todos selados;
`pg_policy` enumerado: conversations tem EXATAMENTE 1 policy SELECT (visibility-aware),
ZERO FOR ALL. Dois achados de causa raiz: (a) `EXISTS` em vez de scalar-subquery (que
devolveria NULL → tratado como fila → vazamento); (b) `fn_conversation_assign` virou
DEFINER porque o SELECT visibility-aware quebrava transfer/release em produção (o
`UPDATE ... RETURNING` re-aplicava a policy à linha nova, de dono invisível ao autor) —
fechado com DEFINER + guard que preserva o INB-06a.

**Gate "Inbox/Kanban respeitam escopo, manager+ vê tudo"** — G4-02 (inbox) + G4-03
(leads). G4-02: visões Minhas/Fila/Todas; a aba "Todas" some pro agent quando
`visibility_mode != all` (cosmético — a RLS é a garantia real, provada por gov-5b:
agent conta 2 (own+fila) vs manager 3 (total), e `?filter=all` forçado não vaza);
contagens via `GET /conversations/counts` com client user-scoped (herda RLS, nunca
admin); URL direta fora do escopo → estado vazio claro, sem stack trace. G4-03
(migration 0036): `fn_can_view_lead` espelha a de conversas (owner_user_id, mesmo
visibility_mode); `crm_leads` FOR ALL dropada e re-expressa por-comando (a mesma
armadilha da G4-01); agent escreve own (drag-and-drop do lead próprio + puxada da fila
no `own_and_unassigned` passam; lead de outro agent = 0 rows; WITH CHECK bloqueia criar
pra outro), manager+ org-wide (bulk assign G3-04 intacto). O lead sem dono espelha a
fila das conversas: own_and_unassigned vê+move; own nem vê nem move (4 números provados).

**Gate "métricas com filtro por responsável + performance individual"** — G4-04
(migration 0037): spec §6 com definições precisas escritas ANTES do código (won/lost
por owner sobre `closed_at`; conversas atendidas por assignee sobre `assigned_at`;
tempo até 1ª resposta = 1ª outbound de HUMANO − 1ª inbound, bot excluído via
`sent_by_user_id`). `fn_attendant_metrics` SECURITY INVOKER — a RLS 0035/0036 é o gate:
agent agrega só as próprias automaticamente, manager+ org-wide + filtro por atendente.
2 índices parciais; EXPLAIN sob role agent E manager (não superuser) prova Index Scan
sem seq scan. Números exatos (gov-8): manager A=[3 won,1 lost,2 conv,90s], B=[1,2,1,30s];
agent A vê só a própria; funil escopo-aware. UI: página Desempenho (funil + tabela por
atendente + filtro), screenshot com dados reais em `evidence/G4/G4-04-metrics-manager.png`.

**Gate extra da fase (aprovado pelo dono): hardening INB-07** — G4-00 (migration 0034):
6 SECURITY DEFINER de escrita (ingestão WhatsApp, eventos, auditoria) estavam
anon-executáveis. Descoberta: 2 origens distintas — grant direto (revoke from anon) e
herança de PUBLIC (revoke from public + re-grant authenticated/service_role). Invariante
prova as 6 → permission denied sob role anon real; service_role/triggers intactos.
Fechou também as 2 notas do INB-09 (bulk assign fail-closed + org do authz).

Estado dos invariantes ao fim da fase: **96 verdes** no Postgres descartável
(install+update do baseline sempre verdes); o `it.fails` GAP(G4) do eixo 5 flipado; 3
novos invariantes de escopo/métrica adicionados (gov-5b inbox counts, gov-5c lead scope,
gov-8 metrics) + gov-hardening-anon-definer. Suíte unit: **165 verdes**.

Screenshots em `loop/checkpoints/evidence/G4/`: G4-02-inbox-scope-{agent,manager},
G4-04-metrics-{manager,agent}. (G4-01/03 são migrations de RLS sem UI nova — sem
screenshot por design, verificado pelos invariantes; G4-04-agent saiu em loading por
uma trava de Docker na captura, com o own-scope provado pelo gov-8.)

## 3. Pendências (cópia auditável da inbox operacional)

Todos **open**, `proposal`/follow-up **não-vetantes** — nenhum bloqueou a fase.

- **INB-03 (G2-01)** — onboarding/whatsapp/session POST sem gate de role (recomendo
  admin por consistência). A nota 2 (bulk-assign ≥manager) já foi resolvida na G3-04.
- **INB-04 (G2-02)** — race no guard de último admin (check-then-write sem lock,
  pré-existente do EPIC-09). Recomendo fechar com constraint/trigger no banco.
- **INB-05 (G2-03)** — spec §4 nota 8 previa api_audit_log SELECT manager+ "em G2",
  mas nenhuma feature cobriu; segue admin-only. Recomendo manter admin-only + corrigir
  a nota (manager já tem as métricas da G4-04; auditoria crua é ferramenta de compliance).
- **INB-08 (G3-03)** — view de lista de leads não existe no app (kanban é a única
  superfície). Escopo de produto: o dono decide se cria a tabela de leads.
- **INB-10 (G4-03)** — crm_lead_activities/crm_lead_links seguem FOR ALL org-flat: a
  timeline/vínculos de um lead invisível ao agent vazariam por consulta DIRETA à API/MCP
  (a UI não expõe hoje). Recomendo estender o escopo own às tabelas-filhas (EXISTS no
  lead-mãe, padrão messages→conversations) — candidato ao pacote de RLS residual.

## 4. Riscos observados na construção

- **RLS residual em tabelas-filhas** (INB-10): activities/links de lead ainda org-flat —
  a G5/G6 (MCP tools) NÃO deve expor esses payloads por lead invisível sem fechar isto.
- **Ambiente de screenshot × migration nova**: features de UI que trazem migration não
  conseguem screenshot contra o Supabase remoto (drift). A solução que ficou como padrão:
  rodar um Supabase LOCAL (isolado) com o baseline. Custo: subir o stack local pressiona
  o Docker do host (travou uma vez na G4-04, recuperado com restart). A **G5-04 também
  exige screenshot** — vale o dono decidir se aplica as migrations no dev remoto (para o
  fluxo ficar barato) ou mantém o caminho local.
- **`enable_seqscan=off` no EXPLAIN** (G4-04): em dataset seed minúsculo é a única forma
  de provar aplicabilidade do índice; não é um EXPLAIN "em tabela grande" real. Aceitável
  para o invariante, mas o comportamento sob volume real só se confirma em produção.
- **`member.role_changed`** no union de audit sem emissor (herança da G2-02, cosmético).
- **Incidentes de infra recorrentes** (API timeout do verifier/implementer): o loop
  recuperou em todos (hash-check + re-spawn / resume do ponto exato). Não afetaram estado.

## 5. O que a PRÓXIMA fase (G5) precisa

- Aprovação deste checkpoint (`loop/checkpoints/G4.approved`).
- Decisões do dono nos INB abertos — nenhuma bloqueia G5-01, mas INB-10 (RLS residual)
  toca o que a G6 (MCP tools) pode expor; vale decidir antes da G6.
- G5 constrói roteamento sobre o escopo da G4: `attendant_availability` (G5-01) e o
  worker de roteamento (G5-02) usam a semântica de assignee/visibility já pronta. A
  decisão G1-06b (modos manual + round_robin) já está na spec §5.
- G5-04 (painel admin) e G5-03 (fila visível) têm UI — planejar o caminho de screenshot
  (ver Risco acima).

## 6. Custo da fase

- 6 sessões do loop (5 features + o checkpoint), 2026-07-17: started 10:23(virada)→15:00.
  Todas com PASS.
- 1 incidente de API timeout no verifier (G4-00, re-spawn fresco), 1 no implementer
  (G4-02, resume automático), 1 no implementer (G4-03, resume do ponto exato) — nenhum
  comprometeu estado (hash-check em todos).
- 4 migrations em tripla (0034 hardening, 0035 conversas, 0036 leads, 0037 métricas),
  todas install+update verdes no Postgres descartável.
- 1 incidente de Docker travado (G4-04 screenshot local), recuperado com restart.
- Zero features bloqueadas. 5 itens de inbox abertos (todos proposal/não-vetantes).
