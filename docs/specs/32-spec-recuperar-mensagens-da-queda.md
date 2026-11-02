---
title: "Spec Técnica 32 — Quando o número volta de uma queda, as conversas do período entram sozinhas (só de quem já tem ficha)"
parent: 00-prd-master.md
type: spec
scope: canais (WAHA), importação do histórico, Central
status: draft
version: 0.3.0
owner: arquitetura
created_at: 2026-10-28
related:
  - 28-spec-status-do-whatsapp-nao-volta.md
---

# Spec 32 — Quando o número volta de uma queda, as conversas do período entram sozinhas

Status: **PROPOSTA**. O código citado é o da `main` em `f13d26f6b` (28/10/2026). O estado foi
medido nesse dia numa instalação em produção, só com leitura, sempre filtrando por
`organization_id`, numa organização com um número WAHA ativo.

## O problema, em duas frases

1. Quando o número cai (a conexão vai para `FAILED` e só volta com QR novo), a empresa continua
   atendendo pelo celular. Nada do que entra ou sai nesse período chega ao CRM, nem depois que o
   número volta. O servidor do canal tem essas mensagens, mas ninguém as busca.
2. A importação do histórico, que já existe, busca essas mensagens, mas só quando alguém aperta o
   botão. E ela traz **todo mundo**: cria ficha para cada número que falou com o celular. Quem quer
   só completar as conversas dos clientes do CRM não tem essa opção.

## O que foi medido

### No banco (uma organização, últimos 30 dias, 28/10/2026)

| # | Medição | Resultado |
|---|---|---|
| B1 | Saídas de `WORKING` do número, pelo par de `channel_session.status_changed` (`from_status = 'WORKING'` até o próximo `to_status = 'WORKING'`) | 147: **142 com menos de 10 s**, 3 entre 10 s e 1 min, **2 de cerca de 24 h** |
| B2 | As 2 quedas longas | As duas passaram por `FAILED → STOPPED → STARTING → SCAN_QR_CODE` e só voltaram com QR novo |
| B3 | Mensagens no CRM durante a queda mais recente (24 h) | **0** |
| B4 | Mensagens no servidor do canal no mesmo período (lidas pela API do WAHA: lista de chats, depois as últimas 100 mensagens de cada chat com atividade) | **pelo menos 7 conversas e 26 mensagens**: 16 recebidas e 10 mandadas pelo aparelho. 6 das 7 pessoas já tinham ficha viva no CRM |
| B5 | Mensagens recebidas pelo webhook com atraso (`created_at − sent_at`), fora as importadas | 741, todas abaixo de 5 s. Nenhuma chegou atrasada depois dos 142 reinícios curtos |
| B6 | Prévia da importação de 30 dias, pela tela, na mesma conexão | "Pelo menos 225 conversas, 186 mensagens, 1 áudio e 9 imagens", porque inclui quem não tem ficha |
| B7 | Configuração da sessão no WAHA | `noweb.store = { enabled: true, fullSync: true }` ("Guardar o histórico anterior à vinculação" ligado) |

Leitura: a queda que perde mensagem é a **longa**, que termina em novo pareamento (B1–B3). O
reinício de segundos não deixou rastro de perda (B5). Recuperar só as fichas do CRM teria trazido
as 26 mensagens de 6 conversas, e não as 225 conversas da importação inteira (B4, B6).

### No código

