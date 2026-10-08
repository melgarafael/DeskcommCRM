# Spec 21 — Contato pessoal: esconder e inutilizar

> Doutrina: [`sistema-vivo.md`](../doctrine/sistema-vivo.md) (invariantes 3, 4 e 7: log visível, nada fora do radar, todo laço se fecha).
>
> Base medida: leitura direta dos arquivos citados, em 03/10/2026.
> Revisão cega da v2: 14 pontos confirmados, 5 endereços corrigidos (ver rodapé). Regra do dono: nunca se responde contato pessoal por dentro do CRM.

---

## 1. O problema é UM só

Quem usa o mesmo número para vender e para a vida — família, fornecedor, amigo — entrega os dois mundos para a mesma operação. A IA assume conversa que era de gente, o inbox mistura trabalho com vida, e o funil ganha card que nunca foi oportunidade. Inbox poluído, IA intrometida e funil sujo são **sintomas disso**, não problemas separados.

### Medido no código

| fato | onde |
|---|---|
| marca de pessoal **não existe** em contato nenhum | o select da lista (`app/api/v1/contacts/_handler.ts`) lista as colunas sem nenhuma marca de pessoal |
| o inbox lista por organização e não sabe esconder ninguém | `app/api/v1/conversations/_handler.ts` fixa `organization_id`; o filtro de não-lidas é `unread_count_for_assignee` |
| a busca casa por nome, telefone e prévia, via ids de contato | `app/api/v1/conversations/_handler.ts` (termo seguro, `ilike`, teto de ids) |
| a contagem **ignora a busca de propósito** | `app/api/v1/conversations/counts/route.ts` (repetir a busca ali criaria segunda régua que diverge) |
| o board lista os negócios do funil, menos arquivados | `app/api/v1/pipelines/[id]/board/route.ts` (leitura de `crm_leads` por `pipeline_id`) |
| a IA já sabe recusar bloqueado, humano-forçado e silenciado — pessoal ela não conhece | função `checkGuards` em `workers/ai-response-worker.ts` (pula `is_blocked` e `force_human`; pula silêncio pós-handoff) |
| o caminho de entrada grava bloqueio ANTES do lead, nessa ordem de propósito | função `aplicarEfeitosPosEntrada` em `lib/channels/pos-entrada.ts` (inverter faz quem pediu para sair virar oportunidade) |
| o RAG só ingere conversa resolvida e marcada, anonimizada e com guarda de vazamento | `lib/ai/rag/ingest/conversations.ts` (filtro `usable_for_rag` + `resolved`, anonimização, isolamento por organização) |
| o contexto do lead lê bloqueio direto da fonte, sem cache | `lib/agent-engine/edge/crm/get-lead-context.ts` |
| escrita sensível em contato já exige gerente | `app/api/v1/contacts/merge/route.ts` usa `requireRole("manager")` |
| selo se lê de coluna, nunca de tag | `components/contacts/ContactsTable.tsx` (tag `cliente` é removível à mão e pelo PATCH, então selo por tag mentiria) |

---

## 2. Decisões fechadas

> Decididas pelo dono da instalação em 03/10/2026. Não se reabre sem ele.

| # | decisão | consequência |
|---|---|---|
| **1** | **só gerente e dono marcam e desmarcam** | no código: `requireRole("manager")` (o rank cobre gerente e admin; atendente não esconde conversa da operação) |
| **2** | **o negócio aberto some da vista mas continua por trás, e volta ao desmarcar** | esconder não é apagar: o board deixa de listar, a linha continua no banco, desmarcar relista |
| **3** | **contato pessoal fica inutilizado: nenhum envio pelo CRM, nem manual** | o veto segue o padrão do bloqueio que `sendMessageHandler` em `app/api/v1/messages/_handler.ts` já aplica para `is_blocked`, mas em coluna e eventos próprios (ver §3.1 e §3.6): `is_blocked` continua significando só descadastro/STOP |

---

## 3. O contrato

### 3.1 Onde a marca fica

