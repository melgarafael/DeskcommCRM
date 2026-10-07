# Plano — Pedido 2: contato pessoal sai da operação (spec 21 inteira)

> Fonte: `docs/specs/21-spec-conversa-pessoal-sai-da-operacao.md` (branch `spec/contato-pessoal-sai-da-operacao` @ `bc609979b`).
> Base medida: leitura direta dos arquivos citados, em 03/10/2026, na branch da spec.
> Regra deste plano: todo item cita arquivo + função + trecho atual abertos agora. §12 foi fechado em 03/10/2026 — nada ficou para depois.
> Nada aqui é código de produto — é o mapa para quem for implementar.

## Decisões travadas (com justificativa)

| # | decisão | porquê |
|---|---|---|
| D1 | Coluna nova: `contacts.is_personal boolean DEFAULT false NOT NULL` | Prefixo `is_`, no padrão de `is_blocked` (`supabase/baseline.sql:1367`) e `is_anonymized`. Reutilizar `is_blocked` misturaria descadastro com pessoal na auditoria e nas regras (spec §3.1, já decidido). |
| D2 | Quem marcou/quando fica SÓ em auditoria + timeline, sem coluna extra | Já decidido na spec §3.6 ("sem coluna extra no contato"). Menos coluna, mesma prova. |
| D3 | Marcar/desmarcar exige `requireRole("manager")` (gerente e dono), NÃO `admin` | Spec decisão 1. Diferença medida e proposital contra o desbloqueio: `POST .../unblock` exige `requireRole("admin")` (`app/api/v1/contacts/[id]/unblock/route.ts:61`) porque desfazer descadastro reabre canal que o cliente fechou (direito do titular). Pessoal é decisão operacional, não LGPD — gerente pode. |
| D4 | Eventos de auditoria novos, nomes propostos: `contact.marked_personal` e `contact.unmarked_personal` | Paralelos a `contact.blocked` / `contact.unblocked` (emitidos em `lib/channels/pos-entrada.ts:268` e `unblock/route.ts:89`). Nomes travados por teste de nome (critério 9). |
| D5 | Timeline: 2 tipos novos no vocabulário fechado, nomes propostos: `contact_marked_personal` / `contact_unmarked_personal` + rótulos em `ACTIVITY_LABELS` | `emitLeadActivity` (`lib/leads/activity-emitter.ts:111`) exige `type: ActivityType`; `ACTIVITY_LABELS` é `Record<ActivityType, string>` EXAUSTIVO (`lib/leads/activity-vocabulary.ts:185`) — tipo novo sem rótulo não compila. Rótulos propostos: "Marcado como pessoal" / "Desmarcado como pessoal". |
| D6 | Timeline usa o negócio aberto do contato; sem negócio aberto, pula a timeline em silêncio | `crm_lead_activities.lead_id` é NOT NULL (a fusão documenta isso em `merge/route.ts:128-131`). Contato sem negócio não tem onde pendurar a linha; auditoria continua valendo como prova. Fire-and-forget como o resto (`activity-emitter.ts:49-56`). |
| D7 | Saída de campanha usa status NOVO `personal`, não `opted_out` | `fecharPorOptOut` (`lib/campanhas/resposta.ts:171-198`) marca `opted_out` e alimenta a taxa de opt-out (`taxasDaCampanha`, `lib/campanhas/metricas.ts:73-82`). Reutilizar inflaria "pediu para parar" com quem nunca pediu. Status novo entra em `STATUS_DO_DESTINATARIO` (`lib/campanhas/tipos.ts:24`) + `TERMINAIS_DE_DESPACHO` + CHECK da migration 0375 (o invariante `vocabulario-banco-x-typescript` vigia a paridade — ver comentário em `tipos.ts:1-9`). |
| D8 | Desmarcar NÃO reativa nada (follow-up, campanha, prospecção) | Espelha o desbloqueio: "Não reativa follow-up nem campanha que o bloqueio cancelou" (`unblock/route.ts:43-53`). Histórico intacto, tudo volta a APARECER por filtro (decisão 2 da spec). |
| D9 | `crm_propose_contact_field` (MCP) NÃO muda | Não está na lista da spec §6 item 1. Proposta não grava nada — uma pessoa confirma depois (`lib/mcp/tools/contacts.ts:177-188`). Humano no meio = fora da regra de inutilização. |
| D10 | `getContactHandler` continua abrindo ficha de pessoal | A ficha é onde mora o botão desmarcar (spec §3.7). Quem recusa é a TOOL MCP (`crm_get_contact`), não o handler — mesmo desenho do #2158 (`contacts.ts:100-158`). Idem `getConversationHandler`: a API passa a devolver 404 para pessoal (some do inbox até por link direto), e o desmarcar acontece pela ficha de Contatos. |

---

## F1 — Banco (fazer primeiro; todo o resto depende da coluna)

### Etapa 1 — Migration + baseline + índice
- **O que muda:** cria `contacts.is_personal`, índice parcial, estende o trigger do roteiro, ajusta o CHECK de destinatário de campanha.
- **Onde:**
  - Arquivo novo `supabase/migrations/<carimbo>_0534_contato_pessoal.sql` (0534 livre, confirmado em 03/10/2026 contra a `origin/main` — maior 0533 — e contra os diffs dos 13 PRs abertos que tocam migrations, nenhum com 0534; ver §12 item 6).
  - Cabeçalho com linha `-- manifest:` (padrão medido na 0533, primeira linha do arquivo).
  - `ALTER TABLE public.contacts ADD COLUMN is_personal boolean DEFAULT false NOT NULL` (espelha `baseline.sql:1367`).
  - `CREATE INDEX IF NOT EXISTS idx_contacts_org_personal ON public.contacts (organization_id) WHERE (is_personal = true)` (espelha `baseline.sql:2656`).
  - Estender o gatilho `trg_contato_encerra_roteiro_com_humano_ou_opt_out` (migration 0397, descrito em `supabase/migrations/MANIFEST.md:437`): disparar também na virada false→true de `is_personal`, com motivo próprio (proposto: `pessoal`, não `opt_out`).
  - `ALTER TABLE campaign_recipients DROP CONSTRAINT ... / ADD CONSTRAINT` incluindo `personal` no CHECK (paridade com `STATUS_DO_DESTINATARIO` em `lib/campanhas/tipos.ts:24-35`, cobrada pelo invariante `vocabulario-banco-x-typescript`).
  - Apêndice idempotente no fim de `supabase/baseline.sql` (a cauda atual é o apêndice da 0531 — `update public.crm_leads ... source = c.channel`). `MANIFEST.md` NÃO recebe linha (é histórico).