| # | Fato | Onde |
|---|---|---|
| C1 | A importação tem os estados `previa → rodando → concluida \| erro \| cancelada`; a rota só muda estado e o cron anda uma rodada por minuto | `app/api/v1/channel-sessions/[id]/historico/route.ts`; `app/api/v1/cron/historico-import/route.ts`; `lib/channels/historico/rodada.ts` |
| C2 | O pedido só aceita `dias ∈ {30, 90, 180, 365}`. A janela é "de `desde` até agora": não há fim (`até`) nem filtro de quem entra. O banco repete a regra no CHECK `dias in (30, 90, 180, 365)` | Zod `corpo` na rota; `importacoes_de_historico` no `supabase/baseline.sql`; `rodada.ts` (`desde: ... - imp.dias * SEGUNDOS_POR_DIA`) |
| C3 | Para cada chat, a rodada chama `fn_upsert_wa_contact`, que acha a ficha por `wa_lid` e depois pelo telefone (com e sem o nono dígito) e, **se não acha, cria** a ficha (`source = 'whatsapp'`) | `rodada.ts`, `garantirContatoEConversa` |
| C4 | Antes de gravar, a rodada pergunta `fn_titular_apagado_a_pedido` e pula a conversa de quem pediu apagamento | `rodada.ts` |
| C5 | Mensagem importada leva `metadata.historico_importado = 'true'`, e a migration 0760 corta por essa chave: não reabre conversa, não abre demanda, não emite `message.received`/`message.sent`/`message.outbound`, não chama IA | `lib/channels/historico/mapear.ts`; bloco da 0760 no `baseline.sql`; cerca `tests/invariants/historico-importado-nao-dispara.test.ts` |
| C6 | Mensagem repetida não entra duas vezes: a rodada consulta antes de gravar as grafias candidatas do `external_id` (ver C19), e `messages_org_external_id_unique (organization_id, external_id)` pega a corrida | `mapear.ts`; `supabase/baseline.sql` |
| C7 | Só uma importação `rodando` por conexão: índice único parcial `importacoes_de_historico_uma_rodando_idx` | `supabase/baseline.sql` |
| C8 | A troca de status grava `channel_sessions.status` e o gatilho emite `channel_session.status_changed` com `from_status`/`to_status`. **Nenhum código consome esse evento**: ele nasce `done`, na lista de "registro" | `lib/waha/ingest.ts` (`handleSessionStatus`); `fn_emit_channel_session_status_changed`, `fn_event_log_e_registro` no baseline; `git grep -n "channel_session.status_changed" origin/main -- lib app workers docker` não devolve nada |
| C9 | O que reage hoje à volta do número não busca mensagem: fecha o aviso da Central (`sincronizarSaudeDaConexao`), reenvia saídas `queued` (`session-reconciler.ts`) | `lib/channels/health.ts`; `lib/agent-engine/edge/crm/session-reconciler.ts` |
| C10 | `last_status_change_at` é regravado por várias rotas (reconectar, varredura de saúde). Não serve para saber "fora desde quando" | `app/api/v1/cron/channel-health/route.ts`, rotas de `channel-sessions` |
| C11 | Achar a ficha pelo telefone **sem criar**: `encontrarContatoPorTelefone` (variantes, `is_merged_into is null`; ver C16). Para chat `@lid` sem telefone, a rodada já tem `resolvePhoneForLid` | `lib/channels/contato-por-telefone.ts`; `rodada.ts` |
| C12 | Avisos da Central têm `kind` num CHECK único (`agent_inbox_items_kind_check`) | `supabase/baseline.sql` |

### Achados de código da revisão (conferidos)

