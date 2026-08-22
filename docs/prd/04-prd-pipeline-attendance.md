---
title: Sub-PRD 04 — Pipeline Kanban + Atendimento + Tickets + Roteamento
parent: 00-prd-master.md
depends_on: 01-prd-platform-base.md, 02-prd-customer-360.md, 03-prd-whatsapp-waha.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Sub-PRD 04 — Pipeline Kanban + Atendimento + Tickets + Roteamento

> Onde atendente humano e IA encontram o cliente final. Define a UI operacional do dia-a-dia (Kanban + Inbox 3 colunas), as regras de transição de conversa, a infraestrutura multi-pipeline desde o schema, o modelo de tickets-como-leads e o roteamento simples entre atendentes.

---

## 1. Contexto & Posicionamento

Plataforma Base (Sub-PRD 01) garante isolamento, auth e auditoria. Customer 360° (Sub-PRD 02) define quem é a pessoa e como a timeline acumula. Canal WhatsApp (Sub-PRD 03) traz e despacha mensagem. Falta a camada **operacional** — onde o atendente vê a fila, responde o cliente, move o pedido no funil, escala pra colega e mede produtividade.

Duas faces complementares: a **Inbox** (3 colunas) consome >80% do tempo do atendente; o **Kanban** (board com drag-drop e filtros) é onde gerentes inspecionam progresso e priorizam.

Decisões herdadas: multi-pipeline desde o schema; ticket reusa `crm_leads` em pipeline "Suporte"; fractional indexing vem do Sub-PRD 02 §3.2; realtime via Supabase Realtime; drag-drop via `@hello-pangea/dnd`. Meta MVP: **atendente novo opera em ≤30min sem treinamento estruturado**.

---

## 2. Escopo

### Dentro do escopo

1. Pipeline Kanban (UI) — drag-drop, filtros, bulk actions, card visual
2. Multi-pipeline desde o schema; pipeline default seedado no signup
3. `Conversation status` (`open / pending / resolved`) com transições auditadas
4. Tickets modelados como `crm_leads` em pipeline "Suporte"
5. Inbox 3 colunas (`<ConversationList>` / `<ChatThread>` / `<CRMSidePanel>`)
6. Hooks principais (atendimento + kanban)
7. Atendimento humano — presença, claim, supervisão read-only, notas internas, quick replies
8. Roteamento simples (round-robin) entre atendentes online
9. Mobile (3 colunas → 2 rotas), `100dvh`, touch ergonômico
10. Conversation múltipla (N leads via `crm_lead_links`)
11. Realtime + banner de reconexão
12. Dashboard de atendimento lite

### Fora do escopo deste sub-PRD

- Modelagem de timeline e activities → Sub-PRD 02
- Captura/envio de mensagem WhatsApp → Sub-PRD 03
- IA, sentiment, handoff IA→humano → Sub-PRD 05
- Webhooks Nuvemshop que populam pipeline "Pedidos" → Sub-PRD 06
- Skill-based routing, SLA timers complexos, balanceamento por carga → pós-MVP
- Permissão por pipeline (`user_pipeline_access`) → herdado do Sub-PRD 01

---

## 3. Capacidades Funcionais

### 3.1 Pipeline Kanban (UI)

**Princípios.**
- Drag-drop com `@hello-pangea/dnd`; após drop, **patch otimista** + `PATCH /api/v1/leads/:id` com `{ stage_id, position_in_stage }`; rollback em erro
- Realtime do mesmo lead durante drop **não pode causar "salto"** — estratégia: ignorar broadcast pro lead em estado `dragging` e reconciliar após `onDragEnd` (decisão final na Spec)
- `position_in_stage` calculado localmente via `midpoint(prev, next)` antes do despacho (fractional indexing — Sub-PRD 02 §3.2)
- Card mostra: `title` (com vocabulary do pipeline), `value_cents` formatado, avatar do `owner`, até 3 tags (resto vira "+N"), `last_activity_at` relativo, badge "atrasado" se `expected_close_date < today` e `status='open'`
- Filtros: owner, status, tag, search por título; query params na URL; última visão persistida em `user_preferences`
- Bulk actions (`move_stage`, `assign_owner`, `add_tag`, `remove_tag`) com **limite 50 cards** no MVP; acima disso 422
- Virtualização ativa em colunas grandes (threshold na Spec)