- **Teste:** `tests/invariants/` novo (ex.: `contato-pessoal-coluna.test.ts`): coluna existe com default false; índice parcial existe; CHECK aceita `personal`; trigger 0397 cancela `coletando` ao marcar pessoal.
- **Sabotagem:** `DEFAULT true` — todo contato nasce pessoal e a lista esvazia, o teste acusa; tirar o motivo próprio do trigger — roteiro cancelado sai como `opt_out` e o teste de motivo acusa.

### Etapa 2 — Tipos TypeScript que espelham a coluna
- **O que muda:** acrescenta `is_personal: boolean` onde `is_blocked` aparece.
- **Onde (trecho atual):**
  - `lib/types/contacts.ts:15-17` (`is_blocked: boolean; blocked_reason...` + `is_anonymized`) — o cabeçalho do arquivo manda espelhar o schema (`contacts.ts:1-4`).
  - `SELECT_COLS` em `app/api/v1/contacts/_handler.ts:36-37` (lista de colunas sem nenhuma marca de pessoal — o próprio fato que a spec §1 mediu).
  - `SELECT_COLS` em `app/api/v1/conversations/_handler.ts:86-96` — embed `contacts:contact_id (..., is_blocked, ...)` e `ContactSummary` em `hooks/inbox/useConversationsRealtime.ts:15-34` (`is_blocked`, `is_anonymized` lado a lado).
  - `ContactRow` em `lib/agent-engine/edge/crm/get-lead-context.ts:154-164` + query `:210-214` (`select ... is_blocked ...`).
- **Teste:** unit — tipo exige a coluna (typecheck quebra se faltar); teste de `SELECT_COLS` devolve `is_personal`.
- **Sabotagem:** tirar `is_personal` do `SELECT_COLS` do inbox — selo e filtro leem `undefined` e o teste acusa.

---

## F2 — Marcar / desmarcar (coração do pedido)

### Etapa 3 — Rotas + Zod + guards + auditoria
- **O que muda:** arquivos novos `app/api/v1/contacts/[id]/personal/route.ts` (POST marca) — e desmarca no mesmo arquivo via DELETE (ou `POST .../personal/remove`; decidir na implementação, um arquivo só).
- **Onde (molde atual):** `app/api/v1/contacts/[id]/unblock/route.ts:54-99` — receita inteira: `requireSupportWrite()` primeiro (`:55`, de `lib/impersonate/support.ts`, mesmo padrão do merge `merge/route.ts:80`), `requireRole(...)` (`:61`), `z.uuid()` no path (`:65`), `createAdminClient()` + filtro `organization_id` programático (`:69-78`, anti-pattern 10), `audit()` sem telefone (`:88-96`), `ok()`/`fail()` (nunca Response na mão).
  - Diferenças contra o molde: `requireRole("manager")` (D3; o merge usa `"manager"` em `merge/route.ts:85`), Zod só valida o uuid (sem body).
  - `"contact.marked_personal"` e `"contact.unmarked_personal"` no **FIM** de `AUDIT_ACTIONS` (`lib/audit/actions.ts:1013-1016`, após `"conversions.meta_identity_updated"`; regra do arquivo: acrescenta no fim, nunca renomeia — `actions.ts:1-30`).
- **Teste:** unit espelhando `app/api/v1/contacts/[id]/unblock/route.test.ts` (molde medido: audita ação com ator/org/contato e SEM telefone — `:107-111`): atendente recebe 403; `support_readonly` barrado; manager marca; auditoria com os dois eventos novos.
- **Sabotagem:** trocar `"manager"` por `"agent"` — atendente marca e o teste de 403 acusa; reutilizar `contact.blocked` — o teste de nome (critério 9) acusa.

