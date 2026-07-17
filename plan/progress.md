# Progress — gov-loop (DeskcommCRM · Governança de Atendimento)

> Diário de bordo append-only. Cada sessão do loop fecha com 3-5 linhas aqui:
> o que fez, evidência observada (output real, não intenção), o que ficou.

## 2026-07-16 — setup do loop (sessão humana, fora do loop)

- Máquina do gov-loop instalada (portada do vendaval-loop) na branch `gov/setup`
  a partir de `main`, em worktree isolado — checkout principal (cadeia
  `vendaval/F2-*`) intocado.
- Backlog criado: 27 features em 6 fases (G1 provas → G6 contrato externo),
  derivado de 7 eixos de feedbacks reais do sistema-modelo (abstraídos, zero PII)
  + recon do código real (baseline.sql, specs 04/05, MCP tools).
- Spec 13 (esqueleto) criada; apêndices A/B e §3-§5 são entregues por G1-03/04/05.
- Próximo: dono revisa `gov/setup`, mergeia em `main`, e o loop abre G1
  (`/deskcomm-gov-loop`). G1-06 é human_input — as 5 decisões de produto.

## 2026-07-16 — sessão 1 do loop (core) — REPARO DE MAIN

- Smoke de entrada vermelho: `pnpm typecheck` com 12 erros TS, todos em
  `loop/update-feature.ts` (a própria máquina do loop, do setup de ontem).
  Sessão virou reparo (§1.8): gov-implementer tipou o script (interfaces
  Feature/Plan, guard de flags, `fail(): never`) sem mudar comportamento CLI;
  zero any/@ts-ignore; anotações erasable (node 22 type-stripping segue rodando).
- gov-verifier: PASS (hash-check OK). Provou round-trip de campos desconhecidos
  do features.json na reescrita e validações falhando ANTES de escrever.
- Desvio registrado no §0.6: chão de entrada tinha 15 untracked do dono
  (screenshots, AGENTS.md etc.) + `.lina/`. Stashados como "orphan
  2026-07-16T18:43:17-0300" — EXCETO `.lina/` (estado vivo do Lina Space;
  stashar derrubaria o app do dono). `.lina/` permanece untracked no chão.
- Próxima sessão: main verde; G1-01 (gate de CI) é a elegível de menor priority.

## 2026-07-16 — sessão 2 do loop (core) — G1-01

