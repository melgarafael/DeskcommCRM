# Grupos de WhatsApp na inbox: histórico e resposta manual

**Data:** 23/09/2026 · **Status:** desenho aprovado, implementado

## Problema

Mensagens de grupo não aparecem no chat. `lib/waha/ingest.ts` descarta todo `chatId` que
termina em `@g.us`: é a doutrina "Grupos: SKIP CRM binding" do `CLAUDE.md`, e também o
filtro `CONVERSAS_IGNORADAS.groups = true` no WAHA (`lib/waha/client.ts`), que corta os
grupos já na origem.

O caso de uso real são **grupos de clientes**: a equipe precisa ver o histórico desses
grupos e responder por lá, manualmente. **A IA nunca responde em grupo.**

## Decisões de desenho

1. **Recorte mínimo, no núcleo.** A issue #1428 propõe um módulo de grupos com
   moderação, de cerca de 10 mil linhas. Este desenho cobre só histórico e resposta
   manual, reaproveitando conversa e mensagem; moderação fica fora (ver "Fora desta versão").
2. **Só entram os grupos escolhidos.** Uma lista de permitidos por número conectado. O
   padrão é desligado.
3. **Visibilidade pelo mecanismo que já existe (saída 1).** O grupo é uma conversa
   comum, e `fn_can_view_conversation` decide quem vê. Um grupo sem dono é visto por
   todos os atendentes no modo `own_and_unassigned`, que é o padrão. Um grupo atribuído
   a alguém segue a regra de atribuição. **Não há** lista de atendentes por grupo nesta
   versão.
4. **Abordagem A:** reaproveitar `conversations` e `messages` (com `is_group`), e não um
   subsistema paralelo.

## Fatos medidos no código que o desenho usa

- O envio já trata grupo: `sendMessageHandler` chama
  `adapter.resolveRecipient({ isGroup, groupChatId, … })`
  (`app/api/v1/messages/_handler.ts`).