### Etapa 4 — Efeitos do marcar (ordem fixa, tudo na mesma rota)
- **O que muda (nesta ordem):** 1) `update contacts is_personal=true`; 2) cancela follow-ups; 3) cancela retornos avulsos; 4) saída de campanha; 5) prospecção vira pulada; 6) fecha conversas + tira do atendente; 7) auditoria + timeline.
- **Onde (trecho atual de cada efeito):**
  1. `update contacts set is_personal=true where organization_id+id` (padrão do unblock `:72-78`).
  2. Cancela `followup_enrollments` do contato com status em `STATUS_ALCANCADOS_PELO_OPT_OUT` (`lib/followup/reactivity.ts:85`: vivos + `dormente` + `coletando` — "parada total, inclusive dormente"), motivo proposto `pessoal`, sem reativação. Molde de cancelamento manual: `LIVE_STATUSES` em `app/api/v1/ai/followups/enrollments/[id]/cancel/route.ts:28` + auditoria `followup_enrollment.cancelled`.
  3. Cancela retorno avulso pendente (`cron_jobs` — promessas têm rota de cancel própria em `app/api/v1/ai/followups/promises/[id]/cancel/route.ts`; aqui é UPDATE direto por `contact_id` + auditoria `followup.cancelled`, que é a ação da promessa avulsa — `actions.ts:392-393` comentam a diferença fluxo × promessa).
  4. `update campaign_recipients set status='personal', eligibility_status='excluded', exclusion_reason=<novo motivo> where contact_id+org and status in (pending, queued, ...)` — espelha `fecharPorOptOut` (`resposta.ts:185-197`), com status/motivo próprios (D7). Motivo novo proposto em `MOTIVOS_DE_EXCLUSAO` (`tipos.ts:~60-...`, lista iniciada com `sem_telefone, telefone_invalido, opt_out, anonimizado, recusou_marketing`).
  5. `update prospecting_candidates set status='skipped', error=<motivo> where contact_id+org and status in ('new','queued')` — `skipped` é o estado "não chamar mais" (medido em `lib/prospecting/store.ts:432` e `:579`, `:593` documenta que `skipped` por outra razão não volta pela remarcação do operador — por isso o motivo próprio importa).
  6. Para cada conversa aberta do contato: `fn_service_status(p_status='closed')` via admin (molde em `app/api/v1/conversations/[id]/close/route.ts`, trecho lido até `:50`) + `fn_conversation_assign(p_to_user_id=null, p_reason='release', p_enforce_expected=false)` (molde em `.../[id]/release/route.ts:45-52`; `enforce=false` porque quem marca não é necessariamente o dono). Audita `conversation.closed` + `conversation.released` quando houver efeito (padrão do patch em `conversations/_handler.ts:529-547`).
  7. `audit({action:"contact.marked_personal"...})` + `emitLeadActivity` (`activity-emitter.ts:111`) com o negócio aberto do contato (roteamento contato→negócio: `emitAgentActivityForContact` em `lib/leads/agent-activity.ts:50-88` mostra o padrão; na rota usa-se o client Supabase em vez de `pg.Pool`), `reason` sem PII, tipos novos D5. Sem negócio aberto: só auditoria (D6).
- **Teste:** unit por efeito (7 testes): fluxo+dormente+coletando cancelados; retorno avulso cancelado; recipient com `status='personal'` (não `opted_out`); candidato `skipped`; conversas fechadas e sem dono; auditoria + timeline presentes.
- **Sabotagem por efeito:** cancelar só o fluxo e deixar o retorno — o retorno dispara depois e o teste acusa (critério 8); usar `opted_out` — a taxa de opt-out mexe e o teste acusa; apagar a linha do recipient em vez de marcar saída — a métrica perde o denominador e acusa.

### Etapa 5 — Desmarcar
- **O que muda:** `update is_personal=false` + `audit contact.unmarked_personal` + timeline `contact_unmarked_personal`. NADA mais (D8).
- **Onde:** mesma rota da Etapa 3 + mesmos moldes.
- **Teste:** desmarca → conversa volta ao inbox, negócio volta ao board, mensagens antigas intactas (critério 10).
- **Sabotagem:** limpar mensagens ao marcar — a volta vem vazia e o teste acusa (critério 10); reativar follow-up ao desmarcar — o teste de "não reativa" acusa.

---

## F3 — Entrada de mensagem (guarda, mas esconde, sem gerar nada)

### Etapa 6 — Pos-entrada retorna cedo + nascimento recusa (defesa dupla)
- **O que muda:** inbound de pessoal grava contato/conversa/mensagem e carimbo de não-lida (como hoje), mas não gera NADA: sem negócio, sem IA (fila e resposta), sem follow-up, sem campanha.
- **Onde:**
  - `aplicarEfeitosPosEntrada` (`lib/channels/pos-entrada.ts:134-171`): inserir o corte DEPOIS de `aplicarOptOut` (`:157`) e ANTES de `guardarOrigemDaPagina`/`abrirDemanda` (`:158-159`). **STOP continua na frente**: `ehPedidoDeOptOut` (`lib/opt-out/deteccao.ts`, via `:243`) roda primeiro e grava `is_blocked` como hoje — a ordem 1-2-3 documentada em `pos-entrada.ts:19-32` não muda, o corte entra entre o passo 1 e o 2. Corte pula: `avaliarCampanha`, `acelerarPipelineDeEventos` (follow-up quente, `:162-169`) e `pedirDespachoDoAgente` (`:419-445`, evento `ai_agent.dispatch_requested` — sem ele, nenhum turno roda: "não chama a IA (fila E resposta)").
  - `garantirLeadDaConversa` (`lib/leads/nascimento-do-lead.ts:257-277` — recusa bloqueado com `{criado:false, motivo:"contato_bloqueado"}` em `:277`): mesma recusa para pessoal (`contato_pessoal`). Defesa em profundidade: cobre o voice-agent que chama direto (`workers/voice-agent/index.ts:130`) e qualquer chamador futuro.
- **Teste:** unit `pos-entrada-pessoal.test.ts` (molde: `tests/unit/pos-entrada-*.test.ts`, citados em `pos-entrada.ts:32`): inbound de pessoal → mensagem gravada, zero eventos `ai_agent.dispatch_requested`, `garantirLeadDaConversa` devolve `contato_pessoal`; STOP de pessoal ainda bloqueia (ordem preservada).
- **Sabotagem:** mover o corte para ANTES do opt-out — STOP de pessoal não bloqueia e o teste de ordem acusa; tirar a recusa do nascimento — o worker de voz cria lead e o teste acusa.

---

## F4 — Esconder (E) + todos os caminhos da §3.4 (D), um por um

