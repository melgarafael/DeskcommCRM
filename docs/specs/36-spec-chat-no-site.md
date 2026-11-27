---
title: "Spec Técnica 36 — Chat no site: o visitante conversa pela página, e a conversa cai na Inbox"
parent: 00-prd-master.md
type: spec
scope: canais (seam), ingestão pública, Inbox, agente, LGPD
status: parte 1 implementada
version: 0.2.0
owner: arquitetura
created_at: 2026-11-20
related:
  - ../doctrine/restricao-de-canal.md
  - redes-sociais-nativas.md
  - 31-spec-ficha-com-varios-telefones-e-repetido-por-nome.md
---

# Spec 36 — Chat no site

Status: **parte 1 implementada** (F1, Tasks 1 a 10): o canal, as rotas, o token de visitante, a
ingestão, a entrega das respostas por stream, o isolamento entre organizações em banco real e o
mapa. Desligado de fábrica e sem tela. As F2 a F5 seguem propostas. Esta spec detalha a issue #1333
(19/09/2026) e responde às seis perguntas dela com uma decisão cada. O mantenedor pode trocar
qualquer uma na revisão.

O código citado é o da `main` em `478d6700a4` (20/11/2026, release 1.121.0). Conferido de novo em
`55a41601d9` (20/11/2026): nenhum dos arquivos citados mudou. A #1333 foi escrita sobre
`2b58c47a9` (release 1.40.0); o que mudou desde então está em
[O que mudou desde a #1333](#o-que-mudou-desde-a-1333).

## O problema, em duas frases

1. Quem visita o site de uma empresa e quer perguntar algo tem dois caminhos: preencher um
   formulário, que cria o lead e para, ou sair para o WhatsApp, que exige o aplicativo e o número.
2. O CRM já atende WhatsApp, Instagram, Facebook e Telegram na mesma Inbox, com o agente e a
   passagem para a equipe, mas não tem um canal que viva dentro da página.

## O que foi medido

| Fato | Onde | Resultado |
|---|---|---|
| Chat de site existente | `git grep -i "webchat\|web chat\|livechat\|live chat"` em `app lib components supabase/migrations` | nenhum resultado |
| Canais que o banco aceita numa conversa | `supabase/migrations/20261111162814_9342_canal_do_bot_do_telegram.sql:82-84` | `whatsapp`, `instagram`, `facebook`, `telegram` |
| Providers de conexão | `lib/channels/types.ts:19-32` | `waha`, `meta_cloud`, `zernio`, `zernio_social`, `wacalls`, `datafy`, `telegram` |
| Canal sem telefone | `lib/channels/capabilities.ts:379-384` | `PROVIDERS_DE_TELEFONE` exclui `zernio_social` e `telegram` |
| Identidade de contato sem telefone | `lib/channels/bot/ingest.ts:10-11, 162-176`; migration 0368, linhas 14-21 | `contacts.social_identity`, com índice único parcial por organização |
| Efeitos de toda mensagem que entra | `lib/channels/pos-entrada.ts:158-262` | opt-out, pesquisa de satisfação, conversa pessoal, desvio por módulo, origem da página, demanda, campanha, follow-up, despacho do agente. A entrada (`EntradaDeMensagem`, 114-156) não tem telefone |
| Opt-out sem telefone | `lib/opt-out/deteccao.ts:759`; `pos-entrada.ts:932-950` | detecta pelo texto e grava por `contactId` |
| Como a resposta sai | `app/api/v1/messages/_handler.ts:1224` (adaptador), `~1535-1549` (envio de texto), `1262, 1284, 1322` (recusa de conexão arquivada, desativada ou fora de `WORKING`) | `getAdapter(provider)` e `adapter.send(envelope)`, que devolve `{ externalId }`. Mídia, contato e template também passam pelo handler; o adaptador do Telegram recusa o que não é texto. O agente (`lib/agent-engine/edge/crm/send-message.ts:37`), a passagem (`lib/ai/handoff/aviso-ao-lead.ts:45`) e o aviso de fora do horário usam o mesmo handler |
| O que o adaptador precisa ter | `lib/channels/types.ts:351-368` | `provider`, `resolveRecipient`, `isConfigured` (síncrono, sem argumento), `send` e `codes`; o resto é opcional. `RecipientInput` (167-181) só traz telefone e identidades do WhatsApp: o Telegram devolve o marcador `"provider-chat"` e endereça por `providerConversationId` |
| Idempotência de mensagem | `supabase/baseline.sql:2323` | `messages_org_external_id_unique` é `DEFERRABLE INITIALLY DEFERRED`: não serve para `ON CONFLICT`, só para a captura do `23505`, como o `insertMessage` do Telegram (`lib/channels/bot/ingest.ts:262`). O Telegram prefixa o `external_id` com a conexão (`tg:<robô>:<chat>:<msg>`) |
| Página em iframe | `next.config.ts:119-136` | `X-Frame-Options: DENY` e `frame-ancestors 'none'` em todas as rotas |
| Trava de canais do plano | `supabase/baseline.sql:48337-48347` (`fn_trava_canais_do_plano`) | conta toda conexão ativa que não é `wacalls` |
| Canal sem campanha | `lib/channels/capabilities.ts:474` | `PROVIDERS_SEM_CAMPANHA = ["telegram"]` |
| Gate de suporte | `tests/unit/suporte-cobertura-de-efeitos.test.ts:47` | todo POST de `app/api/v1` declara `requireSupportWrite(`; só `cron`, `webhooks` e exceções escritas ficam fora |
| Segredo da instalação para assinar | `lib/env.ts:122`; `lib/cadencias/token.ts:32-34` | `INTERNAL_SECRET` é obrigatório, e o precedente de token assinado usa ele com prefixo de domínio |
| IP de quem chama | `lib/http/ip-do-cliente.ts` | `ipDoCliente(headers)`, que respeita o túnel; serve para separar balde, não para provar quem é |
| Registro de adaptadores | `lib/channels/index.ts:17-34` | provider sem adaptador lança `unknown_channel_provider` |
| Origem do negócio pelo canal | `lib/channels/origem-do-negocio.ts:65-82` | valor desconhecido cai em WhatsApp, então canal novo precisa de entrada própria |
| Lista de canais de conversa | `lib/channels/canais-de-conversa.ts:51-55` | precisa concordar com `conversations_channel_check` |
| Vocabulário de provider vigiado | `tests/invariants/channel-provider-schema.test.ts:166-185` | o CHECK de `channel_sessions.provider` tem de ser igual ao union |
| Tempo real da Inbox | `hooks/inbox/useConversationsRealtime.ts:302-310`; `hooks/inbox/useMessagesRealtime.ts:63-70` | Supabase Realtime `postgres_changes`, que herda a RLS: serve a equipe, mas não o visitante sem sessão |
| Stream existente | `app/api/v1/voice/events/route.ts:49, 84, 176` | `text/event-stream`, autenticado por sessão. É um repasse do stream de um terceiro, e não leitura do banco por cursor: serve de precedente de formato, não de mecanismo |
| Horário de atendimento | `lib/agent-engine/agent/agent-config.ts:157-199`; `lib/agent-engine/agent/janela-de-atendimento.ts:1-25` | é do agente, em `trigger_config.filters.business_hours`. Fora da janela o turno é adiado, e não descartado |
| Origem da página no WhatsApp | `lib/leads/origem-do-site.ts:144-209` | código `dk1` na primeira mensagem do `wa.me`, UTMs de uma lista fechada, primeiro toque por `fn_estampar_atribuicao_de_anuncio` |
| Teto de gasto de IA | `lib/agent-engine/edge/llm/orcamento.ts:6-67, 237` | só o mensal por organização (`ai_budgets`, padrão `off`). Não há teto por conversa |
| Duplicados | `lib/contacts/duplicados.ts:66-83`; Spec 31 | é uma sugestão, e a pessoa decide; o motivo por nome vem desligado de fábrica |
| Rota pública | `lib/auth/public-paths.ts:7, 281`; `proxy.ts:83` | lista de regex; o proxy deixa passar antes de olhar a sessão |
| Rate limit | `lib/ai/dispatcher/rate-limit.ts:120` | `checkRateLimit(bucket, limite, janela)`, no Upstash, com recurso em memória |
| Marca e controlador | `lib/branding/saida.ts:186`; `lib/legal/operador.ts:120-170` | `marcaDaSaida(organizationId)` serve a página pública. `resolverOperador()` não serve: lê a organização da sessão, e o comentário em 120-129 proíbe usá-la em caminho público |
| Canal como módulo opcional | `lib/instalacao/modulos.ts:25, 96, 132, 237, 287-300, 396`; `app/app/connections/page.tsx:31` | o Telegram entrou como `canal_bot`, desligado de fábrica. Desligado, a aba some, mas o robô já conectado segue atendendo. `moduloLigado` só respeita o desligamento pela empresa quando recebe a organização |
| Configuração da conexão | tabela `channel_sessions` no `baseline.sql` | `metadata jsonb not null default '{}'` |

## O que mudou desde a #1333

- **Um canal sem telefone já foi feito.** A #1333 falava em seguir o "padrão zernio". Hoje o molde
  certo é o Telegram (PR #3486, 14/11/2026, migration 9342):
  - tipo próprio no union, fora de `PROVIDERS_DE_TELEFONE`;
  - contato por `social_identity`;
  - entrada em `canais-de-conversa.ts` e em `origem-do-negocio.ts`;
  - módulo opcional desligado de fábrica.

  Esta spec segue esse caminho, peça por peça.
- **O horário mudou de lugar.** A #1333 citava `lib/ai/dispatcher/triggers.ts`, que não existe
  mais. Hoje o horário é do agente (`agent-config.ts`), com aviso, feriado e adiamento do turno.
- **O pós-entrada cresceu.** Além de opt-out, lead e despacho, ele tem hoje a pesquisa de
  satisfação, a conversa pessoal, o desvio por módulo, a origem da página, a demanda, a campanha e
  o follow-up. O canal novo herda tudo isso sem código a mais.
- **Duplicados virou tela** (Spec 31). É por ela que o aviso "pode ser o mesmo contato" chega à
  pessoa.
- **A resposta sai sempre pelo mesmo handler.** O agente, a passagem para a equipe e o aviso de
  fora do horário não precisam de caminho próprio no canal novo.

## As seis perguntas da #1333, decididas

1. **`webchat` entra como provider no seam?** Sim. Fora do seam, o canal perderia o pós-entrada e o
   handler de envio, que são a razão de ele existir.
2. **Uma conexão por organização, criada pela tela?** Sim. Vários sites da mesma empresa cabem
   numa conexão, pela lista de domínios. Mais de uma conexão fica para quando um pedido for medido,
   por exemplo um agente diferente por site.
3. **Stream próprio da instalação para o visitante?** Sim, sem serviço novo: uma rota que lê o
   banco pelo estado das mensagens (`sent`) e entrega em `text/event-stream`, sem cursor. O Realtime do Supabase não serve aqui: ele
   herda a RLS, e o visitante não tem sessão.
4. **Onde ficam as configurações?** O que decide a segurança vai em colunas com CHECK: a chave
   pública e a lista de domínios. A aparência, os textos e a coleta vão em
   `channel_sessions.metadata.webchat`, lidos só por um schema Zod em `lib/channels/webchat/`. Nada
   vai em `organizations.settings`.
5. **Nome na tela?** "Chat no site".
6. **A F1 pode começar sem tela?** Sim. A conexão é criada pela rota de quem administra, e a prova
   chama as rotas direto. Ninguém vê nada enquanto o módulo estiver desligado.

## O que muda

### Regras que valem para todas as fatias

- **Zero conexões de chat é um estado completo.** Com o módulo desligado, nenhuma rota pública
  responde, nenhum script é servido e nada aparece na tela.
- **A organização vem sempre da chave pública da conexão**, resolvida no servidor. Nunca do corpo do
  pedido, do navegador nem do domínio que o navegador diz ser.
- **O visitante não recebe segredo nem sessão do CRM.** Ele recebe só o token de visitante (F1), que
  não abre nada além da própria conversa.
- **O caminho quente não muda.** A mensagem do chat entra pelo pós-entrada, e a resposta sai pelo
  handler de envio, como em qualquer canal.

### Como as peças se falam

```
página do cliente ── <script webchat.js?k=wck_…> ──> cria a bolha e um iframe
                                                     │
                     iframe: https://<crm>/chat/<chave>   (origem do CRM)
                        │  POST /api/v1/webchat/sessao      ┐
                        │  POST /api/v1/webchat/mensagens   ├ mesma origem do CRM: sem CORS
                        │  GET  /api/v1/webchat/eventos     ┘
                        ▼
                ingestão → pós-entrada → Inbox, lead, agente
                handler de envio → adaptador webchat → a rota de eventos entrega
```

- Todas as chamadas à API saem do iframe, que está na origem do CRM. Por isso não há CORS, e o
  `Origin` dessas chamadas é sempre o do próprio CRM.
- **Quem barra o site que não está na lista é o navegador**, pelo `frame-ancestors` da página
  `/chat/<chave>`, montado a partir de `webchat_allowed_origins`. O link direto (`/chat/<chave>`
  aberto sozinho) continua valendo, de propósito: é a entrega por bio, e-mail e QR.
- A chave `wck_…` é um **identificador público**, e não um segredo: está no código-fonte do site do
  cliente. Ela aparece no corpo e na URL do script sem violar "API key nunca em query string",
  porque não autoriza nada sozinha. A proteção é o limite de chamadas e o teto do anônimo (F4).

### F1 — A base: canal e rotas (sem tela)

**Banco.** Uma migration, com a tripla: o arquivo, a linha `-- manifest:` e o apêndice no
`baseline.sql`, somando os valores novos nos blocos únicos de cada CHECK, como a migration 9342 fez
(`baseline.sql:88019`).

- `channel_sessions_provider_check` ganha `webchat`. O `channel_sessions_provider_ref_check` ganha
  o ramo `provider = 'webchat' and webchat_public_key is not null`.
- Colunas novas em `channel_sessions`:
  - `webchat_public_key text`: `wck_` mais 32 bytes aleatórios em base64url. Índice único parcial
    enquanto a conexão não está arquivada.
  - `webchat_allowed_origins text[] not null default '{}'`, com CHECK por uma função `immutable`
    nova, `fn_webchat_origens_validas(text[])`: no máximo 20 itens, cada um `https://` mais host e
    porta opcional, sem caminho. A exceção de `http://localhost` (instalação em loopback) é regra da
    rota, no Zod, porque depende da instalação e não do banco. A função recebe `revoke execute ...
    from public, anon`.
- `conversations_channel_check` ganha `webchat`.
- `webhook_events_log_provider_check` **não muda**, porque o chat não chega por webhook de terceiro.
- `fn_trava_canais_do_plano` passa a ignorar `webchat`, como já ignora `wacalls`. Ver a decisão 6.
- `contacts` não ganha coluna. O contato usa
  `social_identity = webchat:<channel_session_id>:<visitante_id>`.

**Código do canal, na ordem do Telegram.** Cada item é um lugar que hoje é exaustivo por provider e
reprova sem o `webchat`.

- `lib/channels/types.ts`: `webchat` no union. `lib/channels/session-ref.ts`: o tipo, a coluna
  `webchat_public_key` em `CHANNEL_SESSION_REF_COLUMNS` e o `case "webchat"` em `resolveSessionRef`.
- `lib/channels/capabilities.ts`: na matriz, `freeformOutsideWindow: true`, `minIntervalMs: 0`,
  `voiceNote: "none"`, `groups: "none"`, e `false` em todas as outras. Em `PROVIDERS_DE_MENSAGEM`.
  Fora de `PROVIDERS_DE_TELEFONE`. Em `PROVIDERS_SEM_CAMPANHA`: não há campanha para quem não tem a
  janela aberta.
- `lib/channels/index.ts` (`ADAPTERS`) e `lib/channels/templates-fonte.ts` (`FONTE`).
- `lib/channels/canais-de-conversa.ts`.
- `lib/channels/origem-do-negocio.ts`: ramo `if (canal === "webchat")` **antes** do
  `SOCIAL_NETWORKS.find`, como o do Telegram, com o rótulo "Chat no site" e `source: "webchat"`.
- `lib/ai/elegibilidade/pre-go-live.ts:34`: `REDES_COM_TESTADOR_SOCIAL` passa a excluir `webchat`.
  Sem isso, o chat vira rede de testador e o cron `canal-mudo-watcher` passa a vigiá-lo.
- O selo na Inbox, que a conversa precisa ter desde a F1 para não aparecer como "desconhecido":
  `lib/channels/presentation.ts`, `lib/channels/marca-do-canal.ts`,
  `lib/operacao/texto-do-relatorio.ts:37` e a cor `--color-canal-webchat` em `app/globals.css`.
- `lib/channels/adapters/webchat.ts`:
  - `send()`: recusa o que não é texto, com o código do adaptador, como o do Telegram. Para texto,
    não fala com nenhum terceiro: o handler já gravou a mensagem, e o adaptador devolve um
    `externalId` próprio, `wc:out:<uuid>` (o UUID é gerado pelo adaptador).
  - `resolveRecipient`: devolve o marcador `"provider-chat"`, como o Telegram. O endereço é
    `conversations.provider_conversation_id`, que guarda o `visitante_id`.
  - `isConfigured()`: devolve `true`, como o Telegram. Módulo e conexão são conferidos nas rotas
    públicas e na ingestão; na saída, quem barra é o handler, pelo estado da conexão.
- `lib/channels/webchat/ingest.ts`, no molde de `lib/channels/bot/ingest.ts:60-130`:
  1. acha ou cria o contato pela `social_identity`. O nome nasce "Visitante do site", até o
     visitante dizer o dele;
  2. acha ou cria a conversa pelo mesmo caminho do Telegram (`fn_upsert_wa_conversation` e o
     `UPDATE` de `channel = 'webchat'` e `provider_conversation_id = <visitante_id>`, em
     `ingest.ts:200-229`). **Para o implementador:** se a janela em que a conversa existe como
     `whatsapp` aparecer em algum leitor, a correção é uma RPC que já nasce com o canal, para os
     dois canais, numa fatia própria;
  3. grava a mensagem com `external_id = wc:<channel_session_id>:<visitante_id>:<uuid do navegador>`.
     O prefixo impede que o UUID de um visitante engula a mensagem de outro. O reenvio do mesmo
     UUID cai no `23505`, e a rota responde como sucesso;
  4. chama `marcarConversaComMensagem` (`lib/channels/marcar-conversa.ts:48`);
  5. chama `aplicarEfeitosPosEntrada` com `canal: "webchat"`.
- Módulo opcional `canal_webchat`: `lib/instalacao/modulos.ts` (com a linha `MODULO_CANAL_WEBCHAT`
  em `platform_config`), `lib/recursos-opcionais/catalogo.ts`,
  `app/admin/(protected)/sistema/_form.tsx` e `tests/unit/porta-do-modulo-ligado.test.tsx`. Vem
  desligado de fábrica, e a empresa pode desligá-lo. **Desligado, as rotas públicas param de
  responder**, inclusive para conexão já criada. É diferente do Telegram, de propósito: lá o robô é
  do cliente e segue vivo no Telegram; aqui a janela é servida pelo CRM, e "desligado" tem de
  querer dizer que nada é servido. As rotas chamam `moduloLigado(admin, "canal_webchat", orgId)`,
  com a organização, para respeitar o desligamento pela empresa.

**Conexão, pela rota de quem administra.** `app/api/v1/channels/webchat/route.ts`, no molde de
`app/api/v1/channels/bot/route.ts`: `POST` cria a conexão (uma por organização), `PATCH` muda a
lista de domínios e a configuração da janela, e `POST .../girar` troca a chave. `requireRole("admin")`,
`requireSupportWrite(` antes do efeito, Zod no corpo e auditoria (`channel.webchat_created`,
`channel.webchat_updated`, `channel.webchat_key_rotated`). A conexão nasce com
`display_name = "Chat no site"` e `status = 'WORKING'`. A tela que usa essa rota é da F2; na F1 a
prova chama a rota direto.

**O token de visitante.**

- Formato: `base64url(JSON {v:1, cs:<channel_session_id>, vis:<visitante_id>, iat, exp})` + `.` +
  HMAC-SHA256 em base64url. A chave é derivada de `INTERNAL_SECRET` com o prefixo de domínio
  `webchat-visitante:v1:`, como `lib/cadencias/token.ts` faz. Não há variável de ambiente nova.
- Validade de 30 dias. Quando faltar menos de 7, a rota de mensagens devolve um token novo junto da
  resposta, com o mesmo `visitante_id`.
- Trocar o `INTERNAL_SECRET` invalida todos os tokens: o visitante começa outra conversa. Custo
  aceito, e escrito no runbook de troca de segredo.
- O token fica no `localStorage` da janela, que é de outra origem. Navegador que separa ou apaga esse
  armazenamento começa outra conversa: os navegadores de hoje bloqueiam cookie de terceiro dentro de
  iframe.
- Na rota de eventos e na de mensagens, o token vai no cabeçalho `Authorization: Bearer`, nunca na
  URL. Por isso a janela lê os eventos com `fetch` e um stream, e não com `EventSource`, que não
  manda cabeçalho.
- A conversa e a conexão saem **do token**, nunca do pedido. A rota confere que a conexão do token
  está ativa e que o módulo segue ligado.
- **Girar a chave não corta token já emitido.** `POST .../girar` troca só `webchat_public_key`: a
  chave antiga para de valer em `sessao` (404) no mesmo UPDATE, mas o token segue valendo, porque
  as rotas de mensagens e de eventos resolvem a conexão pelo id assinado no token. Para cortar tokens,
  arquivar a conexão ou desligar o módulo.

**Rotas públicas.** Entram em `lib/auth/public-paths.ts`, ancoradas nos dois lados, com os casos em
`lib/auth/public-paths.test.ts`. Todo corpo passa por Zod.

| Rota | O que faz | Limites (balde por `ipDoCliente` e por visitante) |
|---|---|---|
| `POST /api/v1/webchat/sessao` | recebe a chave; devolve o token de visitante (novo ou o mesmo, se vier um válido) e a configuração pública: textos, cores e o aviso de LGPD | 30 por minuto por IP, em qualquer chave; 10 por minuto por IP e chave; corpo até 8.192 bytes (413) |
| `POST /api/v1/webchat/mensagens` | recebe o token, o UUID da mensagem e o texto (até 2.000 caracteres); grava e responde 201 sem esperar a IA | 20 por minuto por visitante; 600 por minuto por conexão; corpo até 8.192 bytes (413) |
| `GET /api/v1/webchat/eventos` | stream `text/event-stream` com as respostas ainda não entregues (`status = 'sent'`) | 6 aberturas por minuto por visitante; fecha em 60 s, e a janela reabre |

- **O que a rota de eventos entrega:** só mensagens da conversa do token, com `direction =
  'outbound'`, `type = 'text'` e `status = 'sent'`, em ordem de `created_at` e `id`. Nunca `system`,
  nunca nota interna. Depois de escrever cada resposta no stream, a rota a marca `delivered`, e só
  onde ela ainda está `sent`. `sending`, `queued` e `failed` ficam como estão: são do worker de envio.
  Não há cursor. Uma resposta que chega `sent` atrasada, depois de outra mais nova, sai na leitura
  seguinte.
- A rota de eventos lê o banco a cada 2 segundos enquanto está aberta, filtrando `organization_id` e
  `conversation_id` à mão, porque usa o cliente admin. **A medir:** a carga é de 30 leituras por minuto por visitante com a janela aberta. Se
  pesar, a troca é por `LISTEN/NOTIFY`, numa fatia própria. Sem `UPSTASH_*`, o limite fica em memória
  por processo, como em todo o produto, e isso fica escrito.
- Chave que não existe, conexão arquivada, conexão de organização suspensa e módulo desligado
  respondem o mesmo `404`, sem dizer qual dos quatro.
- **Gate de suporte:** as duas rotas `POST` públicas entram como exceção escrita em
  `tests/unit/suporte-cobertura-de-efeitos.test.ts`, com o motivo: quem chama é o visitante, que
  não tem sessão, e o acompanhamento de suporte nunca age por elas. A rota de quem administra
  continua com `requireSupportWrite(`.
- **Auditoria:** a mensagem não é auditada, porque ela é o próprio registro. A recusa de visitante
  também não, porque uma rota pública auditando recusa deixaria qualquer um encher uma tabela que
  só cresce e vive 5 anos. Recusas vão ao registro estruturado e a um contador do dia em
  `channel_sessions.metadata.webchat.recusas`, que a tela da F2 mostra.
- **O que não é gravado:** IP do visitante. O `visitante_id` mora só na `social_identity` do contato
  e no `provider_conversation_id` da conversa.
- **Resultado da anonimização (medido):** anonimizar o contato limpa a `social_identity`. O gatilho
  `trg_redigir_conversas_ao_anonimizar` (migração 0494, última definição no baseline) zera
  `contacts.social_identity` quando `is_anonymized` vira verdadeiro, na mesma transação. Nenhuma
  função precisou de conserto. O invariante `tests/invariants/webchat-nao-alcanca-outro-tenant.test.ts`
  prova a limpeza e que o contato de outra organização fica intacto. O visitante que voltar com o
  mesmo token começa um contato novo.
- **A volta depois de anonimizar:** o visitante que volta com o mesmo token ganha um contato novo e
  uma conversa nova. A rota de eventos segue a conversa mais recente do visitante na conexão
  (`conversaDoVisitante`, a mesma regra de achar a conversa da ingestão), e por isso as respostas
  dela saem no stream. O invariante prova o caso.

**Testes que entram na F1** (os que hoje reprovam um provider novo, mais os novos):

- os exaustivos: `tests/unit/channel-capability-matrix.test.ts:21`,
  `tests/unit/redes-sociais-pelo-modelo-neutro.test.ts:138`,
  `tests/invariants/channel-provider-schema.test.ts`,
  `tests/invariants/canal-da-conversa-banco-x-catalogo.test.ts` e
  `lib/ai/elegibilidade/testador-social.test.ts:60`;
- o isolamento entre organizações num **invariante com Postgres real**
  (`tests/invariants/webchat-nao-alcanca-outro-tenant.test.ts`, `pnpm test:db`), e não só no dublê:
  chave de A não grava em B; a leitura das respostas de A não traz nada de B; dois visitantes de uma
  mesma organização não leem a conversa um do outro; anonimizar limpa a `social_identity`;
- os casos das rotas, em `tests/unit/`, listados em [Como provar](#como-provar).

**Definição de pronto da F1:** fragmento em `.changes/` (`capacidade_nova`), textos novos em
`lib/i18n/dicionario.ts` e o mapa `docs/architecture/canal-do-chat-no-site.architecture.json`.

### F2 — A janela e o link

Status: **F2-A entregue (esta especificação)**. O que a F2-A entrega:
- `GET /webchat.js?k=<chave>`: script da bolha em `public/`, sem dependências.
- `/chat/<chave>`: janela em HTML de route handler com CSP `frame-ancestors` por conexão.
- Coleta, consentimento de LGPD, domínios, código para colar, giro da chave e pausa.
- A pausa vive em `metadata.webchat.pausado` (configuração da conexão, NÃO em `channel_sessions.status`); entrou na F2-A (saiu da F3).
- Módulo `canal_webchat` desligado de fábrica; zero conexões é um estado completo.

O que fica para a F2-B (formatos e ajustes de aparência):
- Formatos da janela (bolha, painel, embutido, página inteira) e posição (direita/esquerda).
- Avatar, auto-abrir, som, badge de não lidas e respostas rápidas.

- `GET /webchat.js?k=<chave>`: um script pequeno, sem dependências, que cria a bolha e um iframe
  para `/chat/<chave>`. O script só lê da página o `location.href`, o `referrer` e as UTMs da URL,
  e os passa ao iframe por `postMessage`, com a origem conferida.
- `/chat/<chave>`: a janela do chat. Ela serve dentro do iframe e também como link direto, para bio,
  e-mail ou QR. Leva a marca da organização (`marcaDaSaida(org)`), nunca a do produto.
- **Antes da primeira mensagem**, a janela mostra um aviso curto com o controlador dos dados:
  `legal_name` e `privacy_policy_url` da organização da conexão. Não se usa `resolverOperador()`,
  que lê a sessão; entra um leitor novo em `lib/legal/`, que recebe o `organization_id` vindo da
  chave. O aceite fica em `messages.metadata.webchat_aceite` da primeira mensagem (a versão do texto
  e a hora).
- **Coleta:** nome, telefone e e-mail, cada um oculto, opcional ou obrigatório, como a empresa
  configurar.
- **Tela:** a aba "Chat no site" em Conexões (`ConexoesShell`), que só aparece com o módulo ligado.
  Nela ficam a aparência, os textos, a coleta, os domínios permitidos, o giro da chave, a pausa e o
  código para colar no site.
- A janela `/chat/<chave>` responde com `Content-Security-Policy: frame-ancestors` montado da lista
  de domínios permitidos. `next.config.ts` passa a excluir `/chat/` do `X-Frame-Options: DENY`
  global: com o DENY, nenhum navegador mostra o iframe. Lista vazia vale `frame-ancestors 'none'`
  (só o link direto funciona).
- `webchat.js` e `/chat/` entram em `lib/auth/public-paths.ts`.

### F3 — Horário

Status: **F3 entregue** (Tarefas 1 a 3 da fatia; sem migration e sem variável de ambiente nova).

- O chat usa o horário do agente que atende a conexão (`agent-config.ts`). Fora da janela, o turno é
  adiado como já acontece hoje, e a janela do chat mostra o aviso de fora do horário que o agente já
  tem configurado.
- Sem agente na conexão, ou com todos os agentes dela pausados ou arquivados, a janela mostra "Recebemos sua mensagem. Nossa equipe responde por aqui." depois do primeiro envio aceito, uma vez por carga da janela. A conversa espera a equipe.
- Com a janela fechada e sem aviso configurado no agente, o texto padrão diz a hora da volta, no horário do aparelho do visitante.
- Se a leitura do horário falhar, o chat segue como aberto e o erro vai ao log. O chat não fica mudo por erro de leitura.
- Ficou de fora, de propósito: o feriado nacional (`fechado_em_feriado_nacional` precisa do país da organização), o horário próprio do canal (o horário é o do agente) e o formulário de recado fora do horário (a mensagem do visitante já vira conversa e lead pelo pós-entrada).
- Também fora desta fatia: o aviso automático que o motor manda pelo canal (`enviaAvisoForaDoHorario`). A chegada dele à janela do chat fica para a F4, medida junto do agente.

### F4 — Agente, passagem e teto do visitante anônimo

- O agente atende o canal pela regra de elegibilidade que já existe, e a passagem para a equipe é a
  de hoje.
- **Teto do visitante anônimo (entregue na F4, Tarefa 2).** Enquanto o visitante não deixou telefone
  nem e-mail, a IA responde até um número de vezes por conversa: padrão 20, configurável na aba
  "Chat no site" em Conexões. Passado o teto, a IA para de responder, o visitante recebe uma frase
  pedindo telefone ou e-mail, e a conversa passa para a equipe com aviso na Central. O motivo:
  cada mensagem anônima pode custar uma chamada à IA, e o teto mensal da organização (`ai_budgets`)
  vem desligado de fábrica. Quem deixa telefone ou e-mail sai deste teto (segue o teto por conversa
  que já existe, `teto-de-respostas.ts`, que continua valendo para todos). O teto chega ao motor
  pelos dois caminhos de leitura (pg e supabase), com o mesmo resultado. O código mora em
  `lib/channels/teto-do-anonimo.ts` (`tetoDoAnonimoDoCanal`) e no gate de elegibilidade
  (`lib/ai/elegibilidade/gate.ts`, motivo `teto_do_visitante_anonimo`).
- **Frase e passagem no teto (F4-A).** O drain (`lib/agent-engine/edge/crm/drain.ts`) deixa o
  veto `teto_do_visitante_anonimo` virar turno, porque é o turno que avisa e passa, e o handler do
  job deixa esse veto seguir, com o roteador escolhendo o agente sem classificar (sem gasto de
  modelo); no agente assistido ele para ali, sem rascunho. No turno do agente (`inbound-turn.ts`),
  a escolta respeita a janela de envio do canal (fora dela o turno é adiado para a abertura, como
  qualquer resposta); pedido de parar e pedido de uma pessoa vencem o teto (nos dois modos eles
  seguem as detecções de sempre, com o aviso delas); a frase ao visitante sai antes da passagem, e
  aviso que falha não impede a passagem. Passagem que falha derruba o turno, sem chamar o modelo, e o job tenta de novo; a nova
  tentativa só recupera a falha anterior ao `force_human` (a passagem não é uma transação: depois
  dele, o job termina no veto de handoff). Contato fora do público do agente segue em silêncio, e
  a restrição comercial não passa na frente da escolta. A passagem grava `origem = 'teto_do_anonimo'` e `motivo_codigo =
  'teto_do_visitante_anonimo'` (migration 9505). Depois dela, o `force_human` veta a IA antes do
  teto, então a frase não se repete enquanto a conversa está com a equipe; quem a devolve ao
  automático, com o visitante ainda anônimo e no limite, volta a receber a frase e a passagem.
  **Não coberto:** o worker de quem ainda não publicou agente (`workers/ai-response-worker.ts`)
  continua só parando a IA no teto, sem frase nem passagem: ali o veto acontece antes de existir a
  fronteira do atendimento que a passagem exige.
- **Pendente (F4-B):** "pode ser o mesmo contato" e "Continuar no WhatsApp": se o telefone ou
  e-mail digitado no chat já é de outra ficha, a tela de Duplicados mostra o par para conferir
  (nunca junta sozinho), e a janela ganha o botão opcional "Continuar no WhatsApp" com o código
  `dk1`.
- **Contato deixado no chat.** O telefone e o e-mail que o visitante digita entram na ficha do
  contato do chat. O CRM **nunca** junta fichas sozinho, porque qualquer um pode digitar o telefone
  de outra pessoa. Se o dado bater com outra ficha, a tela de Duplicados mostra o par como motivo
  forte (Spec 31), e a pessoa decide.
- **"Continuar no WhatsApp".** Um botão opcional abre o `wa.me` da conexão escolhida, com o código
  `dk1` de `lib/leads/origem-do-site.ts`, que leva a página e as UTMs junto.

### F5 — Origem e relatório

Status: **F5 entregue** (código das tarefas 1 e 2 da fatia; sem migration e sem variável de ambiente nova).

- **Entrou:**
  - A janela manda, na primeira mensagem, a página (`href`), a origem (`referrer`) e as UTMs, só os campos com valor. A janela corta cada valor em 200 caracteres antes de enviar, e a rota recusa campo que não conhece (422).
  - A ingestão grava a página em `metadata.webchat_pagina` da primeira mensagem. Com UTM válida, estampa a origem no contato pela mesma função da landing com `wa.me` (`estamparOrigemDaPagina`), com a guarda de primeiro toque do banco. Se a estampa falhar, vira aviso no log e a mensagem entra do mesmo jeito.
  - Da segunda mensagem em diante o contexto é ignorado.
  - O selo "Chat no site" na Inbox e o relatório por canal (`fn_channel_metrics`, por conexão) já existiam: a conexão do chat aparece neles sem código novo.
- **Não entrou:**
  - Relatório por página de origem. O relatório agrupa por canal; por página fica para quando um pedido for medido.
  - Não medido: o filtro de canal da Inbox pela conexão do chat, e o rótulo de origem do chat na ficha do contato pela tela.

## Fora desta spec (de propósito)

- **Anti-robô de serviço externo** (Turnstile e parecidos): ele manda dado do visitante para fora.
  Pode vir depois, desligado de fábrica. O limite por IP e por visitante fica sempre ligado.
- **Arquivo, foto e áudio do visitante:** só texto, até haver um pedido medido.
- **Mais de uma conexão por organização.**
- **Chamada de voz pelo chat.**
- **Integração específica com um construtor de sites.** O script serve a qualquer página, e um
  construtor que queira instalá-lo sozinho usa o mesmo script.

## Como provar

Cada prova tem uma sabotagem: tirar a regra e ver o teste ficar vermelho.

| O que precisa ser verdade | Prova | Sabotagem |
|---|---|---|
| A chave da organização A nunca grava nem lê na B | invariante com Postgres real, duas organizações (`tests/invariants/webchat-nao-alcanca-outro-tenant.test.ts`) | tirar o filtro de `organization_id` em `lerSaidasNovas` (`lib/channels/webchat/eventos.ts`) |
| O token de um visitante não lê a conversa de outro | invariante, dois visitantes da mesma organização | resolver a conversa por parâmetro do pedido, e não pelo token |
| Token adulterado ou de outra conexão é recusado | caso direto | aceitar o token sem conferir a assinatura ou a conexão |
| Site fora da lista não consegue mostrar a janela | `frame-ancestors` da resposta de `/chat/<chave>` só lista os domínios cadastrados | montar o cabeçalho com `*` |
| Os eventos não vazam nota interna nem mensagem de sistema | caso com uma nota e uma `system` na conversa | tirar o filtro de `direction` e `type` |
| UUID repetido de outro visitante não engole a mensagem | dois visitantes mandando o mesmo UUID | gravar o UUID cru como `external_id` |
| Módulo desligado, nada responde | as três rotas com o módulo desligado | esquecer o `moduloLigado` numa rota |
| Reenvio não duplica | a mesma mensagem duas vezes | tirar a captura do `23505` |
| A mensagem passa pelo pós-entrada | o pedido de parar enviado pelo chat bloqueia o contato, e o lead nasce | gravar a mensagem sem chamar o pós-entrada |
| A resposta sai pelo handler comum | o agente responde, e a rota de eventos entrega | adaptador que não devolve `externalId` |
| O vocabulário do banco é igual ao do TypeScript | `channel-provider-schema.test.ts` e o par de `canais-de-conversa.ts` | esquecer `webchat` no CHECK |
| A origem do negócio não cai em WhatsApp | caso direto em `origem-do-negocio.ts` | tirar o ramo `webchat` |
| Teto do anônimo (F4) | a 21ª mensagem sem contato não chama a IA | contar só as mensagens de quem deixou contato |
| O CRM nunca junta fichas sozinho (F4) | telefone igual ao de outra ficha gera um par em Duplicados, sem mesclar | mesclar na ingestão |
| Zero conexões | e2e sem o módulo: nenhuma aba e nenhuma rota | mostrar a aba com o módulo desligado |

**Prova pela tela, da F2 em diante.** Em banco fresco do `baseline.sql`, com as variáveis opcionais
ausentes:

1. ligar o módulo e criar a conexão;
2. colar o script numa página local;
3. conversar como visitante;
4. ver a conversa na Inbox, com o selo;
5. responder pela Inbox e ver a resposta na janela;
6. desligar o módulo e ver o script parar.

## Sistema vivo

1. **Quem me alimenta:** a página do cliente, pelo script.
2. **Quem eu alimento:** a Inbox, o funil (o lead nasce pelo pós-entrada) e o agente.
3. **Registro:** as mensagens, e a auditoria da conexão e das recusas por origem.
4. **Onde apareço:** em Conexões › Chat no site, e no selo da Inbox.
5. **Porta:** a aba condicional em Conexões, que já está em `lib/navigation/catalogo.ts`.
6. **Anti-morte:** a conversa sem resposta segue a regra de qualquer canal, e o visitante vê que a
   mensagem foi recebida.
7. **Configuração:** tudo na tela da conexão; o módulo em Recursos opcionais.
8. **Continuidade IA↔humano:** a mesma de qualquer canal.
9. **Laço de retorno:** a recusa por origem e o teto do anônimo aparecem na tela da conexão, e a
   pessoa ajusta a lista ou o teto.
10. **Mapa:** `docs/architecture/canal-do-chat-no-site.architecture.json`, feito na parte 1, ao lado de
    `canal-do-robo.architecture.json`. A janela e a tela da conexão entram no mapa quando existirem.

## Destino

**Núcleo, com módulo opcional desligado de fábrica**, como o Telegram. Uma extensão não consegue
fazer isto hoje, porque extensão não tem código, rota nem canal. Se nenhuma organização ligar o
módulo, a operação comum continua inteira.

## Primeiro consumidor

O Vortta, um construtor de sites separado do CRM, instala o script por um bloco do template, que
vem desligado de fábrica. O Vortta não guarda nada da conversa. Qualquer outro site usa o mesmo
script, colado à mão.

## Decisões onde a #1333 não decide

1. **O token de visitante fica no armazenamento da janela, e não em cookie.** O navegador bloqueia
   cookie de terceiro dentro de iframe. Perder o armazenamento só começa outra conversa.
2. **A chave e os domínios vão em coluna; a aparência vai em `metadata.webchat`, com schema
   central.** O que decide a segurança não mora em jsonb.
3. **A rota de eventos lê o banco pelo estado da mensagem (`sent`), sem cursor e sem serviço novo.** A troca por `LISTEN/NOTIFY` fica
   para quando a carga for medida. O token vai em cabeçalho, então a janela lê com `fetch`, e não
   com `EventSource`.
4. **Só texto, da F1 à F5.**
5. **O teto do anônimo é por conversa e conta as respostas da IA.** Ele é separado do teto mensal
   da organização.
6. **O chat não conta na vaga de canais do plano** (`fn_trava_canais_do_plano` passa a ignorá-lo,
   como já ignora o `wacalls`). Ele não tem custo por mensagem nem risco de banimento, e contar
   faria o revendedor cobrar por um canal que não lhe custa nada. O mantenedor pode inverter na
   revisão: é uma linha na função.
7. **Desligar o módulo para tudo, inclusive conexão já criada**, ao contrário do Telegram. Lá o robô
   segue existindo no Telegram; aqui a janela é servida pelo próprio CRM.
8. **A recusa de visitante não vai para a auditoria**, e sim para o registro e um contador do dia:
   rota pública que audita recusa vira um jeito de encher uma tabela que só cresce.
9. **A chave do token sai do `INTERNAL_SECRET`**, com prefixo próprio, sem variável nova.