- O motor do agente já pula grupo (`lib/agent-engine/edge/crm/drain.ts`, "regra dura
  nº 12"), e `lib/ai/dispatcher/index.ts` lê `is_group`.
- `conversations.is_group` e `conversations.group_chat_id` existem no baseline e
  **ninguém grava** nelas hoje. A constraint `conversations_unique_per_contact_session`
  já inclui `group_chat_id`.
- `conversations.contact_id` e `messages.contact_id` são **NOT NULL**.
- **O filtro do WAHA é por sessão e é tudo ou nada.** `ignore.groups` não escolhe grupo:
  com um grupo ligado, todos os grupos do número chegam ao webhook, e o nosso lado
  descarta os que não foram escolhidos. Custo medido na #1428: 17.970 eventos e 89 MB
  numa instalação.
- A capacidade `groups` está na matriz de canais (`lib/channels/capabilities.ts`): `full`
  no WAHA, `limited` ou `none` nos outros canais.
- Consumidores de `message.received` registrados hoje: `workers/ai-response-worker`,
  `workers/ai-sentiment-worker`, `lib/followup/reactivity.handler`,
  `lib/campanhas/resposta.handler`, `lib/notifications/push.handler` e o gatilho de
  retorno do follow-up (`lib/followup/gatilho-retorno.ts`), mais as regras de automação
  e os webhooks de saída (`message.received` no editor de regras). **A lista completa sai
  de uma varredura no plano, não desta frase.**

## Achados da leitura para o plano (ajuste aprovado em 23/09/2026)

1. **Gatilhos do banco em `messages` e `conversations`.** Dos 11, dois reagem mal a grupo:
   - `fn_request_channel_routing`, chamado por `trg_conversation_routing_requested` e
     `trg_service_reopened_routing`, **atribuiria o grupo a um atendente sozinho**, e isso
     quebra a saída 1. Passa a pular `is_group`.
   - `fn_emit_message_event` emitiria `message.received`, e isso acionaria IA, follow-up,
     campanhas, automações, webhooks e sentimento. Para conversa de grupo, ele passa a
     emitir **`message.group_received`**. Os consumidores atuais não escutam esse evento,
     então a proteção vale num ponto só, inclusive para consumidores futuros. Só
     `lib/notifications/push.handler.ts` passa a escutá-lo.
   - `fn_service_inbound` (demanda) já pula grupo. Trava de atendimento, revisão de
     contexto, agenda e campanha são neutros.
2. **O cliente do WAHA reverte o filtro.** `WahaClient.compatibleSession` trata
   `ignore.groups = false` como sessão incompatível, e `convergirConfigDaSessao` regrava
   `CONVERSAS_IGNORADAS`, com `groups: true`. Os dois passam a tratar a chave `groups`
   como **propriedade desta funcionalidade**: aceitam os dois valores e a preservam. Só o
   método novo, que liga e desliga grupos, escreve nela.
3. `contacts.wa_identity` é gerada e só produz `phone:` e `lid:`, e `fn_upsert_wa_contact`
   não serve para grupo. O contato do grupo é criado pelo serviço de grupos, e o id dele
   fica em `channel_session_groups.contact_id`.

## Parte 1: dados

Uma migration nova, com o `NNNN` escolhido na hora
(`pnpm checar:colisao-de-migration`), e a tripla completa: o arquivo em
`supabase/migrations/`, o apêndice idempotente no `supabase/baseline.sql` e a linha no
`MANIFEST.md`.

1. **Tabela `channel_session_groups`**
   - Colunas: `id uuid pk`, `organization_id uuid not null` (FK, `on delete cascade`),
     `channel_session_id uuid not null` (FK), `group_chat_id text not null`,
     `subject text`, `enabled boolean not null default false`, `enabled_at timestamptz`,
     `enabled_by_user_id uuid`, `created_at`, `updated_at`.
   - `unique (organization_id, channel_session_id, group_chat_id)`.
   - RLS: membros da organização LEEM (`channel_session_groups_select`, via
     `fn_user_org_ids()`). **Só o service role escreve** (decidido na revisão
     final, 23/09/2026): não há policy nem grant de escrita para `anon`/`authenticated`.
     O `manager` liga e desliga pela API, que exige o papel, confirma o filtro e audita.
2. **Coluna `contacts.kind text not null default 'person'`**, com
   `check (kind in ('person','whatsapp_group'))`.
   - Todo contato que já existe vira `person` pelo default, sem backfill.
   - O "contato do grupo" é `whatsapp_group`: `display_name` = nome do grupo,
     `wa_identity` = `group_chat_id`, e **sem** telefone.
3. **Remetente em grupo:** `messages.metadata.group_sender = { name, phone | lid }`,
   validado por um schema Zod único (anti-pattern nº 6: nenhuma tela lê o caminho do
   jsonb sem esse schema). Nenhum contato é criado por participante.

Nada que já existe é alterado.

## Parte 2: ligar e desligar grupos

- Botão **"Grupos"** no cartão do número, em Conexões. Só aparece quando
  `capabilitiesOf(provider).groups !== "none"` e quando o papel é `manager` ou maior.
- Abre a lista de grupos do número, lida na hora pelo adapter do canal. A leitura dos
  grupos e a troca do filtro ficam em `lib/channels/`, porque a doutrina não deixa
  nenhuma feature nomear o provider.
- **Ligar o primeiro grupo** de um número faz `ignore.groups = false` naquela sessão, com
  um aviso na tela, uma vez, sobre o volume. **Desligar o último** faz
  `ignore.groups = true`.
- **Falha fechada:** se o WAHA não confirmar a troca do filtro (a pós-condição é relida,
  como a #1428 ensinou: o WAHA responde 200 para operação que não aconteceu), a chave
  **não** fica ligada, e a tela mostra o erro.
- Todo ligar e desligar grava uma linha em `api_audit_log`.
- **Fora:** o histórico anterior ao momento de ligar.

## Parte 3: entrada, inbox e resposta

**Entrada** (`lib/waha/ingest.ts`):

- Grupo não ligado: descarta, como hoje.
- Grupo ligado:
  - `upsert` do contato do grupo e da conversa (`is_group = true`, `group_chat_id`);
  - a mensagem é gravada com `group_sender` tirado de `p.author`, nunca de `p.from`;
  - mídia pelo mesmo caminho das conversas individuais.
- A idempotência continua `unique(organization_id, external_id)`. A mensagem com
  `fromMe` entra como outbound, sem duplicar.

**Inbox:** etiqueta "Grupo" na lista, o nome do remetente sobre cada balão recebido, e um
filtro "Grupos".

**Resposta:** o fluxo normal de envio humano pela tela, sem mudança.

**Nunca dispara com grupo** (cada linha é uma guarda com teste):

| Peça | Comportamento |
|---|---|
| Agente de IA (drain, dispatcher, worker de resposta) | Pula. Já pula hoje; ganha teste explícito |
| Detecção de STOP / opt-out (`lib/opt-out/deteccao.ts` na entrada) | **Não grava `is_blocked`** no contato do grupo |
| Criação de negócio/lead e efeitos pós-entrada (`lib/leads/pos-entrada.ts`) | Não cria |
| Regras de automação e webhooks de saída em `message.received` | Não disparam |
| Follow-up (reatividade e gatilho de retorno), campanhas e roteamento | Ignoram |
| Sentimento e handoff por sentimento | Ignoram |
| Listas, busca e exportação de contatos | O `kind = 'whatsapp_group'` fica de fora |

## Parte 4: testes, prova e limites

**Testes**, cada um sabotado para provar que reprova:

- **Entrada:** grupo desligado é descartado; grupo ligado gera conversa e mensagem com o
  remetente; `fromMe` não duplica.
- **`test:db`:** isolamento entre duas organizações em `channel_session_groups` e na
  conversa de grupo; o apêndice do baseline em install e em update.
- **Guardas:** um teste por linha da tabela "nunca dispara".
- **Trava contra esquecimento:** uma varredura dos handlers registrados em
  `message.received` e das consultas de `contacts` que listam pessoas. Consumidor novo
  sem tratar grupo reprova, no mesmo modelo de dívida que só encolhe usado em
  `tests/unit/admin-client-filtra-organizacao.test.ts`.
- **Liga/desliga:** o filtro do WAHA muda só no primeiro e no último grupo; a falha do
  WAHA mantém a chave desligada.
- **Permissão:** o atendente recebe 403 ao ligar grupo, pela API.

**Prova na tela** (DoD 12), no ambiente local, com um número e um grupo **de teste**
criado para isso:

1. ligar o grupo;
2. mensagem pelo celular aparece na inbox com o remetente;
3. resposta pela inbox chega no grupo;
4. "parar" no grupo não bloqueia nada, e a IA não responde;
5. desligar o grupo faz as mensagens novas pararem de entrar.

Evidência em `.superpowers/evidence/`.

**Fora desta versão:** histórico anterior ao ligar; lista de atendentes por grupo (a
saída 2, que mexe em `fn_can_view_conversation`); moderação, membros e criar ou sair de
grupo (o escopo da #1428); grupos em canais `limited`; **exportação e anonimização LGPD
do participante de grupo que NÃO é contato do CRM** (ver abaixo).

**LGPD — mensagens de grupo.** A mensagem de grupo mora na conversa do contato
PLACEHOLDER do grupo, e o autor só existe em `messages.metadata.group_sender`
(`{name, phone, lid}`). Para quem **já é contato do CRM**, a anonimização alcança essas
mensagens: o gatilho da virada de `is_anonymized` (`fn_redigir_conversas_ao_anonimizar`,
migration 0391, redefinido na 0411) — por onde passam os DOIS caminhos, o pedido formal
(`fn_lgpd_cascade_redact_contact`) e o botão da ficha — casa o autor pelo telefone
(`fn_telefone_variantes`, com e sem o nono dígito) **ou** pelo lid (`contacts.wa_lid`),
lidos da linha ANTIGA do contato, e redige corpo, mídia (o arquivo entra em
`storage_redaction_queue` antes de a coluna ser zerada) e `metadata` — `group_sender`
inclusive —, preservando os timestamps, e zera a prévia da conversa do grupo. O export
(`lib/lgpd/export-collector.ts`) entrega as mesmas mensagens em
`group_messages_authored`, no `data.json` e numa seção própria do PDF. Vigiado por
`tests/invariants/lgpd-alcanca-mensagens-de-grupo-do-contato.test.ts`.

**O participante que não é contato continua sem caminho.** Ele não tem ficha nem pedido
LGPD por esta tela, e achá-lo exigiria buscar por telefone/lid solto, fora de um titular —
mudança de desenho, não esquecimento. O rótulo fica sob a responsabilidade do
controlador, que opera o número; se o participante virar contato depois, a cascata o
alcança a partir daí (o casamento é no momento do pedido, não no da mensagem).

**Reversão:** desligar todos os grupos devolve o número ao estado atual (`ignore.groups =
true`). O histórico gravado fica guardado; apagá-lo é outra decisão, deliberada.

**Risco conhecido:** `lib/waha/ingest.ts` é ponto quente de mudança; o desvio de grupo
fica isolado em `lib/grupos/ingest.ts` para reduzir conflito.

## Definition of Done aplicável

- Typecheck, lint, `lint:channels`, `test:unit` completo e `test:db`.
- Migration em tripla.
- Audit log no ligar e desligar.
- RLS testada.
- Fragmento em `.changes/` com impacto `capacidade_nova`.
- Destino: **núcleo**. Pela pergunta da doutrina de extensões, isto poderia ser extensão:
  se nenhuma organização ligar grupo, a operação comum continua inteira. Mas extensão
  hoje não pode ter código, tabela nem tela (`docs/specs/extensoes-declarativas-v1.md`),
  e esta mudança precisa dos três e toca a entrada de mensagens, que é núcleo. Por isso
  ela vem **desligada por padrão**, grupo a grupo.
- Tela com porta (o botão fica dentro de Conexões, que já está na navegação).
- Prova na tela.