| # | Fato | Onde |
|---|---|---|
| C13 | O CHECK de status só aceita `previa \| rodando \| concluida \| erro \| cancelada`; o índice único só cobre `rodando`; o cron só anda linhas `rodando`; o GET da tela lê só a importação mais recente da conexão | `supabase/baseline.sql` (`importacoes_de_historico`, `importacoes_de_historico_uma_rodando_idx`); `app/api/v1/cron/historico-import/route.ts`; `historico/route.ts` (GET) |
| C14 | O corte da 0760 também tira o `message.received` que alimenta o follow-up de silêncio e a resposta de campanha; a detecção de "PARE" mora no pós-entrada (`lib/channels/pos-entrada.ts`), que a rodada não chama | comentário do bloco 0760 no baseline; `lib/channels/historico/rodada.ts` (cabeçalho) |
| C15 | `fn_upsert_wa_conversation_importada` devolve a conversa existente **intocada**: nem `last_message_at`, nem não lidas, nem dono | `supabase/baseline.sql` |
| C16 | `encontrarContatoPorTelefone` ignora o erro da consulta (erro vira "sem ficha") e não filtra `is_anonymized`; a trava de LGPD da rodada falha fechada | `lib/channels/contato-por-telefone.ts`; `rodada.ts` |
| C17 | Logo depois de um pareamento novo, `resolvePhoneForLid` devolve `null` (a tabela de `@lid` do canal é povoada por atividade) | `lib/waha/client.ts` |
| C18 | A varredura de saúde também grava `status` (a cada 5 min), e o gatilho emite o evento nesse momento. Outros escritores (redes sociais, voz) emitem o mesmo evento | `app/api/v1/cron/channel-health/route.ts`; `docker/scheduler/entrypoint.sh`; `lib/channels/social/store.ts`; `app/api/v1/voice/sessions/pair/route.ts` |
| C19 | O `external_id` do acervo não é idêntico ao do webhook (o sufixo muda). Quem evita a repetição é a consulta por candidatos antes de gravar; o índice único é `DEFERRABLE` e só pega a corrida | `mapear.ts`; `rodada.ts` (`gravarMensagens`) |
| C20 | Avisos da Central: `kind` num CHECK único reconstruído por migration (cerca `tests/unit/kind-check-migration-x-baseline.test.ts`), política por kind em `POLITICAS_DE_AVISO` (completude cobrada na compilação), texto em `lib/ai/agent-inbox-copy.ts`; deduplicação **não** é geral: só alguns kinds têm índice único parcial próprio (ex.: `agent_inbox_canal_pausado_aberto_unico`); os outros dependem do `not exists` de `insertInboxItem` (`lib/agent-engine/db/repository.ts`), que tem corrida e não atualiza; o destino vem de `ref_kind` (conexão leva à tela de Conexões, só admin) | `lib/ai/inbox-destino.ts`; `supabase/baseline.sql` |
| C21 | `message.received` é consumido pelo worker de resposta da IA, pelo de sentimento, pelo push, pelas automações, pelo aviso ao dono da carteira, pela conversão de anúncio, pela resposta de campanha e pelo follow-up. O corte da 0760 em `fn_emit_message_event` é por tudo ou nada | `workers/ai-response-worker.handler.ts`, `workers/ai-sentiment-worker.handler.ts`, `lib/notifications/push.handler.ts`, `lib/automation/engine.handler.ts`, `lib/carteira/aviso-ao-dono.ts`, `lib/conversoes/clique-meta.handler.ts`, `lib/campanhas/resposta.handler.ts`, `lib/followup/reactivity.handler.ts` |
| C22 | No `23505` (mensagem já gravada), o webhook só reacelera o pipeline e retorna: não aplica opt-out, não marca a conversa, não despacha o agente | `lib/waha/ingest.ts`, bloco "inbound ja ingerido" |
| C23 | `channel_sessions.phone_number` só é gravado pelo GET da conexão (abertura da tela de Conexões); `handleSessionStatus` e a varredura de saúde não gravam | `app/api/v1/channel-sessions/[id]/route.ts`; `lib/waha/ingest.ts`; `app/api/v1/cron/channel-health/route.ts` |
| C24 | `importacoes_de_historico.dias` é `not null`, e os CHECKs de `dias` e `status` são inline e sem nome | `supabase/baseline.sql`, `create table if not exists public.importacoes_de_historico` |

## O que muda

### 1. A importação ganha "só contatos do CRM" e uma janela com fim

- **Escopo** novo: `todos` (o de hoje) ou `so_crm`. Ele é escolhido na ação `previa` e vale para a
  `importar` dessa mesma linha.
- Com `so_crm`, a conversa do canal só entra se o chat casar com uma **ficha viva** da organização:
  `is_merged_into is null`, `is_anonymized = false` e sem pedido de apagamento (C4).
  - O casamento usa, nesta ordem: o `wa_lid` da ficha; o telefone do chat; os telefones que as
    próprias mensagens trazem (`remoteJidAlt`); `resolvePhoneForLid` (que pode estar vazio logo
    depois de um pareamento novo, C17). Telefones comparados com as variantes do nono dígito.
    Toda consulta filtra `organization_id` da importação.
  - **Falha fechada:** erro na consulta da ficha para a rodada com `erro` (como a trava de LGPD),
    nunca vira "sem ficha" (C16). Por isso a busca não usa `encontrarContatoPorTelefone` como está.
  - Não cria ficha e não altera a ficha achada (nem nome, nem `source_metadata`). Chat sem ficha
    conta em `mensagens_ignoradas`.
  - Chat ignorado pelo escopo **não gasta** o teto de conversas por rodada (`TETO_PADRAO`): só a
    conversa que entra conta. Sem isso, uma recuperação de 6 conversas no meio de 200 chats levaria
    dezenas de minutos.
- **Janela com fim:** a importação passa a ter `desde` e `ate`. A manual continua "de N dias até
  agora" (`dias` preenchido, `desde`/`ate` vazios). A automática (item 2) usa `desde`/`ate` e deixa
  `dias` vazio.
  - O cliente do canal só filtra `timestamp >= desde` no servidor (`lib/waha/client.ts`); `ate` é
    filtro **local**, na rodada, e a mensagem cortada continua contando em `lidas` (o offset do
    cursor depende disso).
  - A rodada não grava mensagem fora de `[desde, ate)`.