### Etapa 7 — Lista do inbox, busca, contador
- **O que muda:** conversa de pessoal não aparece na lista, na busca (nome, telefone E prévia) nem nas contagens.
- **Onde:**
  - `listConversationsHandler` (`conversations/_handler.ts:149-410`): excluir conversas cujo contato é pessoal. Primitiva medida: a busca já resolve ids de contato antes da query principal (`:328-369`, com teto `TETO_DE_CONTATOS_NA_BUSCA` `:47` + `idsQueCabemNaURL` `:73-84`). Prescrito: buscar ids pessoais da org (`select id from contacts where organization_id+is_personal=true`) e aplicar `.not("contact_id","in",...)` na query principal + `.eq("is_personal", false)` na subconsulta de contatos da busca (`:328-356`, que hoje só filtra `is_anonymized=false` em `:335`). Sem ids: filtro da prévia segue sozinho (mesmo padrão do `else` em `:365-369`).
  - `GET counts` (`conversations/counts/route.ts:111-121`, fábrica `countExact` com `organization_id` + auxiliares): aplicar a mesma exclusão nas 6 contagens (`fila, automatico, mine, all, closed, archived` — `:134-169`). Sem ela o badge diverge da lista — o defeito que este arquivo existe para impedir (`counts/route.ts:28-48`, vigiado por `tests/unit/badge-espelha-o-filtro.test.ts` citado em `:41-42`). Critério 3: ao marcar, a contagem cai exatamente nas não-lidas daquele contato.
  - `getConversationHandler` (`:416-441`): 404 para pessoal (D10 — some até por link direto).
  - `listMessagesHandler` (`messages/_handler.ts:266-331`): recusar quando a conversa é de pessoal (defesa; a conversa não é mais alcançável pela lista).
- **Teste:** critério 1 (marca com conversa ativa → lista sem ela), critério 2 (busca por nome/telefone/prévia → zero), critério 3 (contagem cai exatamente nas não-lidas).
- **Sabotagem:** tirar o `.not` da query principal mas manter o da subconsulta — busca por prévia acha a conversa escondida e o teste do critério 2 acusa; manter somando no counts — badge diverge da lista e o teste do critério 3 acusa.

### Etapa 8 — Board do funil (some da vista, continua por trás)
- **O que muda:** negócio aberto de pessoal não é listado; a linha continua no banco e volta ao desmarcar (decisão 2).
- **Onde:** `GET board` (`app/api/v1/pipelines/[id]/board/route.ts:464-470` — lê `crm_leads` por `pipeline_id`, menos arquivados): excluir leads cujo `contact_id` é pessoal (mesma primitiva de ids da Etapa 7). Os anexos (`withOwnerAgents :52, withScores :186, withConversas :258, withMarcadoresDoContato :338, withNextActions :376`) operam sobre a lista já filtrada — nada a mudar neles. `withMarcadoresDoContato` lê `contacts` (`:348-354`); incluir `is_personal` nesse select NÃO é alternativa ao filtro (o card já teria nascido).
- **Teste:** critério 4 (marca com negócio aberto → board sem o card, linha no banco; mensagem nova → nenhum negócio nasce — coberto pela Etapa 6).
- **Sabotagem:** apagar a linha (`delete`) em vez de excluir da leitura — a volta vem vazia e o teste acusa (critério 4).

### Etapa 9 — RAG e contexto do agente
- **O que muda:** conversa de pessoal nunca é ingerida; turno nunca a usa.
- **Onde:**
  - `ingestConversationsBatch` (`lib/ai/rag/ingest/conversations.ts:157-166` — filtro `usable_for_rag + resolved`): excluir conversas de contato pessoal (join/`not in` por `contact_id`). + Ao marcar (Etapa 4): `update conversations set usable_for_rag=false where contact_id` — sem isso, conversa já ingerida continua no acervo (o filtro do lote é `rag_review_status is null`, `:165`).
  - `getLeadContext` (`get-lead-context.ts:204-346`): incluir `is_personal` no select do contato (`:210-214`) e sinalizar no payload (`contact.is_personal`, ao lado de `is_blocked` em `:330-336`).
  - `checkGuards` (`workers/ai-response-worker.ts:627-657` — select com `contacts(... is_blocked, force_human)` em `:627`, `skip("contact_blocked")` em `:656`): incluir `is_personal` no select + `skip("contact_personal")` — espelha o `skip("force_human")` (`:657`, "mesma família de guard").
- **Teste:** conversa pessoal resolvida+marcada não entra no lote; turno para pessoal é `skip` antes de qualquer chamada.
- **Sabotagem:** excluir só do lote mas não zerar `usable_for_rag` ao marcar — conversa marcada depois de ingerida continua respondível e o teste acusa.

### Etapa 10 — Os 12 caminhos da §3.4 (checklist caminho a caminho)
Cada caminho: ler `is_personal` do contato e pular (`skipped`, sem efeito). Molde de "pular com motivo": `webPushInboundHandler` devolve `{status:"skipped", detail:...}` (`push.handler.ts:142-144,163-165`).