- G1-01 (gate de CI): `gov:verify` no package.json (cadeia `&&`, exit!=0 provado
  com script análogo) + `.github/workflows/ci.yml` novo (pull_request sem filtro
  de branch — de propósito, PRs gov/* precisam do gate; push só main; pnpm 9 +
  node 20 byte-idênticos a perf.yml). Sem envs: os 3 comandos não fazem build Next.
- gov-verifier: PASS, hash-check OK (tree intacto antes/depois da verificação).
- Convenção registrada: `verification.commit="self"` = o próprio commit atômico
  da sessão (auto-referência de sha é impossível pré-commit; audite por
  `git log --grep '<ID>'`). Primeira gravação do update-feature.ts normalizou a
  formatação do features.json (reformat único previsto no header do script).
- Chão de entrada: AGENTS.md/GEMINI.md reapareceram (app externo regenera);
  stashados como "orphan 2026-07-16T18:54:42-0300". `.lina/` segue intocado no chão.
- Próxima sessão: G1-02 (Postgres descartável + isolamento 2-tenants) é a elegível.

## 2026-07-16 — sessão 3 do loop (core) — G1-02

- G1-02 (Postgres descartável + isolamento 2-tenants): `pnpm test:db` sobe
  pgvector:pg17 efêmero (porta 127.0.0.1:54329, --rm, trap EXIT), aplica prelude
  de stubs Supabase (roles, auth.uid() via request.jwt.claims, storage.*) + 
  baseline install (ON_ERROR_STOP=1) + update, e roda 9 testes RLS via
  `docker exec psql` — zero devDependency nova.
- gov-verifier: PASS com probes independentes (UPDATE cross-org → 0 rows;
  authenticated sem claims → nada vaza; SIGINT → teardown ok). Hash-check OK.
- Sessão rodada pelo watchdog (Maestro): terminal Arquiteto ficou Idle após
  G1-01 e a cooperação A2A do Espaço está pausada — continuidade assumida aqui.
- Nota pra fase futura: create policy do apêndice do baseline (0014/0017) não é
  idempotente ("already exists" tolerado no update) — melhoria possível, não bug.
- Próxima sessão: G1-03 (suíte de invariantes dos 7 eixos) ou G1-04 (auditoria
  de gap, sem deps) — G1-03 tem priority menor (30 < 40).

## 2026-07-16 — sessão 4 do loop (core) — G1-03

- G1-03 (suíte de invariantes dos 7 eixos): 8 arquivos em tests/invariants/
  (gov-helpers + gov-1..7), 29 testes no total — 22 verdes + 7 catracas it.fails
  com GAP(Gx). `pnpm test:invariants` = alias do harness test-db.
- Desvio aceito pelo verifier: gap-exemplo "role não editável via API" JÁ estava
  fechado (rota do EPIC-09 em app/api/v1/team/[user_id]/role) → virou invariante
  verde; gaps RBAC reais de G2: pipeline write por agent, conversations write
  por viewer. Catraca provada em probe (it.fails de assert válido → suíte RED).
- gov-verifier: PASS, hash-check OK. Apêndice A da spec 13 preenchido (20 linhas).
- Próxima sessão: G1-04 (auditoria de gap specs 04/05 vs código — sem deps).

## 2026-07-16 — sessão 5 do loop (core) — G1-04

- G1-04 (auditoria specs 04/05 vs código): Apêndice B da spec 13 preenchido —
  20 itens (9 implementado / 5 parcial / 6 ausente), toda linha com arquivo:linha
  conferida pelo verifier (20/20). Claim atômico e handoff §7.5 são reais;
  ReassignDialog, AttendantStatusToggle e supervisor read-only ausentes.
- INB-01 aberto na inbox (proposal): supervisor read-only §10 sem feature G* e
  conflitando com a matriz spec 13 §4 (manager org:write) — decisão do dono.
- Nota do verifier p/ sessão futura: linha "supervisor §10" cita
  conversations/[id]/messages/route.ts:38 mas o POST real é
  app/api/v1/messages/route.ts — ponteiro impreciso, conclusão correta.
- gov-verifier: PASS, hash-check OK (tree + inbox).
- Próxima sessão: G1-05 (modelo de dados alvo + matriz role×recurso, deps G1-04 ✓).

## 2026-07-16 — sessão 6 do loop (core) — G1-05

- G1-05 (modelo de dados alvo + matriz role×recurso): spec 13 §3 com DDL
  rascunho das 5 estruturas (assignment_events, assignee_kind, conversation
  tags, attendant_availability, settings.routing/visibility_mode), cada uma
  com DIRC; §4 com matriz 11 recursos × 4 roles.
- 7 células PENDENTE G1-06 + 1 PENDENTE INB-01 (manager×conversations write —
  conflito supervisor read-only). Nenhuma decisão de produto inventada
  (verifier varreu célula a célula). Refs baseline.sql:linha 8/8 exatas.
- Nota do verifier p/ G1-06: linha 191 usa "decisão G1-06b" em vez do literal
  "PENDENTE G1-06" — incluir o default de roteamento ao fechar os pendentes.
- gov-verifier: PASS, hash-check OK.
- Próximo: G1-06 é human_input (única pendente da fase) → sessão seguinte abre
  o item de inbox com as 5 perguntas e emite checkpoint G1 INCOMPLETO (§5).

## 2026-07-16 — sessão 7 do loop (core) — checkpoint G1

- G1-06 é human_input (única pendente da fase): INB-02 aberto na inbox com as
  5 perguntas (a)-(e), opções e recomendação do loop em cada uma.
- Checkpoint G1 emitido: loop/checkpoints/G1-report.md, Status INCOMPLETO —
  bloqueado (aguarda respostas INB-02/INB-01 + G1.approved do dono).
- Loop PARADO aguardando aprovação (guarda de entrada nº 2 segura as próximas
  sessões). Próximo passo é do dono: responder inbox e aprovar/recusar o checkpoint.

## 2026-07-16 — sessão 8 do loop (core) — G1-06 (human_input aplicado)

- Dono respondeu INB-02 via chat ao Maestro: (a)=B suas+fila, (b)=B
  manual+round-robin, (c)=A reusa role agent, (d)=A transferência imediata,
  (e)=A manager vê métricas individuais. INB-01: descartar supervisor §10.
- Decisões transcritas na spec 13 (§3.5 defaults, §4 matriz 0 PENDENTEs, §5
  roteamento; derivações conservadoras anotadas: settings/billing manager =
  admin-only, default mode=manual). gov-verifier: PASS (fidelidade célula a
  célula), hash-check OK. INB-01/02 fechados.
- Dono autorizou (AskUserQuestion): criar G1.approved em nome dele + virada de
  fase por merge+push direto (opção A). Executando na sequência.

## 2026-07-16 — virada de fase G1 → main (21:52)

- gov/G1 mergeada em main (--no-ff, 6ddc08f) e pushada para origin (opção A,
  confirmada 2x pelo dono via AskUserQuestion). Branch gov/G2 criada de main.
- Loop segue na fase G2; primeira elegível: G2-01 (matriz role×endpoint
  server-side). CI do GitHub agora tem o ci.yml — primeira execução real no push.

## 2026-07-16 — sessão 9 do loop (core) — G2-01 (fase G2 aberta)

- Virada G1→main executada (merge 6ddc08f + push, opção A do dono); gov/G2 criada.
- G2-01 (matriz role×endpoint server-side): helper único lib/auth/require-role.ts
  (getUser + fn_user_role_in_org + fail 403 + audit authz.denied), ~47 rotas
  gateadas conforme matriz spec 13 §4; 21 testes novos (115 unit no total).
- Rodada 1 do verifier: FAIL (lgpd/anonymize checava role na mão, sem audit).
  Reparo: helper ganhou opt organizationId (role na org do RECURSO, fail-closed);
  rota migrada. Rodada 2: PASS, hash-check OK.
- Invariantes GAP(G2) de gov-1-rbac NÃO flipados (são de RLS — G2-03 fecha);
  decisão validada pelos 2 verifiers.
- INB-03 aberto (follow-ups: onboarding/whatsapp/session sem gate de role;
  nota pro bulk-assign ≥manager na G3-04).
- Handoff: próximas sessões (G2-02+) delegadas ao terminal Arquiteto e Executor
  (cooperação A2A retomada pelo dono); Maestro-DeskcommCRM vira watchdog.

## 2026-07-16 — sessão 10 do loop (core) — G2-02

- G2-02 (role editável): lógica única em team/[user_id]/_shared.ts; PATCH
  canônico novo em [user_id]/route.ts; /role virou alias fino (export PATCH
  preservado — invariante gov-1-rbac o checa). Audit: team.role_changed
  APPENDADO ao union (member.role_changed fica sem emissor, doutrina append-only).
- UI: Select inline por membro (admin only, nunca na própria linha), otimismo
  react-query com rollback + toast; dialog antigo removido. Screenshot em
  loop/checkpoints/evidence/G2/G2-02-team-role-selector.png.
- vitest.config.ts: esbuild jsx automatic (primeiro teste de componente .tsx).
- gov-verifier: PASS 1ª rodada, hash-check OK. 123 unit + 29 invariantes verdes.
  Nota não-veto registrada: guard de último admin é check-then-write sem lock
  (pré-existente do EPIC-09, race de ms entre 2 admins) — candidata a inbox se
  o dono quiser fechar com constraint/trigger.
- Próxima sessão: G2-03 (RLS por role nas tabelas de config — migration tripla).

## 2026-07-16 — sessão 11 do loop (core) — G2-03

- G2-03 (RLS por role): migration 0030 em tripla (migrations/ + apêndice
  baseline + MANIFEST; types.ts intocado — policies não mudam contrato).
  crm_pipelines/crm_stages: SELECT org-flat + write manager+; conversations:
  SELECT byte-idêntico ao antigo (leitura NÃO estreitada — own-scope é G4-01)
  + write agent+ (viewer read-only). Policies ALL antigas dropadas (sem OR órfão).
- Flip da catraca: 2 it.fails GAP(G2) de gov-1-rbac viraram testes normais
  (única mudança no arquivo; commit com DESKCOMM_GOV_INVARIANTS_EDIT=1).
  Novo invariante gov-1-rbac-config-write.test.ts (positivos+negativos).
- Auditoria de policies registrada como spec 13 §4.1; Apêndice A: 2 GAP G2 → passa.
- gov-verifier: PASS 1ª rodada, hash-check OK. test:db install+update verdes,
  35/35 invariantes pós-update, 123 unit.
- INB-05 aberto (proposal): spec 13 §4 nota 8 prevê api_audit_log SELECT
  manager+ "aplicada em G2", mas nenhuma feature G2 cobre — decisão do dono.
- Próxima sessão: G2-04 (e2e Playwright de papéis) fecha a fase → checkpoint G2.

## 2026-07-16 — sessão 12 do loop (core) — G2-04 (fase G2 completa)

- G2-04 (e2e de papéis): rbac-roles.spec.ts com 4 testes (agent 403 em
  api-tokens/billing; admin entra com login MFA TOTP REAL — utils/totp.ts RFC
  6238 sem dependência nova; agent vê inbox/kanban; viewer 403 forbidden_role
  no POST de mensagem). Seed estendido: +viewer +ensureAdminTotp idempotente.
- Desvio aprovado pelo verifier: billing/page.tsx ganhou gate admin-only de 6
  linhas (espelho de api-tokens) — página não tinha gate NENHUM e o acceptance
  seria falso sem ele.
- e2e: 12 passed / 1 failed — o vermelho é error-pages "/500", PRÉ-EXISTENTE
  (rota app/500 nunca existiu, vem do EPIC-12; provado independente do diff).
  Candidato a forward-fix fora do épico. Axe zerado nas telas tocadas (exclusão
  única documentada: tablist do InboxFilters, violação pré-existente).
- gov-verifier: PASS 1ª rodada, hash-check OK. 123 unit verdes.
- Incidente sem perda registrado: implementer consumiu stash órfão 18:54
  (AGENTS/GEMINI idênticos aos do disco); órfão 18:43 intacto.
- FASE G2 COMPLETA (4/4 passes:true) → checkpoint G2 na sequência, loop PARA.
- Checkpoint G2 emitido (loop/checkpoints/G2-report.md, COMPLETO), loop PARADO
  aguardando aprovação do dono (G2.approved) ou recusa (.rejected).

## 2026-07-17 — sessão 13 do loop (core) — G3-01 (fase G3 aberta)

- G3-01 (assignment events): migration 0031 em tripla cria
  conversation_assignment_events (append-only, RLS org) + fn_conversation_assign
  (SECURITY INVOKER, FOR UPDATE + UPDATE condicional + INSERT no mesmo corpo —
  atomicidade real; changed_by=auth.uid() anti-spoof). claim/release migrados
  pro rpc preservando 409; transfer novo (imediato, G1-06d) + ReassignDialog
  (screenshot em evidence/G3/). database.types.ts regenerado DE VERDADE (estava
  defasado desde ~0021; regen trouxe ai_* de carona — typecheck 0).
- Desvio aprovado pelo verifier: GET /api/v1/team/assignable (agent lista
  destinos, só user_id/nome/role, sem PII) — sem isso não há dialog.
- Flip: único it.fails GAP(G3) de gov-3-transfer ("tabela existe") → verde.
  +5 invariantes novos (gov-3-assignment-events), +7 unit. 40 invariantes,
  130 unit, tudo verde. gov-verifier: PASS 1ª rodada, hash OK.
- INB-06 aberto: (a) fn aceita p_to_user_id sem validar membership (rota valida;
  banco não — probe H8); (b) banco live do dev sem 0030 aplicada
  (schema_migrations parou na 0027; 0031 aplicada só pro screenshot).
- Próxima sessão: G3-02 (assignee_kind) destravou; G3-03 também elegível — a
  regra manda menor priority ⇒ G3-02 (prio 20).

## 2026-07-17 — sessão 14 do loop (core) — G3-02 (1 rodada de reparo)

- G3-02 (assignee_kind): migration 0032 em tripla — coluna assignee_kind +
  CHECK de coerência (forma de implicação, verbatim do acceptance) + backfill
  antes da constraint. Handoff grava evento reason=handoff (kind ai→user com
  elegível / fila sem elegível). Veto determinístico do bot no ai-response-worker
  (kind='user' ⇒ skip 'assigned_to_human'). Forward-fix INB-06a: guard de
  membership dentro de fn_conversation_assign via helper fn_member_role_in_org.
- FAIL na 1ª verificação: fn_member_role_in_org (SECURITY DEFINER) executável
  por anon (grant herdado de ALTER DEFAULT PRIVILEGES do baseline) + ramo
  auth.uid() null respondia a request anônimo → enumeração de role cross-tenant
  sem autenticar. Reparo (1 rodada): revoke execute from anon explícito nas 2
  cópias (migration+baseline) + invariante que prova permission denied SOB role
  anon real + service_role ainda servido. Re-verificação FRESCA: PASS, hash OK.
- 47 invariantes + 135 unit verdes. database.types.ts editado à mão (gen do
  container poluiria Functions com extensões).
- INB-07 aberto: varredura do verifier achou 6 SECURITY DEFINER de ESCRITA
  anon-executáveis pré-existentes (fn_upsert_wa_*, emit_event, fn_log_event,
  fn_audit_log_row, fn_mark_conversation_message) — gap do baseline, não da
  G3-02. Os helpers RLS caller-scoped (fn_user_*) NÃO vazam (probe: anon → null).
- Próxima sessão: G3-03 (dono do lead no kanban, prio 30) — elegível.

## 2026-07-17 — sessão 15 do loop (core) — G3-03

- G3-03 (dono do lead na superfície): OwnerBadge novo (nome real + iniciais do
  NOME, badge tracejada "Sem responsável"; tokens do design, zero hardcode).
  Filtro por owner migrou pra query param (deep-link ?owner=…); reatribuir pelo
  card via submenu → useEditLead → PATCH /api/v1/leads/[id]. Reuso: nome do owner
  e seletor vêm de useAssignableMembers (/team/assignable da G3-01); realtime é o
  useRealtimeChannel que o board JÁ tinha (nada novo). Sem migration (owner_user_id
  já existia). 139 unit + 1 e2e do filtro verdes. gov-verifier PASS 1ª rodada, hash OK.
- Achado registrado (não é gap de código): NÃO existe view de "lista de leads"
  separada — o kanban é a única superfície de leads. O acceptance 2 fala em
  "coluna na lista" mas não há lista; atendido só pelo board por ausência de
  superfície (verifier confirmou buscando). Se o dono quiser a lista, é feature nova.
- Próxima sessão: G3-04 (bulk assign, prio 40) destravou; ou G3-05 (tags, prio 50).
  Menor priority ⇒ G3-04.

## 2026-07-17 — sessão 16 do loop (core) — G3-04

- G3-04 (bulk assign): diff cirúrgico só no path assign da rota /leads/bulk
  (já existia move/assign/tag/delete). Gate ≥manager POR-ACTION (2º requireRole
  só se action=assign → authz.denied automático; move/tag/delete de agent
  intactos); validação de owner membro agent+ da org → 422 invalid_owner
  (código novo em errors.ts; mesma classe do INB-06a); audit agregada
  leads.bulk_assigned (append no union); toast com contagem. Limite mantido em
  50 (AT-06 compartilhado; Maestro aprovou não subir). Sem migration.
- 145 unit (6 novos) verdes; gov-verifier PASS 1ª rodada, hash OK.
- INB-09 aberto (2 notas não-vetantes do verifier): (1) validação de owner
  gateada por isServiceRoleConfigured() — se service role ausente, pula (bypass
  condicional; prod sempre tem); (2) edge multi-org: owner validado na org ativa
  vs org do UPDATE resolvida do 1º lead — ator em 2 orgs poderia cruzar (não
  vaza, RLS segura; padrão pré-existente da rota).
- Fase G3: 4/5. Falta só G3-05 (tags de conversa, prio 50) → fecha a fase.

## 2026-07-17 — sessão 17 do loop (core) — G3-05 (fase G3 COMPLETA)

- G3-05 (tags de conversa): migration 0033 tripla — conversations.tags text[]
  +GIN + seed idempotente do vocabulário canônico em
  organizations.settings.canonical_conversation_tags (não sobrescreve tenant).
  PATCH de conversa estendido (patchConversationSchema, status e/ou tags) com
  Zod normalizador (trim/lowercase/dedup, ≤20, ≤40) + audit conversation.tags_changed.
  UI: ConversationTagsEditor (chips + sugestões canônicas) no side panel + filtro
  por tag no inbox. Vocabulário via server route (cookie HttpOnly — browser client
  não autentica, mesmo motivo do board). types à mão (precedente G3-02).
- Flip do it.fails do eixo 7 + invariante de filtro org-scoped (org1=1, org2=1,
  global≥2, não vaza). gov-verifier PASS 1ª rodada, hash OK. 154 unit + 48 invariantes.
- FASE G3 COMPLETA (5/5 passes:true) → checkpoint G3 na sequência, loop PARA no gate.
- Checkpoint G3 emitido (loop/checkpoints/G3-report.md, COMPLETO 5/5), loop
  PARADO aguardando aprovação do dono (G3.approved) ou recusa (.rejected).
  7 INB abertos (03-09, todos proposal/não-vetantes) copiados no §3 do report.

## 2026-07-17 — pós-checkpoint G3 (watchdog/Maestro)

- G3 aprovada pelo dono via chat; gov/G3 mergeada em main e pushada (bff9bae);
  gov/G4 criada.
- INB-07 aprovado → feature G4-00 (hardening SECURITY DEFINER anon) criada no
  plano com DESKCOMM_GOV_PLAN_EDIT=1 (ca36202); agrupa INB-09.
- INB-06b executado: banco dev (rrydmwnporysaiysiztn) reconciliado — histórico
  supabase reparado (16 versões MCP revertidas, 17 locais applied) e migrations
  0030/0032/0033 aplicadas via supabase db push --include-all. 0031 já estava.
- INB-03/04/05/08 seguem open (decisões menores do dono).
- Próximo: Arquiteto abre G4-00 (prio 5), depois G4-01 (visibility_mode RLS).

## 2026-07-17 — sessão 18 do loop (core) — G4-00 (fase G4 aberta)

- G4-00 (hardening INB-07/09): migration 0034 tripla — revoke de anon nas 6
  SECURITY DEFINER de escrita. DESCOBERTA do implementer: 2 origens distintas de
  anon-EXECUTE — Grupo A (fn_upsert_wa_contact/conversation, mark_message) grant
  direto → revoke from anon; Grupo B (emit_event, fn_log_event, fn_audit_log_row)
  herdava via PUBLIC → revoke from public + re-grant explícito a authenticated/
  service_role. Invariante gov-hardening-anon-definer (12 probes) prova as 6 →
  permission denied SOB anon real + service_role positivo. types intocado.
- INB-09 fechado na mesma feature (acceptance 4): nota 1 fail-closed
  (owner_validation_unavailable 422 se service role ausente); nota 2 org do authz
  + .eq organization_id no SELECT do bulk (não mais org do 1º lead).
- INCIDENTE de infra: gov-verifier morreu por API timeout (stream idle) no meio
  da 1ª verificação — tree conferido intacto por hash (verifier não tem Write),
  re-despachado FRESCO; PASS na 2ª. Registro pro caso de recorrer.
- 60 invariantes + 155 unit verdes. INB-07 e INB-09 fechados (status closed).
- Próxima sessão: G4-01 (visibility_mode RLS — o CORAÇÃO do épico, decisão
  G1-06a default own_and_unassigned).

## 2026-07-17 — sessão 19 do loop (core) — G4-01 (o CORAÇÃO do épico)

- G4-01 (visibility_mode RLS): migration 0035 tripla. fn_can_view_conversation
  (STABLE SECURITY DEFINER, recebe campos da row — zero subquery por-row; role
  via auth.uid; anon/public revogados). conversations_select role+visibility-aware
  (só agent restrito; viewer/manager/admin org-wide); messages_select herda via
  EXISTS na conversa-mãe. Default own_and_unassigned (G1-06a).
- 2 descobertas de causa raiz do implementer: (1) rejeitou scalar-subquery de
  assigned_to (sob RLS daria NULL→tratado como fila→VAZAMENTO); usou EXISTS.
  (2) fn_conversation_assign virou DEFINER: com SELECT visibility-aware, o
  UPDATE...RETURNING numa transferência re-aplicava a policy à nova linha (novo
  dono invisível ao autor)→RLS violation quebrava transfer/release EM PRODUÇÃO.
  Fix: DEFINER + guard re-afirmando autz (caller agent+ same-org; INB-06a
  preservado). E: write-policies FOR ALL re-expressas por-comando (o USING de
  FOR ALL permissivo também governa SELECT via OR — anularia o visibility).
- Verifier: PASS 1ª rodada, 7 vetores de vazamento provados (cross-org 0,
  cross-atendente 0, fila por modo, manager org-wide, msg herda escopo, fn anon
  negada, transfer legítimo ok). pg_policy enumerado: conversations tem
  EXATAMENTE 1 policy SELECT (visibility-aware), ZERO FOR ALL. Hash OK. 65
  invariantes + 155 unit. Flip do eixo 5.
- Nota do verifier (não-defeito): UPDATE/DELETE direto de agent agora limitado às
  linhas visíveis (Postgres lê a row-alvo sob a SELECT policy) — endurecimento
  coerente; cross-owner via fn DEFINER, ingestão via service_role. Registrar
  pra G4-02/03 (a UI/queries do agent precisam contar com isso).
- Próxima sessão: G4-02 (inbox com escopo minhas/fila/todas) ou G4-03 (escopo no
  kanban) — ambas dep G4-01. Menor priority ⇒ G4-02 (prio 20).

## 2026-07-17 — sessão 20 do loop (core) — G4-02

- G4-02 (inbox com escopo): tabs Minhas/Fila/Todas já existiam — gap era: (A)
  esconder 'Todas' pra agent quando mode≠all (helper visibleInboxTabs; role já
  no ActiveOrg, visibility_mode exposto estendendo o select de org do AppLayout
  — sem query nova, sem migration); (B) contagens via GET /conversations/counts
  com createClient() USER-SCOPED (herda RLS, nunca admin); (C) tab vira ?filter=
  na URL (deep-link); (D) URL direta fora do escopo → useConversation 404 →
  "Conversa não encontrada ou fora do seu acesso", sem stack trace.
- Reforço do Maestro provado: esconder tab é cosmético, a RLS é a garantia —
  gov-5b (invariante NOVO) prova agent all=2 (own+fila) < manager all=3 (total);
  agent forçando where-id-other=0. A diferença agent<manager É a prova anti-admin.
- Incidente: implementer morreu 1x por API timeout (stream idle) no meio; o
  SendMessage do reforço RESUMIU automaticamente do ponto — concluiu na 2ª.
- gov-verifier PASS 1ª rodada, hash OK. 165 unit + 71 invariantes (gov-5b 6/6).
- Próxima: G4-03 (escopo no kanban/leads pra agent) — dep G4-01, prio 30.

## 2026-07-17 — sessão 21 do loop (core) — G4-03

- G4-03 (escopo de leads): migration 0036 tripla. fn_can_view_lead espelha
  fn_can_view_conversation (owner_user_id, mesmo visibility_mode). crm_leads:
  FOR ALL org-flat DROPADA, re-expressa por-comando (a armadilha da G4-01);
  SELECT visibility-aware; escrita own pro agent (drag-and-drop do lead próprio
  passa, de outro agent = 0 rows, WITH CHECK bloqueia criar pra outro),
  manager+ org-wide (bulk assign G3-04 intacto). DIRC RLS-vs-server-side na spec.
- Cuidado do Maestro (lead sem dono) provado — 4 números espelho das conversas:
  own_and_unassigned vê=1/move=1; own vê=0/move=0. Board sem código novo (já
  user-scoped, RLS filtra; contadores coerentes).
- Incidente: implementer morreu 1x por API error mid-stream; trabalho parcial
  intacto no tree (migration+fn feitas), resumido via SendMessage do ponto exato
  — completou DIRC+invariante. gov-verifier PASS 1ª rodada, hash OK. 84 test:db,
  165 unit, gov-5c 13/13.
- Screenshot: verifier julgou INAPLICÁVEL (diff não toca UI — zero componente/
  hook/página; board pré-existente; prova é o teste no Postgres descartável que
  o acceptance 2 pede). Não vetou.
- INB-10 aberto: crm_lead_activities/crm_lead_links seguem FOR ALL org-flat —
  timeline/vínculos de lead invisível vazam por query direta. Gap pré-existente.
- Próxima: G4-04 (métricas por responsável) — fecha a fase G4.

## 2026-07-17 — sessão 22 do loop (core) — G4-04 (fase G4 COMPLETA)

- G4-04 (métricas por responsável): spec §6 escrita ANTES do código (won/lost
  por owner sobre closed_at, conversas por assignee sobre assigned_at, TTFR =
  1ª outbound de HUMANO menos 1ª inbound). fn_attendant_metrics SECURITY INVOKER
  — a RLS 0035/0036 é o gate (agent agrega = só as próprias, automático; manager+
  org-wide + filtro por atendente). Migration 0037 tripla: 2 índices parciais.
  Rota /api/v1/metrics/attendants client USER-SCOPED (admin só resolve nome).
  UI nova: página Desempenho (funil + tabela por atendente + filtro) + nav.
- 2 detalhes do Maestro provados: (1) TTFR exclui bot (sent_by_user_id not null;
  bot tem sent_via='ai'+null) — seed com bot ANTES da humana, TTFR ignora;
  (2) EXPLAIN sob role agent E manager (não superuser), Index Scan, sem seq scan.
- Números exatos (gov-8, 12/12): manager A=[3,1,2,90s] B=[1,2,1,30s]; won/conversa
  fora da janela não conta; agent A own-scope vê própria + [] pra B; funil escopo-aware.
- Screenshot via Supabase LOCAL (não tocou remoto): G4-04-metrics-manager.png
  primário com dados reais. INCIDENTE de infra: supabase start local travou o
  Docker do host; reiniciei o Docker Desktop (kill -9 + reopen, 2 tentativas) e
  derrubei os containers supabase locais — ambiente recuperado, docker run OK,
  test:db rodou no verifier. O -agent.png saiu em loading (trava na captura);
  own-scope do agent provado pelo gov-8.
- gov-verifier PASS 1ª rodada, hash OK. 96 invariantes + 165 unit.
- FASE G4 COMPLETA (5/5) → checkpoint G4 na sequência, loop PARA no gate.
- Checkpoint G4 emitido (loop/checkpoints/G4-report.md, COMPLETO 5/5), loop
  PARADO aguardando aprovação do dono (G4.approved) ou recusa (.rejected).
  5 INB abertos (03/04/05/08/10, proposal/não-vetantes) copiados no §3.

## 2026-07-17 — virada de fase G4 → main (watchdog/Maestro)

- G4 aprovada pelo dono via chat ("retome"); gov/G4 mergeada em main e pushada
  (59b0d33, inclui os 2 commits de docs de webhooks de outra sessão do dono);
  gov/G5 criada. INB-03/04/05/08/10 seguem open (re-apresentar no checkpoint G5;
  INB-10 é pré-condição da G6).
- Próximo: Arquiteto abre G5-01 (routing config + availability). Teto 10/12 hoje.

## 2026-07-17 — incidente de infra + trombada de checkouts (watchdog/Maestro)

- 16:55: G5-01 blocked — disco 100% (1.5Gi livre) + untracked da fusão Vendaval
  (lib/agent-engine, migration 0038 colidente) quebrando o smoke no checkout.
- Watchdog liberou 6.5Gi (caches npm/uv/puppeteer/pnpm) → 8Gi livres.
- 17:11: Terminal B criou loop/STOP alegando git clean ~17h apagando trabalho
  da fusão. Apuração: gov-loop usa stash (não clean); trabalho confirmado salvo
  no worktree ../DeskcommCRM-vendaval. Principal chegou a ser trocado pra
  fusion/vendaval por engano e foi revertido pelo Maestro do Vendaval.
- Acordo de convivência: fusão vive no worktree (branch vendaval-fusion);
  NNNN 0038-0049 reservados pro gov-loop, fusão renumera 0050+.
- 17:5x: principal de volta em gov/G5, limpo, typecheck OK. STOP removido pelo
  watchdog com autorização do time que o criou. Loop retomando na G5-01.

## 2026-07-17 — sessão 12 do loop (core) — REPARO DE SMOKE (não G5-01)

- Entrada com smoke VERMELHO, mas NÃO era a main: vitest estava varrendo o
  worktree aninhado .claude/worktrees/webhooks/ (fusão Vendaval do colega) —
  275 test files / 5218 testes em vez dos nossos 165. 67 falhas eram do worktree
  (imports quebrados, Playwright specs no vitest) + React duplo (node_modules do
  worktree) quebrando nossos testes de componente com useContext null.
- REPARO (§1.8): vitest.config.ts exclude ganhou ".claude/**" e "node_modules"
  virou "**/node_modules/**". Suíte voltou aos 165 corretos (22 files).
- Resíduo NÃO-código: 2 testes de interação de TeamMembersClient (G2-02)
  oscilam no timeout de 5s sob load da máquina em 51 (catastrófico — build/test
  do colega no worktree). MESMO teste passa a 2993ms (load baixo) e falha a
  5758ms (load 51). Código são (gov-verifier verde na G2-02). NÃO mascarei o
  timeout — é infra, resolve quando o load normaliza.
- G5-01 NÃO iniciada: §1.8 (sessão de smoke-vermelho é reparo, 1 entrega) +
  test:db (Docker+pgvector) inviável a load 51. Loop dorme (12/12 do teto);
  amanhã abre G5-01 com a máquina fria.