- **Prévia:** respeita o escopo. `calcularPrevia` passa a receber o cliente administrador e o
  `organization_id` para resolver as fichas. Com `so_crm`, conta só o que casaria; a resolução de
  `@lid` gasta do mesmo teto de chamadas da prévia (100).
- **Tela:** opção **"Só contatos do CRM"**, ligada por padrão; a prévia mostra o número do escopo
  escolhido.
- Repetida não entra (C19); grupo e status ficam fora; só imagem e áudio baixam; só administrador
  inicia a manual.

### 2. Volta de uma queda dispara a recuperação sozinha

- **Queda** = o par de `channel_session.status_changed` de uma conexão: a saída
  (`from_status = 'WORKING'`) e a próxima volta (`to_status = 'WORKING'`) da mesma
  `channel_session_id`. Nunca `last_status_change_at` (C10).
  - Só queda de **5 minutos ou mais** (B1, B5).
  - Os eventos podem vir do webhook ou da varredura de saúde, que tem até 5 minutos de atraso
    (C18). Por isso a janela começa **10 minutos antes** do evento de saída e **termina no evento de
    volta** (`ate` = instante do evento de volta, nunca depois). O que chegou entre a volta real e
    o evento atrasado veio pelo webhook ao vivo. Uma margem para frente faria a recuperação gravar
    primeiro uma mensagem ao vivo, e o webhook, ao ver a repetida (`23505` em `lib/waha/ingest.ts`),
    não aplicaria os efeitos nem chamaria o agente: a mensagem ficaria sem resposta.
  - Cada queda vira **uma** importação. Janelas que se sobrepõem não se juntam: a mensagem repetida
    não entra duas vezes (C19), e juntar a janela de uma importação que já começou deslocaria o
    cursor (`rodada.ts` fixa `desde` na primeira rodada).
  - Queda sem volta ainda não dispara nada.
- **Quem dispara:** o cron `historico-import` (que hoje só lê `importacoes_de_historico`) ganha um
  passo antes das rodadas:
  - lê `event_log` **por organização operante** (o índice é `(organization_id, event_type,
    created_at desc)`), `event_type = 'channel_session.status_changed'`, com o **evento de volta**
    nos últimos **7 dias** (queda cuja volta é mais antiga não é recuperada sozinha; `event_log`
    não tem expurgo, C8);
  - o `channel_session_id` do payload é dado do evento: só vale se existir
    `channel_sessions.id = payload.channel_session_id and organization_id = event_log.organization_id
    and provider = 'waha' and archived_at is null`;
  - conexão de outro provedor (redes sociais, voz) não dispara.
- **O número precisa ser o mesmo.** O `phone_number` dos eventos **não** prova isso: o webhook e a
  varredura de saúde não gravam o número; quem grava é a abertura da tela de Conexões. Por isso a
  importação da queda nasce com o número da conexão naquele momento, e **antes de começar** o cron
  lê o número ao vivo (`getVerifiedSession` + `numeroObservadoDaSessao`, `lib/channels/numero-observado.ts`)
  e compara com as variantes do nono dígito:
  - igual → segue;
  - diferente → a importação vira `cancelada` com o motivo "o número da conexão mudou", e abre o
    aviso do item 4;
  - não foi possível ler (canal fora, erro) → continua `aguardando` e tenta na próxima passada; se
    passar **60 minutos** sem conseguir, `cancelada` com o motivo, e o aviso. Nunca começa sem
    confirmar.
- **Uma por queda, garantido no banco:** a importação guarda o id do evento de saída
  (`evento_de_saida_id`), com índice único parcial. Duas passadas ao mesmo tempo não criam duas
  (`23505` tratado como "já existe").
- **Espera:** estado novo **`aguardando`** (troca do CHECK, de `StatusDaImportacao` em `rodada.ts`
  e das transições da rota). A importação da queda nasce `aguardando`. O cron a promove com
  `update ... set status = 'rodando' where id = ... and status = 'aguardando'`, e o `23505` do índice
  `importacoes_de_historico_uma_rodando_idx` (outra já `rodando` na conexão) deixa a linha
  `aguardando` para a próxima passada, sem erro.
  - `cancelar` aceita `aguardando`.
  - Enquanto a da queda está `aguardando` ou `rodando`, a importação manual dessa conexão fica
    indisponível (a rota já responde 409, "Já há uma importação em andamento"). A tela diz isso e
    mostra a recuperação em curso; o GET passa a ler a manual mais recente **e** a da queda
    aberta, em vez de só a mais recente (C13).