| # | caminho | onde (aberto agora) | corte prescrito |
|---|---|---|---|
| 1 | alerta no navegador | `useInboundMessageAlerts` (`hooks/notifications/useInboundMessageAlerts.ts:111-150`: `onChange` resolve `contactId` em `:136`, chama `entregarAviso` em `:140`) | após resolver `contactId`, ler `is_personal`; se pessoal, retorna sem `entregarAviso` (`lib/notifications/deliver.ts:19` — o choke; `emit.ts`/`sounds.ts` downstream não mudam) |
| 2 | inbox realtime | `useConversationsRealtime` (`hooks/inbox/useConversationsRealtime.ts:120`) + `useMessagesRealtime` (`hooks/inbox/useMessagesRealtime.ts:15`) via `useRealtimeChannel` | consequência da Etapa 7: a invalidação chega, a lista filtrada não mostra nada. Teste: INSERT realtime de pessoal não adiciona linha |
| 3 | push | `webPushInboundHandler` (`lib/notifications/push.handler.ts:149-166`, consome `message.received` em `:153`) → `montarPayloadDeInbound` (`push_payload.ts:15`) → `enviarPushDaOrg` (`web_push.ts:31`) | `skipped detail:"contato_pessoal"` no `handle` antes de `handleInbound` |
| 4 | follow-up quente | `followupReactivityHandler` (`lib/followup/reactivity.handler.ts:14-43`, consome `message.received` em `:17`, chama `applyReactivityEvent` em `:22` + `aplicarTextoNosFollowups` em `:26`) | `applyReactivityEvent` (`reactivity.ts:422`) lê `is_blocked` em `:461-466` — incluir `is_personal` no select e tratar igual (cancela tudo); `aplicarTextoNosFollowups` (`aplicar-inbound.ts:141`) retorna cedo |
| 5 | follow-up morno | `aplicarRespostasQueChegaram` (`lib/relogio/executar.ts:47-91`: varre `waiting_reply` em `:53-58`, lê última inbound em `:73-81`) | pular enrollment cujo contato é pessoal antes de `aplicarRespostaInbound` (`:87`) |
| 6 | campanha | `campanhaRespostaHandler` (`lib/campanhas/resposta.handler.ts:19-58`, consome `message.received` — evento que nasce no TRIGGER de `messages`, `:5-7`) → `aplicarRespostaNaCampanha` (`resposta.ts:109-157`) | retornar `{atribuiu:false, optOut:0}` para pessoal (não carimba `replied_at`); `fecharPorOptOut` (`:171-198`) não é tocado (lê `is_blocked`) |
| 7 | Jev | `medirClima` (`lib/ai/decisao/clima.ts:103`) → `observarPedidos` (`pedidos.ts:277-282`, early-return quando não há o que perguntar em `:284-286`) / `avisarAEquipe` (`pedidos.ts:456`) → `aiHandoffFromSentimentHandler` (`workers/ai-handoff-from-sentiment.handler.ts:18-20`) | com a Etapa 6 o turno não roda e o Jev do turno não é perguntado; belt: `observarPedidos` retorna `nada` para contato pessoal (mesmo padrão do early-return em `:284`) — **corpo do chamador (`processSentiment`) NÃO aberto, ver §12** |
| 8 | webhook/automação | `automationRulesHandler` (`lib/automation/engine.handler.ts:8-18`, assina `TRIGGER_EVENTS` em `:15`, delega a `runAutomationForEvent` em `:17`) → `executeCallWebhook` (`lib/automation/actions/call-webhook.ts:297`) | `handle` resolve o contato do evento e devolve `skipped` para pessoal — evento de pessoal não casa com regra |
| 9 | distribuição | `runRoutingWorker` (`lib/routing/worker.ts:74-128`, puxa `ROUTING_EVENT_TYPE` pendentes em `:92-99`) + `decideRouting` (`lib/routing/decide.ts:75`) | conversa de pessoal não distribui (pulo no `processEvent` por contato pessoal — **corpo do `processEvent` NÃO aberto, ver §12**) |
| 10 | métricas | `taxasDaCampanha` (`lib/campanhas/metricas.ts:73-82`) + contagens (Etapa 7) | status `personal` não entra em enviados/entregues/respondidos — taxas seguem por construção; **função SQL de marcação de mensagem e "uso da plataforma" NÃO localizadas, ver §12** |
| 11 | MCP leitura/escrita | ver F6 (Etapa 12) | — |
| 12 | ligação | ver F7 (Etapa 13) | — |
- **Teste (critério 6):** inbound para marcado → nenhum trabalho enfileirado, nenhuma resposta, nenhum negócio; nenhum alerta, push, follow-up, carimbo de campanha, Jev, webhook ou redistribuição. Um teste por caminho (unit no handler com contato pessoal fixture).
- **Sabotagem por caminho:** ligar cada efeito de volta — o teste daquele efeito acusa (a spec pede literalmente isso).

---

## F5 — Envio recusado (F) + MCP (G) + ligação (H)

### Etapa 11 — Toda rota de envio recusa (sem exceção para gerente)
- **O que muda:** `sendMessageHandler` recusa pessoal no mesmo ponto do bloqueio.
- **Onde:** `app/api/v1/messages/_handler.ts:473-481` (`if (c.contacts?.is_blocked) throw 403 "Contato bloqueou o atendimento."`) — trecho atual do select em `:399-400` (`contacts:contact_id(phone_number, wa_identity, wa_lid, is_blocked)`) e tipo `Joined` em `:463-468`. Acrescentar `is_personal` nos dois + `if (c.contacts?.is_personal) throw 403` com mensagem própria (proposta: "Contato marcado como pessoal."), sem vazar dado (spec §3.3). Este handler é a porta de saída de TODOS os chamadores (`:394-416` documenta REST+MCP+bearer).
  - Cartão de contato: o ramo `input.type === "contact"` relê o contato compartilhado em `:599-624` (checa `is_anonymized` `:625` e `is_blocked` via `row.is_blocked` `:623`) — recusar pessoal ali também.
  - `readStopFlags` (`lib/agent-engine/guardrails/before-send.ts:1372-1385` — `select (is_blocked or force_human) as stopped` em `:1381`, e `select is_blocked as stopped` no ramo `humanMeetingCommand` em `:1380`): incluir `or is_personal` nos DOIS (pessoal não recebe nem via encontro).
- **Teste:** critério 7 — tentar enviar para marcado como atendente, gerente e admin: 403 nos três papéis.
- **Sabotagem:** liberar para gerente (`if role==manager skip`) — o teste acusa (a spec pede literalmente essa sabotagem).

### Etapa 12 — MCP: leitura exclui, escrita recusa (ferramenta por ferramenta)
- **Onde (arquivos abertos):**
  - `lib/mcp/tools/contacts.ts`: `crm_search_contacts` (`:27-94`, chama `listContactsHandler` em `:37` — exclusão automática pela Etapa 13) e `crm_get_contact` (`:100-158`): recusar pessoal no tool com `{permitido:false, motivo:"contato_pessoal", mensagem:...}` — molde do #2158 (`:124-132`, recusa com motivo em texto para o modelo). `crm_propose_contact_field` (`:189-260`): sem mudança (D9).
  - `lib/mcp/tools/conversations.ts`: `crm_list_conversations` (`:55-...`, chama `listConversationsHandler` em `:66` — exclusão automática), `crm_get_conversation` e `crm_get_conversation_history` (chamam `getConversationHandler`/`listMessagesHandler` — recusa automática pelas Etapas 7/11): conferir motivo amigável na ferramenta.
  - Nomes medidos por grep (corpos NÃO abertos — ver §12): `crm_list_leads`, `crm_get_lead`, `crm_create_lead`, `crm_update_lead`, `crm_move_lead_stage`, `crm_retomar_lead` (`leads.ts:103,147,198,272,316,365`), `crm_send_whatsapp_message` (`messages.ts:40-41`), `crm_start_conversation_and_send` (`start-conversation.ts:77-78`).