**ACs principais.**
- Drag de "Pago" → "Em separação" move em <100ms; outros usuários veem em <2s via Realtime
- Drag concorrente do mesmo card resolve com 1 vencedor; perdedor recebe 409 e refetch automático
- Bulk com 51 cards retorna 422 `bulk_limit_exceeded`
- Pipeline com 1000 leads renderiza com scroll fluido a 60fps

### 3.2 Multi-pipeline desde o schema

**Princípios.**
- 1 tenant pode ter N `crm_pipelines`; cada lead vive em UM (vide Sub-PRD 02 §3.2)
- Mesma UI Kanban renderiza qualquer pipeline (parametrizado por `pipeline_id`)
- Vocabulary e custom fields são por pipeline (Sub-PRD 02 §3.6, §3.7)
- Mover lead **entre pipelines** não é suportado no MVP — abrir lead novo no destino e linkar ao mesmo `contact_id`
- `manager`+ pode criar pipeline novo via UI (nome + vocabulary + stages + custom fields), com audit

**ACs principais.**
- Tenant signup tem 1 pipeline ativo ("Pedidos") visível
- Manager cria pipeline "Suporte" → aparece no `<PipelineSwitcher>` sem reload
- Tentativa de mover lead pra stage de outro pipeline retorna 422 `stage_pipeline_mismatch`

### 3.3 Pipeline default e stages canônicas e-commerce

**Stages seedadas no pipeline "Pedidos":**

| # | Nome | Flag |
|---|---|---|
| 1 | Carrinho abandonado | — |
| 2 | Aguardando pagamento | — |
| 3 | Pago | — |
| 4 | Em separação | — |
| 5 | Enviado | — |
| 6 | Entregue | `is_won=true` |
| 7 | Pós-venda | — |
| — | Cancelado | `is_lost=true` (fora do fluxo linear) |

**Princípios.**
- `position` numérico mantém ordem visual; `manager`+ pode renomear stage mas **não remover** stage com leads dentro
- Vocabulary default e-commerce (vide Sub-PRD 02 §3.7)
- Lead criado por webhook Nuvemshop entra na stage correta por mapeamento (detalhes no Sub-PRD 06)

**ACs principais.**
- Mover pra "Entregue" muda `status='won'` automaticamente (regra do Sub-PRD 02 §3.8)
- Remover stage com 12 leads dentro retorna 422 `stage_has_leads`

### 3.4 Conversation status & transições

Estados: `open` (humano/IA ativos OU aguardando 1ª resposta) — `pending` (última msg foi do atendente; aguardando cliente) — `resolved` (atendente fechou).

**Princípios.**
- Toda transição é evento auditado, gera atividade `conversation_status_changed` na timeline do(s) lead(s) vinculado(s)
- Cliente respondendo em `pending` → volta automaticamente pra `open`
- Cliente respondendo em `resolved` dentro de janela X (default 24h, decisão na Spec) reabre a conversation
- IA pode marcar `resolved` em handoff de saída claro (vide Sub-PRD 05)

**ACs principais.**
- Botão "Resolver" marca `resolved`, conversation some da fila default, atividade auditada
- Cliente em `resolved` manda nova msg após 1h → volta pra `open`; atendente notificado

### 3.5 Tickets modelados como `crm_leads`