- Conexão com "Guardar o histórico" **desligado**: não há o que buscar. Nenhuma importação; abre o
  aviso do item 4 com o motivo.
- Escopo sempre `so_crm`. Origem gravada `queda` (as que existem viram `manual`).
- Audit: o início automático grava `channel.historico_import_started` com ator sistema
  (`actorUserId` ausente) e `origem = queda`; o fim já é auditado pelo cron. Só audita quando criou
  a importação (passada sem queda nova não audita).

### 3. A mensagem recuperada tem o efeito de "o cliente respondeu", sem resposta automática

A 0760 corta tudo de uma importação de meses (C5, C14). A recuperação da queda **também não emite
`message.received`**, porque esse evento é o gatilho de quem responde e notifica: o worker de
resposta da IA (`workers/ai-response-worker.handler.ts`), o de sentimento (chamada paga de
modelo), o push, as automações do cliente (`lib/automation/engine.handler.ts`), o aviso ao dono da
carteira e a conversão de anúncio. O corte da 0760 é por tudo ou nada; não há corte por consumidor.

Por isso a rodada da queda, depois de gravar cada mensagem **recebida**, chama **direto** só os
efeitos de "o cliente respondeu":

| Efeito | Na recuperação da queda | Quem faz (o mesmo da ingestão) |
|---|---|---|
| Detecção de "PARE" (`lib/opt-out/deteccao.ts`), com o bloqueio e o fechamento de negócios e demandas de quem pediu parar | **roda** | `aplicarOptOut` em `lib/channels/pos-entrada.ts` (hoje privada: exportar uma entrada só com os efeitos permitidos) |
| Resposta à campanha | **roda** | `avaliarCampanha` (`pos-entrada.ts`) e `aplicarRespostaNaCampanha` (`lib/campanhas/resposta.ts`) |
| Follow-up de silêncio para, porque o cliente respondeu | **roda** | `applyReactivityEvent` (`lib/followup/reactivity.ts`) com a linha do evento montada em memória, sem gravar em `event_log`, e `aplicarTextoNosFollowups` |
| A conversa sobe na caixa: `last_message_at` (com `greatest`, então mensagem mais velha não desce a conversa), prévia e não lidas (+1 por recebida recuperada) | **roda** | `marcarConversaComMensagem` (`lib/channels/marcar-conversa.ts`) |
| IA responde, despacho do agente, roteador, sentimento, demanda nova, automações, webhook de saída, push, aviso ao dono, conversão | **não** | `message.received` não é emitido; `pedirDespachoDoAgente`, `abrirDemanda` e `drenarEventosDoInbound` não são chamados |

Regras dos mesmos efeitos na ingestão, que a recuperação repete:
- canal pausado: nenhum efeito (`idsDosCanaisDesativados`, `lib/channels/desativado.ts`, a régua
  única);
- contato pessoal (`is_personal`, spec 21): nenhum efeito, como em `pos-entrada.ts`;
- mensagem **enviada pelo aparelho** (`fromMe`) recuperada entra na conversa e não tem efeito, mas
  conta como "a equipe respondeu" para o aviso do item 4.

A conversa que **não** existia nasce como hoje (`fn_upsert_wa_conversation_importada`: fechada e
sem dono, C15). Quem avisa a equipe sobre ela é o aviso "cliente sem resposta" do item 4.

A importação **manual** fica como hoje (corta tudo, nenhum efeito).

### 4. Quem precisa saber fica sabendo, e o laço se fecha

Dois `kinds` novos na Central. Cada um entra:
- no CHECK único `agent_inbox_items_kind_check` (o bloco de reconstrução que o baseline já tem,
  cerca `tests/unit/kind-check-migration-x-baseline.test.ts`);
- na união `InboxKind` (`lib/agent-engine/db/repository.ts`), em `POLITICAS_DE_AVISO`
  (`lib/ai/inbox-destino.ts`, completude cobrada na compilação), no texto
  (`lib/ai/agent-inbox-copy.ts`) e no som por kind (cerca `tests/unit/sons-dos-avisos.test.ts`);