- **Regra:** leitura (lista, busca, ficha, histórico) exclui pessoal; escrita (criar lead, mover, retomar, enviar, abrir conversa) recusa pessoal. `crm_send_whatsapp_message` herda a recusa do `sendMessageHandler` (Etapa 11); `crm_start_conversation_and_send` precisa de recusa explícita (abrir conversa não passa pelo send).
- **Teste:** cada ferramenta com contato pessoal fixture: leitura não lista; escrita devolve recusa.
- **Sabotagem:** deixar `crm_get_contact` abrir ficha de pessoal — vaza telefone/e-mail para o assistente externo e o teste acusa.

### Etapa 13 — Lista de Contatos exclui por padrão + filtro "Pessoais"
- **O que muda:** `listContactsHandler` exclui pessoais por padrão; `?pessoais=true` lista SÓ pessoais (tela do filtro + desmarcar).
- **Onde:** `listContactsHandler` (`contacts/_handler.ts:92-280`) — `.eq("is_personal", false)` após o filtro de fusão (`:152`); parâmetro novo no `contactListQuerySchema` (`lib/schemas/contacts.ts:128-167`) — proposto `pessoais: z.coerce.boolean().default(false)` (quando true, inverte para `.eq("is_personal", true)`).
- **Teste:** lista padrão sem pessoais; `?pessoais=true` só pessoais; MCP search herda.
- **Sabotagem:** default invertido — a lista de Contatos esvazia para todo mundo e o teste acusa.

### Etapa 14 — Ligação: mesmo tratamento do bloqueado, antes da IA e antes de tocar
- **O que muda:** chamada de pessoal OU bloqueado é gravada (escondida), desligada, sem IA, sem negócio, sem tocar, sem alerta.
- **Onde:** `handleStasisStart` (`workers/voice-agent/index.ts:65-150`): após `resolveOrCreateCallerContact` (`:85`, que NÃO lê `is_blocked` — achado da spec §3.5, `resolve-caller.ts:26-58`) e após o INSERT em `voice_calls` (`:102-115`, a chamada gravada), ANTES de `garantirLeadDaConversa` (`:128-143`, que já recusa bloqueado — `nascimento-do-lead.ts:277` — e passa a recusar pessoal pela Etapa 6) e ANTES de `continueDialplan` (`:149`): ler `is_blocked/is_personal` do contato; se qualquer um, `hangupChannel(channel.id, "normal")` (molde em `:74,119`) + `end_reason` próprio (`end_reason` é livre — `index.ts:19-20`: proposto `contato_pessoal` / `contato_bloqueado`).
  - "A de pessoal fica ESCONDIDA, a de bloqueado aparece como recusada": a tela de chamadas filtra pessoal por `contacts.is_personal` (join como o do inbox) e mostra bloqueado com o `end_reason` — **tela `app/app/calls/_client.tsx` NÃO aberta, ver §12**.
- **Teste:** critério 11 — contato pessoal liga: IA não atende, ninguém recebe, nenhum negócio, chamada registrada (linha em `voice_calls` com `end_reason='contato_pessoal'`).
- **Sabotagem:** deixar `continueDialplan` rodar — a IA de voz atende e o teste acusa.

---

## F6 — Tela (I)

### Etapa 15 — Botão, selo, filtro (3 lugares, sem tela nova)
- **O que muda:** botão marcar/desmarcar no cabeçalho da conversa E na ficha; selo "Pessoal" lido da coluna; filtro "Pessoais" em Contatos. Sem porta no menu (`lib/navigation/registry.ts` não é tocado — botão em tela existente).
- **Onde:**
  - Cabeçalho: `ConversationHeader` (`components/inbox/ConversationHeader.tsx:80-108` — recebe `conversation: ConversationWithContact`, já usa `conversation.contacts` em `:103`; hooks de ação como `useClaimConversation` em `:89`). Botão novo + hook novo `hooks/contacts/usePersonalContact.ts` espelhando `useUnblockContact` (`hooks/contacts/useUnblockContact.ts:17-29`: `useMutation` + invalida `["contact", id]`, `["contacts"]`, `["conversations"]`). Visível para gerente+ (`ROLE_RANK`, padrão da ficha em `[id]/_client.tsx`: `ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin` — aqui `>= ROLE_RANK.manager`).
  - Ficha: `ContactDetailClient` (`app/app/contacts/[id]/_client.tsx` — importa `useUnblockContact` em `:27`, usa em `:80`, selos `is_blocked`/`is_anonymized` + botão "Desbloquear" com `AlertDialog` e gate `isAdmin`). Espelhar o bloco para pessoal com gate de gerente (D3) — **o botão Desbloquear exige admin; o de pessoal exige manager: dois gates lado a lado, cada um com seu motivo em comentário**.
  - Selo na lista: `ContactsTable` (`components/contacts/ContactsTable.tsx:226-238` — `Badge "Bloqueado"` de `c.is_blocked` em `:227`, com o aviso de que selo se lê de coluna nunca de tag em `:230-233`). Acrescentar `Badge "Pessoal"` de `c.is_personal` (critério 5: editar etiquetas não apaga o selo).
  - Filtro: `ContactsListClient` (`app/app/contacts/_client.tsx:51-86` — estados `search/tags/tagMode/source` + `filters` via `useContactList` em `:86`): estado `soPessoais` + UI no barra de filtros (`:155-...`) passando `pessoais` (Etapa 13).