**Princípios.**
- Pipeline "Suporte" não ativado de fábrica, mas pré-modelado; `manager`+ ativa
- Vocabulary: `lead='Ticket'`, `won='Resolvido'`, `lost='Sem resposta'`
- Stages sugeridas: `Aberto / Triagem / Em atendimento / Aguardando cliente / Resolvido`
- Custom fields default: `categoria` (select), `prioridade` (select), `pedido_relacionado_id` (link a lead em "Pedidos" via `crm_lead_links`)
- 1 contact pode ter pedido + ticket simultâneos (vide §3.11)
- Alarme visual em `prioridade='urgente'` aberto >2h (threshold na Spec)

**ACs principais.**
- Atendente clica "Abrir ticket" no painel CRM → lead novo em "Suporte" linkado ao mesmo contact e à mesma conversation
- Filter `?pipeline=suporte&prioridade=urgente` retorna tickets correspondentes

### 3.6 Inbox de atendimento — layout 3 colunas

**Coluna 1 — `<ConversationList>`.** Search (ILIKE no MVP), filtros pré-configurados (`Todas / Não lidas / Abertas / Pendentes / Resolvidas / Minhas / Sem responsável`). Item: avatar, nome/telefone, preview de 140 chars, timestamp, badge unread, ícone canal, tag do pipeline. Ordenação `last_message_at desc`. Scroll infinito cursor-based.

**Coluna 2 — `<ChatThread>`.** Header com nome + presença + botões `Resolver`, `Eu cuido`, `Mais` (`Reassign / Bloquear / Transferir pra IA / Abrir ticket`). Bubbles tipo `text/image/audio/video/document/location/reaction`; bot tem badge "IA". Composer: paperclip, textarea auto-resize, send, paste de imagem, atalho Cmd/Ctrl+Enter. Indicador "digitando..." (eventos do WAHA, Sub-PRD 03). Banner amarelo "Reconectando..." em queda de canal.

**Coluna 3 — `<CRMSidePanel>`.**
- `<ContactSection>`: avatar grande, dados do contact (CPF mascarado pra `agent`, visível pra `manager+`), tags, custom_fields do contact
- `<DealSection>`: lead atual com seletor inline de stage; abas se houver >1 lead vinculado
- `<NotesSection>`: notas internas — caixa + lista; salvas como `activity.type='note'` com `metadata.internal=true`; **não vão pro export LGPD do titular** (são dado operacional do tenant, não dado pessoal)
- `<TimelineSection>`: timeline polimórfica (Sub-PRD 02 §3.5) com filtros por tipo

**Princípios.**
- `100dvh` (não `100vh` — Safari iOS); divisor arrastável; lazy-load da timeline
- Estado da conversa selecionada na URL (`/inbox/[conversationId]`) pra deep-link
- Drag-drop **não** é usado na inbox; é exclusivo do Kanban

**ACs principais.**
- Selecionar conversation: thread em <300ms (cache), side panel em <500ms
- Mensagem inbound via Realtime: bubble aparece + badge incrementa; auto-scroll **só** se atendente já estava no fim
- Mudança de stage no `<DealSection>` gera atividade `stage_changed`
- Nota interna salva sem disparar mensagem WhatsApp

### 3.7 Hooks principais (UI)

| Hook | Responsabilidade |
|---|---|
| `useConversationsRealtime(filters)` | Lista realtime + filtros de fila |
| `useMessagesRealtime(conversationId)` | Stream da thread + dedupe por `external_id` |
| `useChannelSession(orgId)` | Estado da sessão WAHA + banner de reconexão |
| `useSendMessage(conversationId)` | Envio com **otimistic update** (`status='sending'`) |
| `useMarkAsRead(conversationId)` | Marcar lida, debounced |
| `useTypingIndicator(conversationId)` | Lê + emite typing com throttle |
| `useBoard(pipelineId, filters)` | Estado do Kanban com Realtime |
| `useConversation(conversationId)` | Detalhe single (contact, lead, status) |
| `usePipelineVocabulary(pipelineId)` | Vocabulary com cache local |
| `useAgentPresence()` | `online/busy/offline` manual + auto-detect |