- com **índice único parcial próprio** `(organization_id, ref_id) where kind = '<kind>' and status =
  'open'`, como `agent_inbox_canal_pausado_aberto_unico`. O `not exists` de `insertInboxItem` não
  basta: tem corrida e não atualiza.

Os avisos:
- **Resumo da recuperação** (`ref_kind = channel_session`, ref = a conexão; vai para o
  administrador, como os outros avisos de conexão). Um aberto por conexão: nova queda com o aviso
  ainda aberto **atualiza** o mesmo aviso (código novo, um upsert sobre o índice único). Textos:
  - concluída com mensagens: "Recuperamos N mensagens de M conversas do período em que o número
    ficou fora (<início> a <fim>)";
  - terminou em `erro`: "A recuperação das conversas da queda parou: <erro resumido>", com o atalho
    para a tela de Conexões;
  - número mudou, número não confirmado em 60 minutos, ou "Guardar o histórico" desligado: o
    motivo, sem importação.
  - Concluída com 0 mensagens: nenhum aviso. Fecha quando o administrador o resolve, ou sozinho
    quando uma recuperação seguinte da mesma conexão conclui.
- **Cliente sem resposta na queda** (`ref_kind = conversation`, ref = a conversa). Público: quem
  pode ver a conversa, papel mínimo `agent`, pelo mesmo destino dos avisos de conversa
  (`resolverDestinosDosAvisos`); não há "dono" a quem mandar, porque a conversa recuperada pode não
  ter. Um por conversa cuja última mensagem recuperada é do cliente e não tem mensagem da equipe
  depois dela (nem pelo aparelho). Fecha sozinho quando sai uma resposta na conversa.

Schema (migration nova, apêndice idempotente no `supabase/baseline.sql`, linha `-- manifest:`;
número por `pnpm checar:colisao-de-migration`):
- `importacoes_de_historico`: colunas `escopo` (`todos | so_crm`, default `todos`), `origem`
  (`manual | queda`, default `manual`), `desde`, `ate`, `evento_de_saida_id` (índice único parcial
  `where evento_de_saida_id is not null`), `numero_esperado`;
- `alter column dias drop not null`;
- os CHECKs de `dias` e `status` são **inline e sem nome** no baseline, então o Postgres os chamou
  `importacoes_de_historico_dias_check` e `importacoes_de_historico_status_check`: `drop constraint
  if exists` por esses nomes e `add constraint` com o mesmo nome. O vocabulário só cresce
  (`aguardando` entra; nenhum sai), e cada constraint é definida uma só vez no baseline (cercas
  `baseline-constraint-reconstruida` e `migrations-nao-encolhem-vocabulario`). O CHECK de `dias`
  passa a ser `(dias in (30, 90, 180, 365) and desde is null and ate is null) or (dias is null and
  desde is not null and ate is not null and desde < ate)`. As linhas existentes cumprem os dois
  (todas têm `dias` válido e `desde`/`ate` vazios);
- os dois `kinds` e os dois índices únicos parciais.

As importações que já existem ficam `escopo = todos`, `origem = manual`. Fragmento em `.changes/`.

## Fora desta spec (de propósito)

- Trazer quem não tem ficha na recuperação automática.
- A IA responder mensagem antiga.
- Meta e Zernio (não têm importação do histórico).
- Queda que voltou antes de qualquer registro de status (sem o par de eventos, não há o que medir).
- Evitar a queda em si.
- Vídeo, documento e figurinha antigos.

## Como provar

Cada caso com a sabotagem que o deixa vermelho.

- **Escopo `so_crm` (unidade da rodada, canal simulado):** chats que casam por telefone, por `@lid`
  com `wa_lid` da ficha e por `remoteJidAlt` entram; chat sem ficha, de ficha mesclada, anonimizada,
  com pedido de apagamento ou de **outra organização** não entra; nenhuma ficha é criada nem
  alterada; chat ignorado não gasta o teto da rodada. *Sabotagem:* chamar `fn_upsert_wa_contact` em
  `so_crm` (nasce ficha); tirar o filtro de `is_anonymized`; tirar o filtro de organização.
- **Falha fechada:** a busca da ficha devolve erro → a rodada termina em `erro`, nenhuma mensagem
  pulada em silêncio. *Sabotagem:* usar `encontrarContatoPorTelefone` como está.