- **Teste:** critério 5 (selo visível; edita etiquetas; selo fica) + teste de gate (atendente não vê o botão) + e2e de clique marcar→some→filtro Pessoais→desmarcar→volta (critério 10 pela tela).
- **Sabotagem:** ler o selo da etiqueta (`tags`) em vez da coluna — some ao editar e o teste acusa (a spec pede literalmente essa sabotagem).

---

## F7 — Provas, fragmento, destino, pré-voo (J+K)

### Etapa 16 — Os 11 critérios como matriz teste × sabotagem
| critério | teste (arquivo proposto em `tests/unit/`) | sabotagem que deixa vermelho |
|---|---|---|
| 1 lista some | `contato-pessoal-lista.test.ts` | tirar o `.not` da lista |
| 2 busca zera (nome, telefone, prévia) | mesmo + `contato-pessoal-busca.test.ts` | filtrar só a prévia, deixar ids passarem |
| 3 contagem cai nas não-lidas | `contato-pessoal-contagem.test.ts` | manter somando no counts |
| 4 board esconde, linha fica, nada nasce | `contato-pessoal-funil.test.ts` | `delete` em vez de excluir da leitura |
| 5 selo de coluna | `contato-pessoal-selo.test.ts` | selo lido da etiqueta |
| 6 os 12 caminhos calam | 1 teste por handler (§Etapa 10) | ligar cada efeito de volta |
| 7 envio recusa em todo papel | `contato-pessoal-envio.test.ts` (atendente, gerente, admin) | liberar gerente |
| 8 cancela fluxo+retorno, saída de campanha, pula prospecção | `contato-pessoal-marcar-efeitos.test.ts` | cancelar só o fluxo |
| 9 auditoria + timeline, eventos novos | `contato-pessoal-auditoria.test.ts` (nomes exatos D4/D5) | reutilizar eventos de bloqueio |
| 10 desmarcar volta tudo, histórico intacto | `contato-pessoal-volta.test.ts` | limpar mensagem ao marcar |
| 11 ligação recusada e registrada | `contato-pessoal-voz.test.ts` | deixar a IA atender |
| isolamento 2 orgs | `contato-pessoal-isolamento.test.ts` (org A marca; org B com mesmo telefone nada muda — molde: `tests/invariants/envio-nao-alcanca-conversa-de-outro-tenant.test.ts`, citado em `messages/_handler.ts:415`) | filtro sem `organization_id` |

### Etapa 17 — Prova pela tela (como, com esta máquina limitada)
- **Limitação medida:** daemon Docker PARADO nesta máquina (`docker ps` → `failed to connect ... dockerDesktopLinuxEngine`). Consequência: `pnpm test:db` (Postgres efêmero) e `pnpm test:e2e` (app + banco semeado) NÃO rodam aqui.
- **O que roda aqui:** `pnpm gov:verify` (typecheck + lint + `lint:channels` + `lint:role-rank` + `test:unit`), teste por teste (`pnpm vitest run <arquivo>`).
- **Prova de tela:** (a) ligar o Docker Desktop e rodar `pnpm test:e2e` com o roteiro marcar→some→Pessoais→desmarcar→volta (dois contatos de teste, prints); ou (b) delegar ao CI (`e2e` é check obrigatório — ver AGENTS.md). `curl` não conta como prova de UX. Sem `pnpm test:db` verde + prova visual, o PR não declara pronto (DoD).
- **Par agente×direto** (doutrina `docs/doctrine/prova-em-par.md`): o caso de aceite do Jev/campanha mede o par (tela + ferramenta chamada direto com o mesmo texto) e só conta quando os dois concordam.

### Etapa 18 — Fragmento `.changes`, destino, pré-voo
- **Fragmento:** `.changes/contato-pessoal-sai-da-operacao.md` — molde medido (`.changes/2026-10-03-nos-de-acao-no-followup.md`): front-matter `impacto`/`secao`/`titulo` + corpo em pt-BR + `Contribuição de @...`. `impacto: capacidade_nova` (valores válidos em `docs/doctrine/versionamento.md:126`: `nada_mudou | capacidade_nova | exige_acao`). Conferir com `pnpm release:conferir`.
- **Destino: núcleo** — opera com zero extensões; nenhuma jornada do núcleo passa a depender de extensão; sem SDK/marketplace.
- **Pré-voo:** `pnpm gov:verify` zerado; `pnpm test:db` + `pnpm test:e2e` (com Docker); sem toque em `Dockerfile*`/`docker-compose*`/`hostgator-setup-kit/` → `pnpm test:shell` dispensado; migration com `-- manifest:` + apêndice no baseline (tripla da casa); RLS testada (tabela tenant-aware); prova visual (Etapa 17); Living System Checklist (`docs/doctrine/sistema-vivo.md`).

---

## Tamanho e divisão do PR (resposta ao item 5)

**Contagem estimada: ~40 arquivos** (sem testes: ~28; testes unit novos: ~12).
- Banco: 2 (migration nova + `baseline.sql`).
- Tipos/schemas: 5 (`lib/types/contacts.ts`, `contacts/_handler.ts` SELECT_COLS, `conversations/_handler.ts` SELECT_COLS, `hooks/.../useConversationsRealtime.ts` ContactSummary, `lib/schemas/contacts.ts`, `lib/campanhas/tipos.ts`, `lib/leads/activity-vocabulary.ts` — 7 na prática).
- Rotas: 1 nova (`contacts/[id]/personal/route.ts`) + 1 teste.
- Guards/entrada: 5 (`pos-entrada.ts`, `nascimento-do-lead.ts`, `ai-response-worker.ts`, `before-send.ts`, `get-lead-context.ts`).
- Esconder: 5 (`conversations/_handler.ts`, `counts/route.ts`, `contacts/_handler.ts`, `board/route.ts`, `rag/ingest/conversations.ts`).
- Envio: 1 (`messages/_handler.ts`).
- Consumidores §3.4: 8 (`push.handler.ts`, `reactivity.ts`, `aplicar-inbound.ts`, `relogio/executar.ts`, `campanhas/resposta.ts`, `automation/engine.handler.ts`, `routing/worker.ts`, Jev `pedidos.ts`).
- MCP: 5 (`contacts.ts`, `conversations.ts`, `leads.ts`, `messages.ts`, `start-conversation.ts`).
- Voz: 1 (`voice-agent/index.ts`) + tela de chamadas.
- Tela: 6 (`ConversationHeader.tsx`, `usePersonalContact.ts`, `[id]/_client.tsx`, `ContactsTable.tsx`, `contacts/_client.tsx`, + teste).
- Audit: 1 (`actions.ts`). Fragmento: 1.