**Princípios.**
- TanStack Query pra cache e mutations; subscribe/unsubscribe limpos no unmount
- Otimistic com rollback automático em erro
- Detalhe de assinaturas e payload → Spec

**ACs principais.**
- Subscribe simultâneo de inbox + thread + board ≤4 canais Realtime por aba
- `useSendMessage` mostra bubble em <50ms; em erro vira "falha — toque pra reenviar"

### 3.8 Atendimento humano

**Presença.** 3 estados: `online` (recebe roteamento), `busy` (mantém conversas abertas, não recebe novas), `offline`. Toggle manual + auto-detect inactivity (X min sem input → `busy`; threshold na Spec). Auto-offline ao fechar última aba.

**Atribuição.**
- **Claim manual ("Eu cuido")**: lock otimista; 2 cliques simultâneos → 1 ganha, outro recebe 409 `conversation_already_claimed`
- **Round-robin** automático em conversation nova (vide §3.9)
- **Reassign**: `manager`+ pra qualquer atendente; `agent` apenas pra si mesmo (não empurra carga pra colega — decisão default, ajustável na Spec)

**Supervisão (manager+).** Abre qualquer conversation em **modo somente-leitura** (badge "Modo Supervisor"); composer + botões críticos desabilitados. Toda visualização auditada (`conversation.viewed_as_supervisor`).

**Notas internas.** Texto livre no `<NotesSection>`; salvas como `activity.type='note'` com `metadata.internal=true`. Visíveis pra `agent`+; **não** entram em export LGPD do titular.

**Quick replies / templates.** Lista plana por tenant (gerenciada por `manager`+). Cada template: `title`, `body` com variáveis `{nome}`, `{pedido_id}`, `{tracking_url}`. Atendente escolhe via menu (`/` ou botão); variáveis preenchidas do contexto antes do envio. Pre-flight check: variável obrigatória vazia bloqueia envio. Formato (jsonb vs tabela própria) **deferido pra Spec**.

**Lidas/não lidas.** `unread_count_for_owner` denormalizado; badge na lista. Abrir thread marca como lida (debounced); "marcar como não lida" disponível.

**ACs principais.**
- Claim concorrente: 1 vencedor, outro recebe 409 + toast amigável
- 6 min sem input → `busy` automático
- Quick reply `Olá {nome},` preenche `Olá João,` se contact tem `name='João'`
- Manager em modo supervisor não consegue enviar mensagem; audit gerada

### 3.9 Roteamento simples (round-robin)

**Princípios.**
- Algoritmo: round-robin cíclico entre `agent`+ com presença `online` (ponteiro circular por tenant)
- Sem skill-based, sem balanceamento por carga no MVP
- 0 atendentes online: conversation fica `owner_user_id=null`, vai pra fila "Sem responsável" com alarme no dashboard
- `manager`+ pode forçar reassign a qualquer momento
- Implementação (TS worker no `event_log` vs Postgres function vs `assignment_queue`) **deferida pra Spec**; preferência: TS worker com lock pessimista no ponteiro

**ACs principais.**
- 3 atendentes online (A,B,C), 6 conversations novas → A,B,C,A,B,C
- B fica `busy` no meio → próximas vão A,C,A,C
- 0 online → "Sem responsável" + alarme visual
- Reassign auditado com `who/from/to/reason?`

### 3.10 Mobile (3 colunas → 2 rotas)

**Princípios.**
- <768px: `/chat` (lista em tela cheia) + `/chat/[id]` (thread + composer + drawer pro `<CRMSidePanel>`)
- `100dvh` em vez de `100vh`; `safe-area-inset-bottom` pro composer; tap targets ≥44px
- Drag-drop **não** suportado em mobile no MVP; board é read-only com tap-menu pra mover
- Anexar mídia via input file nativo + `capture="environment"`