- **Janela:** mensagem no instante `ate` ou depois não entra, e continua contando em `lidas`.
  *Sabotagem:* ignorar `ate`.
- **Prévia `so_crm`:** com 3 chats e 1 ficha, a prévia conta 1. *Sabotagem:* contar todos.
- **Disparo:** par com 4 min → nada; 6 min → 1 importação `aguardando` com `desde` = saída − 10 min
  e `ate` = volta; o mesmo par em duas passadas simultâneas → 1 (índice único); duas quedas
  sobrepostas → 2 importações, e a mensagem do trecho comum entra uma vez; `channel_session_id` do
  payload de outra organização → nada; conexão `zernio_social` → nada; volta há 8 dias → nada.
  *Sabotagem:* usar `last_status_change_at`; tirar o índice único; tirar o filtro de provedor; ler o
  `channel_session_id` sem conferir a organização.
- **Número:** número ao vivo diferente do esperado (com `phone_number` da conexão **igual** nos dois
  eventos) → `cancelada` e 1 aviso; número ilegível → segue `aguardando`, e depois de 60 min
  `cancelada` e aviso. *Sabotagem:* comparar o `phone_number` dos eventos.
- **Espera:** com uma manual `rodando`, a da queda fica `aguardando` (o `23505` da promoção não vira
  erro), a tela mostra a manual e a recuperação, e a da queda começa quando a manual termina.
  *Sabotagem:* criar a da queda como `previa`.
- **Efeitos da queda:** mensagem recuperada "PARE" bloqueia o contato; mensagem recuperada para o
  follow-up de silêncio pendente e marca a resposta da campanha; a conversa existente sobe e ganha
  não lida; contato pessoal e canal pausado: nenhum efeito. **E zero linhas** de `message.received`,
  `message.sent`, `message.outbound` e `ai_agent.dispatch_requested` em `event_log` geradas pela
  recuperação. *Sabotagem:* deixar o corte da 0760 igual para `origem = queda` (o follow-up sai);
  afrouxar o corte para `origem = queda` (aparece `message.received`).
- **Corrida com o webhook:** mensagem com instante depois de `ate` chega pelo webhook enquanto a
  recuperação roda → a recuperação não a grava, e ela recebe os efeitos e o despacho normais.
  *Sabotagem:* `ate` = volta + 5 min.
- **Avisos:** concluída com mensagens → 1 resumo; segunda queda com o resumo aberto → o mesmo aviso
  atualizado; duas gravações simultâneas do resumo → 1 linha (índice único); `erro` na primeira
  rodada → aviso de erro; conversa com cliente sem resposta → 1 aviso dela, que fecha quando sai
  resposta; resposta pelo aparelho recuperada → nenhum aviso. *Sabotagem:* não emitir aviso em
  `erro`; tirar o índice único.
- **Banco (`tests/invariants`):** a importação manual continua sem emitir evento (cerca da 0760);
  sessão de A não importa nada para B (guarda de isolamento); migration sobre linhas existentes não
  viola os CHECKs novos.
- **Tela (Playwright):** "Só contatos do CRM" vem ligada e a prévia muda de número ao desligar.
- **Prova real (receiver real):** derrubar a conexão de teste por mais de 5 minutos; pelo aparelho,
  trocar mensagens com um contato que tem ficha e outro que não tem; reconectar. Em alguns minutos
  as do primeiro aparecem na conversa dele, as do segundo não, e a Central mostra o resumo.

## Destino

**Núcleo.** Conexão de WhatsApp e histórico servem a todo nicho, e só o núcleo vê a troca de status
do canal. Régua: se nenhuma organização tiver queda, nada muda.

## Perguntas ao mantenedor

1. O disparo fica no cron `historico-import` (que já roda a cada minuto; hoje lê só
   `importacoes_de_historico`, e passa a ler também o `event_log` por organização), ou vira
   consumidor de `channel_session.status_changed`? A segunda opção exige tirar o evento da lista de
   registro (`fn_event_log_e_registro`), onde ele nasce `done`.
2. "Só contatos do CRM" ligado por padrão muda a importação manual para quem já usava. De acordo?
3. Para chamar os efeitos de "o cliente respondeu" sem emitir `message.received`, `aplicarOptOut` e
   `avaliarCampanha` precisam sair de `pos-entrada.ts` numa entrada exportada só com esses efeitos.
   Prefere isso, ou um `message.received` marcado que cada consumidor aprenda a ignorar?
