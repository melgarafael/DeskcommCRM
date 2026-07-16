# Fases — gov-loop (Governança de Atendimento)

> Loop de construção do épico de governança de atendimento do DeskcommCRM.
> Máquina portada do vendaval-loop; doutrina de DOMÍNIO soberana é o `CLAUDE.md`
> deste repo (+ `docs/specs/`). Este plano só governa PROCESSO (maker≠checker,
> features, gates). Ordem inegociável: **provas antes de comportamento** —
> a suíte de invariantes (G1) é o eval deste épico.
>
> Origem do backlog: 7 eixos de dor extraídos de feedbacks reais de usuários do
> sistema-modelo (TomikCRM), abstraídos por tema (zero PII): (1) RBAC
> quebrado/perigoso, (2) atribuição como campo de 1ª classe, (3) transferir/assumir,
> (4) roteamento+fila+horário, (5) escopo de visualização, (6) handoff IA→humano,
> (7) tags/origem. Anti-padrão declarado (lição do sistema-modelo): UI antes do
> modelo de dados, e enforcement atrás de feature-flag default-off.

## Branch e merge

- Fases correm em `gov/G<N>` a partir de `main`. Nunca usar namespace `vendaval/*`
  nem `feat/EPIC-*`.
- Virada de fase = ato humano (checkpoint `.approved` + merge com
  `DESKCOMM_GOV_PHASE_MERGE=1`, ou PR — escolha do dono no checkpoint).
- Atenção permanente: a cadeia `vendaval/F2-*` pode ter migrations não mergeadas.
  O gate de migration valida a sequência `NNNN` contra TODAS as branches locais.

## G1 — Provas & fundação (eval-first)

Nenhuma mudança de comportamento do produto. Sai da fase quando:
- CI verde consolidado existe (local + GitHub Actions) e roda typecheck+lint+test:unit.
- Postgres descartável valida `baseline.sql` nos modos install e update.
- Suíte de invariantes de governança existe, cobre os 7 eixos, verde com
  `test.fails` explícito nos gaps (o catraca: gap corrigido obriga flip do teste).
- Auditoria spec-04/05 vs código real registrada (tabela feito/não-feito com arquivo:linha).
- Modelo de dados alvo detalhado na spec 13 (DDL rascunho + matriz role×recurso).
- Decisões de produto do dono colhidas (G1-06 — human_input).

## G2 — RBAC de verdade

O eixo 1 (o bug "atendente=owner" do sistema-modelo nunca nasce aqui). Sai quando:
- Matriz role×endpoint aplicada server-side em `/api/v1` (não só RLS, não só UI).
- Papel de membro é editável pós-convite, com audit.
- Invariantes de RBAC de G1 todos verdes (flip dos `test.fails`).
- E2E de papéis passa (agent não acessa settings/billing/tokens; viewer read-only).

## G3 — Atribuição & transferência

Eixos 2, 3 e 7. Sai quando:
- Toda mudança de dono de conversa (claim/transfer/handoff) gera evento auditável.
- IA é assignee de 1ª classe (`assignee_kind`) — handoff = reassignment auditado.
- Kanban/lista mostram dono do lead; filtro por dono; atribuição em massa.
- Tags de conversa existem com filtro.

## G4 — Escopo de visualização

Eixo 5 ("Select sem where" nunca mais). Sai quando:
- `visibility_mode` por org aplicado em RLS (conversas/mensagens deixam de ser flat
  para role `agent`), com teste 2-tenants + 2-atendentes.
- Inbox/Kanban respeitam escopo; manager+ vê tudo.
- Métricas com filtro por responsável + performance individual.

## G5 — Roteador, fila & painel

Eixo 4 — o que o sistema-modelo nunca teve. Sai quando:
- Config de roteamento por org (modo, capacidade) + disponibilidade/horário por atendente.
- Worker de distribuição via `event_log` (trigger nunca faz HTTP — doutrina do repo).
- Fila visível com posição; painel admin de gestão de atendentes operante.

## G6 — Contrato para agentes externos

Eixo 6 — a superfície que o Vendaval consome. Sai quando:
- MCP tools de governança (assign/tags/queue) + `crm_request_human_handoff`
  ciente de fila/horário.
- `ai_dispatch_mode` em `organizations.settings` respeitado pelo dispatcher.
- Tools de leitura expõem assignee/tags/stage/queue.
- `docs/specs/14-contrato-governanca-agentes-externos.md` publicado com refs
  `arquivo:linha` verificadas. **O `.approved` desta fase é o gatilho da fase FG
  do Vendaval.**