**ACs principais.**
- iPhone 14 Safari: `/chat` sem scroll horizontal; tap navega pra thread
- Composer não é coberto pelo teclado virtual
- Kanban mobile: swipe horizontal entre colunas; mover lead via tap → menu

### 3.11 Conversation múltipla — N leads por conversation

**Princípios.**
- Vínculo via `crm_lead_links` polimórfico (Sub-PRD 02): `(conversation_id, lead_id, link_type)`
- `<DealSection>` mostra abas quando >1 lead vinculado
- Mensagens aparecem na timeline de todos os leads vinculados via JOIN com `crm_lead_activities`
- Botão "Abrir ticket" cria lead novo em "Suporte" linkado automaticamente

**ACs principais.**
- Cliente com pedido em "Pago" reclama de defeito → "Abrir ticket" cria lead em "Suporte" linkado à mesma conversation; painel mostra 2 abas
- Mover stage do ticket não afeta o pedido e vice-versa

### 3.12 Realtime via Supabase Realtime

**Princípios.**
- RLS aplica nos canais (zero vazamento cross-tenant)
- Banner amarelo "Reconectando..." em queda >3s; verde "Reconectado" temporário ao voltar (timeouts na Spec)
- Canais consolidados por escopo (`org-{id}-conversations`, `org-{id}-leads`, `conv-{id}-messages`); ≤4 por aba
- Eventos: `INSERT/UPDATE` em `conversations`, `messages`, `crm_leads`, `crm_lead_activities`; `BROADCAST` pra typing/presença
- Queda sustentada >30s: refetch full ao reconectar (recovery > delta)

**ACs principais.**
- Move card no Kanban → outros atendentes veem em <2s sem refresh
- Canal cai (DevTools offline) → banner em <5s; ao voltar, sem duplicar bubble

### 3.13 Dashboard de atendimento (lite)

**Métricas no MVP.**
- Conversas abertas por atendente (contador atual + sparkline)
- Tempo médio de primeira resposta (hoje) — diff entre inbound e próxima outbound
- Conversas pendentes >10min sem resposta (threshold configurável na Spec)
- Taxa de resolução por atendente (hoje/semana)
- Conversas em "Sem responsável" — link pra fila

**Princípios.**
- Cálculo via SQL agregado on-demand; cache 60s; materialized view se virar gargalo
- `manager`+ vê cross-atendentes; `agent` vê só as suas
- Sem export pra CSV/PDF no MVP

**ACs principais.**
- `/dashboard/atendimento` carrega em <1s; refresh auto a cada 30s
- Conversation pendente >10min sem resposta → badge vermelho

---

## 4. Requisitos Não-Funcionais

### 4.1 Performance
- p95 carregar inbox (lista + thread + side panel) cache frio: <1s
- p95 drag-drop end-to-end: <300ms
- p95 envio otimista (bubble visível): <50ms
- p95 Realtime delivery (DB → bubble): <2s
- Kanban com 1000 leads: 60fps em laptop M1 com virtualização
- Inbox com 200 conversations: scroll fluido com virtualização

### 4.2 Disponibilidade & resiliência
- Realtime degradado: UI continua funcional (read estático + polling de fallback opcional)
- Drag-drop com falha de rede: rollback + retry com backoff
- Composer offline: fila local com `status='queued'`; envia ao voltar (decisão na Spec)

### 4.3 Acessibilidade
- Teclado-first: Tab/Shift+Tab funcional; atalhos canônicos (`j/k`, `e`, `r`, `n` — finalizar na Spec)
- ARIA roles em listas/threads/drag-drop
- Contraste WCAG AA (4.5:1)
- Screen reader anuncia eventos críticos (nova msg, atribuição, resolved)

### 4.4 Observabilidade
- Métricas custom: `inbox.message_send_latency_ms`, `kanban.drag_drop_failure_rate`, `realtime.reconnect_count`, `routing.unassigned_queue_depth`
- Sentry com `request_id` + contexto sanitizado
- Audit cobre claim, reassign, resolve, stage_change, bulk_action, supervisor view