**O PR precisa ser dividido em 3 fatias** (o Rafael revisa uma por vez; cada fatia verde sozinha):
- **Fatia 1 — banco + marcar/desmarcar** (Etapas 1–5 + 18 parcial): migration, tipos, rotas, audit, timeline. Revisável sem saber do resto.
- **Fatia 2 — esconder + calar** (Etapas 6–11): entrada, lista/busca/contas/board/RAG/contexto/guards, envio, os 12 caminhos.
- **Fatia 3 — MCP + voz + tela** (Etapas 12–17): ferramentas, ligação, botões/selo/filtro, provas e2e.
- Ordem obrigatória: 1 → 2 → 3 (2 usa a coluna e as rotas; 3 usa os filtros).

---

## 12. §12 fechado em 03/10/2026 (nada ficou para depois)

1. **Trigger 0397, corpo medido:** `supabase/migrations/20260923230000_0397_roteiro_encerra_com_humano_e_prazo.sql` + `MANIFEST.md:437`: gatilho `trg_contato_encerra_roteiro_com_humano_ou_opt_out` só dispara na virada false→true de `force_human` ou `is_blocked`. Marcar pessoal não vira nenhuma das duas → o gatilho NÃO pega. Decisão: ao marcar, o código da rota cancela o roteiro `coletando` do contato pelo mesmo caminho do cancelamento de follow-up (não se estende o trigger: trigger é para invariante de dado, roteiro de pessoal é efeito de ação de tela).
2. **CHECK 0375 + status novo `personal` (vale a D7, não o reuso):** `campaign_recipients_status_check` (`supabase/baseline.sql:36211-36214`) NÃO aceita `personal` hoje. A migration 0534 (a mesma do `is_personal`) troca a trava para incluir `personal`, idempotente (`drop constraint if exists` + `add`, no padrão da 0375), com apêndice no baseline. Dados atuais cabem na trava nova (só acrescenta valor). `personal` entra em `STATUS_DO_DESTINATARIO` e `TERMINAIS_DE_DESPACHO` (`lib/campanhas/tipos.ts:24-56`); o invariante `vocabulario-banco-x-typescript` (`tests/invariants/vocabulario-banco-x-typescript.test.ts`) tem de continuar verde.
3. **Corpos MCP, abertos:** `crmListLeads`→`listLeadsHandler` (`leads.ts:102-136`), `crmGetLead`→`getLeadHandler` (`:146-164`), `crmSendWhatsappMessage`→`sendMessageHandler` (`messages.ts:40-97`), `crmStartConversationAndSend`→`openSharedContactConversation`+`sendMessageHandler` (`start-conversation.ts:90-157`). Conclusão medida: ferramentas que delegam aos handlers compartilhados herdam a regra de graça; pontos próprios só em `openSharedContactConversation` (`lib/messaging/open-shared-contact-conversation.ts`) e nas leituras diretas (`crmGetContact`, `crmGetConversation`, `crmGetConversationHistory`, `crmGetLead`). `lib/automation/start-conversation.ts` exporta `sessaoProntaParaEnvio` (`:20`) + `ensureConversation` (`:46`) — mesmo ponto único.
4. **Corpos de consumidores, abertos:** `processEvent` (`lib/routing/worker.ts:133-183`: lê conversa, pula se status fora de open/pending/claimed/ai_handling — pulo de pessoal entra após a leitura, `markDone` com motivo próprio); `observarPedidos` (`lib/ai/decisao/pedidos.ts:277-330`, early-return `nada` — pessoal retorna `nada` antes de perguntar); `fn_mark_conversation_message` (`supabase/baseline.sql:5014-5029`, soma não-lida no inbound — sem mudança, o filtro é na leitura); uso da plataforma (`app/api/v1/admin/usage/route.ts:122`, conta `messages` por org — exclui pessoal); `useMessagesRealtime` (`hooks/inbox/useMessagesRealtime.ts:15`, assina `messages` da conversa — invalidação chega, lista filtrada não mostra); `emitNotification` (`lib/notifications/emit.ts:39`) + `playSound` (`lib/notifications/sounds.ts:50`) — downstream do `entregarAviso`, sem mudança.
5. **Tela de chamadas, aberta:** `/app/calls` lê `/api/v1/calls` (outra tabela-conceito: `useCallsQuery.ts:53`); rota de histórico de voz (`voice/calls/history`) sem consumidor em tela — o teste cobre a saída da rota. `ConversationHeader` lido até a linha 120 (contato via `conversation.contacts`); resto medido na implementação do botão (Etapa 15 já cita âncoras).
6. **Concorrência de migration, diffs abertos hoje:** 13 PRs abertos tocam `supabase/migrations/` (números 0428-0432, 0487, 0491, 0492, 0502, 0504, 0510, 0511, 0522, 0523, 0526×2, 0530) — nenhum usa 0534. Maior na `origin/main` nova: 0533. **0534 livre**, confirmado contra main + diffs.
7. **Deriva da base:** `main` trazida para a branch nesta tarefa (merge sem conflito). Âncoras reconferidas após o merge: `contacts/_handler.ts` SELECT_COLS `:36-37`, lista `:127`, fusão `:137`; `conversations/_handler.ts` lista `:177`; board `:468`. Implementador remede o trecho exato ao tocar (regra permanente do plano).