- Tabela `contacts`, coluna boolean nova com prefixo `is_`, no padrão de `is_blocked` e `is_anonymized`. É coluna nova de propósito: reutilizar `is_blocked` misturaria descadastro com pessoal na auditoria e nas regras.
- Valor padrão desligado. Tripla da casa: arquivo novo em `supabase/migrations/` com linha `-- manifest:` no cabeçalho, apêndice idempotente em `supabase/baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

### 3.2 Marcar e desmarcar

- Só gerente e dono (`requireRole("manager")`). Marcar grava quem marcou e quando; desmarcar grava quem desmarcou e quando.
- Marcar cancela follow-up de fluxo pendente (mesmo comportamento do bloqueio: parada total, inclusive dormente).
- Marcar cancela retorno avulso pendente. Hoje o retorno avulso só tem veto na hora do envio; para pessoal a spec decide: cancela na hora de marcar, para não deixar lixo pendente.
- Marcar tira o contato da campanha com efeito de saída (marca saída sem remover a linha, como o pedido de saída faz).
- Candidato de prospecção nativa que virar pessoal vira pulado (a prospecção não tem estado de bloqueio; pulado é o estado que diz não chamar mais).
- A marca fica no contato e vale para WhatsApp, Instagram e Facebook juntos: um contato tem N conversas, uma por sessão (`fn_upsert_wa_conversation`, uma linha por organização + contato + sessão). Os robôs de envio já leem o contato a cada envio, então o veto vale nos três canais sem marca por conversa.

### 3.3 Envio: tudo recusado

- Toda rota de envio recusa contato marcado, manual ou automática, no mesmo ponto onde `sendMessageHandler` já recusa bloqueado.
- Sem exceção para gerente. Gerente marca e desmarca, mas não envia para marcado.
- Erro padrão de envio recusado, sem vazar dado do contato.

### 3.4 Resposta: guarda, mas esconde — e não gera nada

- A resposta do pessoal entra pelo ingest normal (contato e conversa gravados, carimbo de não-lida atualizado pela função SQL de marcação de mensagem).
- Depois de gravada, ela some de tudo: inbox, funil, busca, contadores, relatórios, base de busca da IA e contexto do agente.
- **Não cria negócio**: mensagem nova de marcado não abre negócio no funil (o aberto continua por trás e volta ao desmarcar, decisão 2).
- **Não chama a IA**: nenhum trabalho é enfileirado e nenhum turno roda para marcado.
- Cada caminho que reage a mensagem nova ignora pessoal:
  - alerta no navegador (`useInboundMessageAlerts` → `entregarAviso` em `lib/notifications/deliver.ts` → `emitNotification` em `lib/notifications/emit.ts` + `playSound` em `lib/notifications/sounds.ts`);
  - inbox em tempo real (`useConversationsRealtime` em `hooks/inbox/useConversationsRealtime.ts` + `useMessagesRealtime` em `hooks/inbox/useMessagesRealtime.ts`, via `useRealtimeChannel`): a invalidação chega, mas a lista filtrada não mostra nada;
  - push no celular (`webPushInboundHandler` → `montarPayloadDeInbound` em `lib/notifications/push_payload.ts` → `enviarPushDaOrg` em `lib/notifications/web_push.ts`);
  - follow-up quente (`aplicarEfeitosPosEntrada` → `acelerarPipelineDeEventos` → `followupReactivityHandler` em `lib/followup/reactivity.handler.ts` / `applyReactivityEvent` em `lib/followup/reactivity.ts` / `aplicarTextoNosFollowups` em `lib/followup/aplicar-inbound.ts`) e morno (`aplicarRespostasQueChegaram` em `lib/relogio/executar.ts`);
  - campanha (`campanhaRespostaHandler` → `aplicarRespostaNaCampanha`: resposta de pessoal não carimba nada);
  - Jev (`processSentiment` → `medirClima` em `lib/ai/decisao/clima.ts` → `observarPedidos`/`avisarAEquipe` em `lib/ai/decisao/pedidos.ts` → `aiHandoffFromSentimentHandler` em `workers/ai-handoff-from-sentiment.handler.ts`): pessoal não entra no caminho e não cria item de revisão;
  - webhook externo (`automationRulesHandler` → `executeCallWebhook`: evento de pessoal não casa com regra);
  - distribuição (`runRoutingWorker`/`decideRouting`: conversa de pessoal não distribui);
  - métricas (`taxasDaCampanha`, contagens, função SQL de marcação, uso da plataforma): pessoal não soma.
  - ferramentas externas (`lib/mcp/tools/`: leitura exclui pessoal; escrita recusa pessoal): o assistente externo não lê nem escreve para pessoal.
  - ligação (`workers/voice-agent`): chamada de pessoal recebe o mesmo tratamento de bloqueado — ver achado e regra abaixo.
- Contador no título da aba não existe (nenhum `document.title` escrito em `app/`, `hooks/`, `components/` ou `lib/`), então não há nada para esconder ali.
- Tudo só volta a aparecer ao desmarcar, com o histórico inteiro.

### 3.5 Ligação: mesmo tratamento do bloqueado

- Achado medido em 03/10/2026 (`workers/voice-agent/index.ts`, função `handleStasisStart`): hoje o contato bloqueado NÃO é recusado na ligação. O caminho resolve o contato (`resolveOrCreateCallerContact` em `lib/voip/resolve-caller.ts`, que não lê `is_blocked`), grava a linha em `voice_calls`, recusa só o negócio (`garantirLeadDaConversa` recusa bloqueado) e segue: devolve o controle ao dialplan (`continueDialplan`) e a IA de voz atende pelo agente padrão. É defeito do bloqueio também, registrado aqui.
- Regra da spec: pessoal E bloqueado são recusados no mesmo ponto, antes da IA e antes de tocar. Ao identificar o contato da chamada, se bloqueado ou pessoal: grava a chamada (escondida, como a mensagem), desliga (`hangupChannel`), sem IA, sem negócio, sem tocar para atendente, sem alerta.
- A chamada gravada some do histórico de voz e só volta ao desmarcar (pessoal) ou desbloquear (bloqueado).

### 3.6 Registro: auditoria e timeline

- Auditoria pelo emissor `audit` (`lib/audit/index.ts`), lista `AUDIT_ACTIONS` (`lib/audit/actions.ts`; regra: acrescenta no fim, nunca renomeia).
- Eventos novos no fim da lista, no padrão de `contact.blocked` (emitido na pós-entrada) e `contact.unblocked` (emitido na rota de desbloqueio): um para marcar, outro para desmarcar, com quem fez e quando. São eventos novos de propósito, para não misturar com descadastro.
- Quem marcou e quando fica só na auditoria + timeline, sem coluna extra no contato.
- Timeline pela função `emitLeadActivity` (`lib/leads/activity-emitter.ts`): organização, contato, tipo, ator e motivo sem dado pessoal.

### 3.7 Tela e atendimento em curso (decidido pelo dono em 03/10/2026)

- Botão marcar/desmarcar no cabeçalho da conversa e na ficha do contato; filtro "Pessoais" na lista de Contatos. Botão em tela existente não cria tela nova e não exige porta no menu.
- Ao marcar, a conversa fecha e sai do atendente, sem nada pendurado.

---

## 4. Critérios de aceite

1. Marca contato com conversa ativa e lê a lista: a conversa não está. Sabotagem: tirar o filtro da lista — o teste quebra.
2. Com a conversa marcada, busca por nome, telefone e prévia: zero resultados. Sabotagem: filtrar só a prévia e deixar os ids passarem — o teste acusa.
3. Marca com não-lidas pendentes e lê a contagem: o número cai exatamente nas não-lidas daquele contato. Sabotagem: manter somando — o badge diverge da lista.
4. Com negócio aberto, marca: o board não lista, a linha continua no banco; mensagem nova: nenhum negócio nasce. Sabotagem: apagar a linha em vez de esconder — a volta vem vazia e acusa.
5. Marca e abre Contatos: selo "Pessoal" visível; edita as etiquetas: o selo fica. Sabotagem: ler o selo da etiqueta — some ao editar e acusa.
6. Manda inbound para marcado: nenhum trabalho enfileirado, nenhuma resposta, nenhum negócio; nenhum alerta, push, follow-up, carimbo de campanha, análise do Jev, webhook ou redistribuição. Sabotagem por caminho: ligar cada efeito de volta — o teste daquele efeito acusa.
7. Tentar enviar para marcado (qualquer papel): recusado. Sabotagem: liberar para gerente — o teste acusa.
8. Marcar cancela fluxo e retorno pendentes, tira da campanha com saída e pula candidato de prospecção. Sabotagem: cancelar só o fluxo — o retorno dispara depois e acusa.
9. Auditoria guarda os dois eventos novos e a timeline guarda o registro. Sabotagem: reutilizar os eventos de bloqueio — o teste de nome acusa.
10. Filtra pessoais, desmarca: conversa de volta no inbox e negócio de volta no board, mensagens antigas todas lá. Sabotagem: limpar mensagem ao marcar — a volta vem vazia e acusa.
11. Contato pessoal liga: a IA não atende, ninguém recebe a chamada, nenhum negócio nasce, a chamada fica registrada. Sabotagem: deixar a IA atender — o teste acusa.

---

## 5. Fora do escopo

- Ler o celular ou importar agenda. Marca manual, uma a uma, por gerente ou dono.
- Apagar qualquer coisa. Marcar esconde; tudo continua no banco.
- Bloquear no WhatsApp ou mudar o STOP. Descadastro continua separado, com sentido próprio.
- Anonimização LGPD. `is_anonymized` e o trabalho de privacidade continuam como estão.
- Regra automática para adivinhar quem é pessoal. Só pessoa marca.
- Permissão nova. O teto é gerente/dono via rank existente.

---

## 6. O que a v4 muda (03/10/2026, segunda rodada de revisão)

Regra nova do dono: contato marcado fica inutilizado (nenhum envio, nem manual). Mais 6 pontos:

1. **Ferramentas externas (MCP) entram na regra.** Medido em `lib/mcp/tools/`: `crmSearchContacts` e `crmGetContact` (`contacts.ts`), `crmListConversations`, `crmGetConversation` e `crmGetConversationHistory` (`conversations.ts`), `crmListLeads`, `crmGetLead`, `crmCreateLead`, `crmUpdateLead`, `crmMoveLeadStage` e `crmRetomarLead` (`leads.ts`), `crmSendWhatsappMessage` (`messages.ts`) e `crmStartConversationAndSend` (`start-conversation.ts`, abre ou reabre a 1:1 pelo mesmo helper da rota). Decisão: leitura (lista, busca, ficha, histórico) exclui pessoal; escrita (criar lead, mover, enviar, abrir conversa) recusa pessoal. Sem isso o assistente externo lê e escreve para pessoal furando a decisão 3.
2. **Ligação entra na regra.** Superado pela §3.5: ligação de pessoal ou bloqueado é recusada no mesmo ponto, antes da IA e antes de tocar.
3. **Contrato cita os dois efeitos principais.** "Não cria negócio" e "não chama a IA" agora estão no contrato (§3.4), não só no aceite.
4. **Critério 3 corrigido.** Antes dizia "contagem igual a antes" — errado: ao marcar, as não-lidas do pessoal saem da conta e o número cai. Texto certo: marca e a contagem cai exatamente nas não-lidas daquele contato.
5. **Tela (pergunta ao dono, ponto 5).** Proposta: botão marcar/desmarcar dentro da conversa (cabeçalho da inbox) e na ficha do contato; filtro "Pessoais" na lista de Contatos. Botão em tela existente não cria tela nova e não exige porta no menu (`lib/navigation/registry.ts`).
6. **Quem está atendendo (pergunta ao dono, ponto 6).** Proposta: ao marcar, a conversa fecha e sai do atendente, sem nada pendurado.

Detalhe: quem marcou e quando fica só na auditoria + timeline, sem coluna extra no contato (menos coluna, mesma prova).