---

## 5. Acceptance Criteria do sub-PRD

Pipeline + Atendimento é considerado **MVP-completo** quando:

1. ✅ Tenant novo tem pipeline "Pedidos" seedado com 7 stages + "Cancelado"; Kanban funcional
2. ✅ Drag-drop entre colunas persiste e propaga via Realtime em <2s
3. ✅ Inbox 3 colunas em desktop carrega em <1s p95
4. ✅ Inbox em mobile (iPhone Safari) navega `/chat` ↔ `/chat/[id]` com `100dvh`
5. ✅ Claim concorrente resolve com 1 vencedor (lock otimista, 409 pro perdedor)
6. ✅ Manager em modo supervisor: composer desabilitado + audit gerada
7. ✅ Round-robin distribui em ordem cíclica; 0 online → "Sem responsável" com alarme
8. ✅ Status `pending → open → resolved` audita transições e filtra na lista
9. ✅ Pipeline "Suporte" ativável; ticket linkado a pedido via `crm_lead_links`; abas no painel
10. ✅ Quick reply `{nome}` interpolado antes do envio; variável obrigatória vazia bloqueia
11. ✅ Bulk em 30 cards: `move_stage` em <3s; >50 retorna 422
12. ✅ Dashboard mostra 5 métricas; `agent` vê só as suas
13. ✅ Banner "Reconectando" aparece em queda Realtime e recupera sem duplicar mensagens

---

## 6. Dependências

### Internas
- **Sub-PRD 01** — auth, RLS, audit, RBAC, convenções de API
- **Sub-PRD 02** — `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`, fractional indexing, vocabulary, custom fields
- **Sub-PRD 03** — `conversations`, `messages`, status de sessão, eventos de typing, envio outbound

### Externas
- `@hello-pangea/dnd`, TanStack Query, Supabase Realtime, Tailwind + shadcn/ui, Lucide icons

### Decisões deferidas pra Spec (não bloqueantes)
- Estratégia de virtualização (react-window vs react-virtual) e threshold
- Threshold inactivity `online → busy` (sugestão 5min)
- Threshold reabertura automática `resolved → open` (sugestão 24h)
- Implementação do round-robin (TS worker / Postgres function / `assignment_queue`)
- Formato dos quick replies (jsonb em settings vs tabela `message_templates`)
- Threshold de "atrasado" no card; configurabilidade por pipeline
- Política de auto-online/offline (heartbeat, timeouts, comportamento ao fechar última aba)
- Layout mobile do `<CRMSidePanel>` (drawer vs bottom sheet vs tab)
- Atalhos de teclado canônicos finais
- Comportamento de reabrir conversation `resolved` (mesma vs nova)
- Cache strategy do TanStack Query (staleTime, gcTime)

---

## 7. Riscos Específicos do sub-PRD

| # | Risco | Mitigação |
|---|---|---|
| K1 | **Inconsistência kanban-realtime** — broadcast causa "salto" após drop | Ignorar broadcast pro lead em `dragging`; reconciliar após `onDragEnd`; testar em 2 browsers paralelos |
| K2 | **Performance em pipeline com 1000+ leads** | Virtualização por coluna; lazy-load fora do viewport; índice `(org, pipeline_id, stage_id, position_in_stage)` |
| K3 | **Supervisão sem trilha adequada** | Toda abertura por `manager`+ que não é `owner` gera `audit.action='conversation.viewed_as_supervisor'`; revisão semanal |
| K4 | **Atendente abusivo move card de outro** | RLS limita `agent` a editar leads onde `owner_user_id=self`; UI esconde drag handle em cards de outros pra `agent` |
| K5 | **Confusão UX em mobile** | `100dvh`, `safe-area-inset-bottom`, testes manuais em iOS Safari + Chrome Android antes de release |
| K6 | **Conflito drag-drop simultâneo** | Lock otimista no PATCH (`updated_at` no payload); 2º request retorna 409 com refetch automático |
| K7 | **Falta contexto cross-canal pro atendente** | `crm_lead_links` polimórfico + `<DealSection>` com abas; teste com contact que tem pedido + ticket |
| K8 | **Realtime hits channel limit** | Consolidar canais por escopo; monitorar contador por aba |
| K9 | **Round-robin distribui pra atendente sobrecarregado** | Documentado como limitação MVP; manager faz reassign manual; balanceamento por carga é pós-MVP |
| K10 | **Quick reply envia placeholder cru** ("Olá {nome}") | Pre-flight bloqueia se variável obrigatória vazia; opcionais viram string vazia silenciosamente |

---

## 8. Fora de Escopo (deste sub-PRD)

- Skill-based routing — pós-MVP
- Balanceamento por carga no roteamento — pós-MVP
- SLA timers complexos com escalation automática — pós-MVP
- Permissão por pipeline (`user_pipeline_access`) — herdado do Sub-PRD 01
- Mover lead entre pipelines — não suportado no MVP
- Templates com categorias, analytics de uso, A/B — pós-MVP
- Mensagem agendada / send later — pós-MVP
- Drag-drop em mobile — pós-MVP
- Co-edição em tempo real do mesmo card (estilo Figma) — fora-do-escopo permanente
- Voice notes nativas no composer — pós-MVP (no MVP só upload)
- Reactions emoji do atendente — pós-MVP
- Threading dentro da conversation (estilo Slack) — não cabe no contexto WhatsApp
- Export de transcrição da conversation em PDF — pós-MVP

---

## 9. Decisões deferidas pra Spec (Fase 3)

A serem decididas em `docs/specs/04-spec-pipeline-attendance.md`:

1. Payload exato de cada componente UI (props de `<ConversationList>`, `<ChatThread>`, `<MessageBubble>`, `<CRMSidePanel>`, `<KanbanBoard>`, `<KanbanCard>`, `<ComposerBar>`)
2. Implementação do round-robin (TS worker no `event_log`, Postgres function, ou `assignment_queue`)
3. Formato dos quick replies (jsonb em `pipelines.settings.quick_replies` vs tabela `message_templates`)
4. Threshold de "atrasado" no card e configurabilidade por pipeline
5. Política de auto-online/offline (heartbeat interval, transição `online→busy`, timeout pra `offline`)
6. Estratégia de virtualização (biblioteca + threshold)
7. Layout mobile do `<CRMSidePanel>` (drawer / bottom sheet / tab)
8. Atalhos de teclado canônicos finais
9. Comportamento ao reabrir conversation `resolved` (mesma vs nova)
10. UX de bulk action (shift-click + checkbox; comportamento em erro parcial)
11. Catálogo final de `audit.action` desta camada (`conversation.claimed/reassigned/resolved/reopened/viewed_as_supervisor`, `lead.bulk_*`, `quick_reply.sent`, `pipeline.created`, `stage.created/renamed/removed`)
12. Nomes e contratos de eventos `event_log` emitidos
13. Cache strategy do TanStack Query (staleTime, gcTime, refetchOnFocus)
14. Limite de canais Realtime por aba e estratégia de consolidação
15. Política de retry no `useSendMessage` em falha de rede

---

## Anexos

- `docs/research/reference-synthesis.md` (especialmente §3 Data model, §5 Frontend/Realtime, §7 RBAC, §9 Anti-patterns)
- `docs/prd/00-prd-master.md` — visão geral
- `docs/prd/01-prd-platform-base.md` — auth, RBAC, audit
- `docs/prd/02-prd-customer-360.md` — leads, stages, vocabulary, timeline, custom fields
- `docs/prd/03-prd-whatsapp-waha.md` — conversations, messages, sessões, typing
- `tasks/todo.md` — workflow de construção
