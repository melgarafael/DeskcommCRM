# Chat no site, parte 1 (F1): plano de implementação

> **Para quem implementa:** use superpowers:subagent-driven-development ou superpowers:executing-plans,
> tarefa por tarefa. Os passos usam caixas (`- [ ]`) para acompanhar.

**Objetivo:** o canal `webchat` existe no CRM. Uma conexão por organização é criada pela rota de quem
administra. Um visitante com a chave pública abre sessão, manda mensagem e recebe as respostas por
stream. A mensagem passa pelo pós-entrada como qualquer canal. Não há tela de cliente final nesta
parte.

**Arquitetura:** segue o caminho do Telegram (PR #3486, migration 9342), peça por peça. A ingestão
vive em `lib/channels/webchat/`, o adaptador em `lib/channels/adapters/webchat.ts` e as rotas
públicas em `app/api/v1/webchat/`. A organização sai sempre da chave ou do token, nunca do pedido.

**Tecnologia:** Next.js 16 Route Handlers, Supabase admin client, Zod, `node:crypto` (HMAC) e Vitest.

**Spec:** `docs/specs/36-spec-chat-no-site.md`, principalmente as seções "Como as peças se falam",
"F1", "Como provar" e "Decisões onde a #1333 não decide". Leia a spec inteira antes da tarefa 1.

## Restrições globais

- **Teste só no GitHub.** Nada de suíte, vitest ou Docker na máquina local; o veredito é o CI do
  fork.
  - Em cada tarefa, empurre primeiro o commit só com o teste: o CI precisa ficar vermelho naquele
    teste.
  - Depois empurre a implementação: o CI precisa ficar verde.
  - Depois, quem confere sabota a regra e vê o teste ficar vermelho.
- Número da migration: `pnpm checar:colisao-de-migration` logo antes de criar o arquivo. Nunca pelo
  último arquivo da pasta (o teto da `main` em 20/11/2026 era 9432).
- A migration é idempotente, em `psql` puro, sem `BEGIN`/`COMMIT`, com a linha `-- manifest:`. Leva
  o apêndice no `supabase/baseline.sql`, somando o valor novo **no bloco único de cada CHECK**, como a
  9342 fez (`baseline.sql:88019`).
- Toda função nova em `public` leva `revoke execute ... from public, anon`.
- Rota que usa o cliente admin filtra `organization_id` à mão, vindo da chave ou do token.
- Zod em todo corpo. Respostas por `ok()`/`fail()` de `lib/api/wrappers.ts`, com `X-Request-Id`.
- Nada de `console.log`. Textos novos em `lib/i18n/dicionario.ts`.
- Nenhuma variável de ambiente nova: o token deriva de `INTERNAL_SECRET`.
- O texto público (commit, PR) não cita decisões internas. Assinatura dos textos públicos:
  "— Paulo Lima Jr".

## O que mais pode dar errado (e o teste que fica de olho)

1. **Visitante B lendo a conversa de A da mesma organização**, trocando parâmetros. Teste na
   tarefa 9: a conversa sai só do token.
2. **Nota interna ou mensagem de sistema vazando para o visitante.** Teste na tarefa 9: o filtro de
   `direction`, `type` e estado.
3. **Texto vazio, só espaços, com mais de 2.000 caracteres, ou com caracteres de controle.** Teste
   na tarefa 8: 422, e nada é gravado.
4. **Token vencido, adulterado ou de outra conexão.** Teste na tarefa 4: recusa sem lançar exceção.
5. **Módulo desligado só na empresa, e ligado na instalação.** Teste na tarefa 6: as rotas
   respondem 404 para aquela organização.

---

### Task 1: banco: vocabulário, colunas e trava do plano

**Arquivos:**
- Criar: `supabase/migrations/<timestamp>_<NNNN>_canal_chat_no_site.sql`
- Alterar: `supabase/baseline.sql` (os blocos únicos de `channel_sessions_provider_check`,
  `channel_sessions_provider_ref_check`, `conversations_channel_check` e `fn_trava_canais_do_plano`,
  mais o apêndice)
- Teste: `tests/invariants/canal-chat-no-site-banco.test.ts` (`pnpm test:db`)

**Interfaces:**
- Produz:
  - as colunas `channel_sessions.webchat_public_key text` e
    `channel_sessions.webchat_allowed_origins text[] not null default '{}'`;
  - o índice único parcial `channel_sessions_webchat_public_key_ativa_unique` (`where archived_at is
    null`);
  - a função `public.fn_webchat_origens_validas(text[]) returns boolean immutable`;
  - o valor `webchat` aceito nos CHECKs de provider e de canal.

- [ ] **Passo 1: o teste.** `canal-chat-no-site-banco.test.ts`, com estes casos:
  - aceita `provider='webchat'` com chave; recusa sem chave (`provider_ref_check`);
  - aceita `conversations.channel='webchat'`;
  - recusa 21 origens; recusa `https://a.com/caminho`; recusa `http://a.com`; aceita
    `https://a.com` e `https://a.com:8443`;
  - duas conexões ativas com a mesma chave → `23505`;
  - com o plano em `max_canais = 1`, criar uma conexão de WhatsApp e depois uma de `webchat` não dá
    `PT402`.
- [ ] **Passo 2:** empurrar só o teste; o CI (`invariants`) fica vermelho nestes casos.
- [ ] **Passo 3: a migration e o apêndice.** `fn_trava_canais_do_plano` troca
  `new.provider = 'wacalls'` por `new.provider in ('wacalls','webchat')`.
- [ ] **Passo 4:** empurrar; o `invariants` fica verde, inclusive o install e o update do baseline.
- [ ] **Passo 5: commit** `feat(canais): o banco aceita o canal de chat no site`.

### Task 2: o canal no seam do TypeScript

**Arquivos:**
- Alterar:
  - `lib/channels/types.ts`, `lib/channels/session-ref.ts`, `lib/channels/capabilities.ts`;
  - `lib/channels/index.ts`, `lib/channels/templates-fonte.ts`, `lib/channels/canais-de-conversa.ts`;
  - `lib/channels/origem-do-negocio.ts`, `lib/ai/elegibilidade/pre-go-live.ts:34`;
  - `lib/channels/presentation.ts`, `lib/channels/marca-do-canal.ts`,
    `lib/operacao/texto-do-relatorio.ts:37`;
  - `app/globals.css` (`--color-canal-webchat`, nos três blocos de tema, como `--color-canal-*`).
- Testes que mudam:
  - `tests/unit/channel-capability-matrix.test.ts:21`;
  - `tests/unit/redes-sociais-pelo-modelo-neutro.test.ts:138`;
  - `lib/ai/elegibilidade/testador-social.test.ts:60`, que continua `["facebook","instagram"]`.
- Teste novo: `tests/unit/channel-webchat-seam.test.ts`

**Interfaces:**
- Consome: a tarefa 1.
- Produz:
  - `ChannelProvider` inclui `"webchat"`;
  - `ChannelSessionRef` ganha `{ provider: "webchat"; webchat_public_key: string }`;
  - `origemDoNegocioPeloCanal("webchat")` devolve `{ rotulo: "Chat no site", source: "webchat" }`.

- [ ] **Passo 1: o teste.** `channel-webchat-seam.test.ts`:
  - `capabilitiesOf("webchat")` igual a `{ freeformOutsideWindow: true, minIntervalMs: 0, voiceNote:
    "none", groups: "none" }`, com as outras chaves `false`;
  - `webchat` fora de `PROVIDERS_DE_TELEFONE` e dentro de `PROVIDERS_SEM_CAMPANHA`;
  - `ehCanalDeConversa("webchat")` é `true`;
  - `origemDoNegocioPeloCanal("webchat").source` é `"webchat"`;
  - `REDES_COM_TESTADOR_SOCIAL` não contém `webchat`;
  - `resolveSessionRef` de uma linha `webchat` devolve a chave.
- [ ] **Passo 2:** empurrar só os testes; o `verify` fica vermelho.
- [ ] **Passo 3:** implementar. O `getAdapter` aponta para a tarefa 3. Até ela entrar, a tarefa 2 e a
  3 vão no mesmo push.
- [ ] **Passo 4:** empurrar; o `verify` e o `invariants` ficam verdes (`channel-provider-schema` e
  `canal-da-conversa-banco-x-catalogo` passam a ver `webchat` dos dois lados).
- [ ] **Passo 5: commit** `feat(canais): o chat no site entra no seam de canais`.

### Task 3: o adaptador

**Arquivos:**
- Criar: `lib/channels/adapters/webchat.ts`
- Teste: `tests/unit/channel-webchat-adapter.test.ts`

**Interfaces:**
- Produz: `webchatAdapter: ChannelAdapter` com:
  - `provider: "webchat"`;
  - `isConfigured(): true`;
  - `resolveRecipient(): "provider-chat"`;
  - `send(envelope) → { externalId: "wc:<channel_session_id>:out:<uuid>" }`;
  - `codes` no molde de `adapters/telegram.ts`.

- [ ] **Passo 1: o teste.**
  - `send` com `kind: "text"` devolve um `externalId` que casa com
    `/^wc:[0-9a-f-]{36}:out:[0-9a-f-]{36}$/` e não faz `fetch`;
  - `send` com `kind: "image"` rejeita com o código de tipo não suportado, igual ao do Telegram;
  - `resolveRecipient(...)` devolve `"provider-chat"`.
- [ ] **Passos 2 a 4:** vermelho, implementar, verde (pode ir no push da tarefa 2).
- [ ] **Passo 5: commit** `feat(canais): adaptador do chat no site`.

### Task 4: o token de visitante

**Arquivos:**
- Criar: `lib/channels/webchat/token.ts`
- Teste: `tests/unit/webchat-token.test.ts`

**Interfaces:**
- Produz:
  - `assinarTokenDeVisitante(p: { channelSessionId: string; visitanteId: string; agora: Date }): string`
  - `lerTokenDeVisitante(token: string, agora: Date): { ok: true; channelSessionId: string;
    visitanteId: string; expiraEm: Date; renovar: boolean } | { ok: false; motivo: "formato" |
    "assinatura" | "vencido" | "segredo_ausente" }`
- Valores fixos:
  - o formato e a validade da spec (`v:1`, 30 dias, `renovar` quando faltar menos de 7);
  - o HMAC-SHA256 sobre o corpo, com o prefixo `deskcomm:webchat-visitante:v1:` e o
    `INTERNAL_SECRET`, comparado com `timingSafeEqual`.

- [ ] **Passo 1: o teste.**
  - ida e volta;
  - um byte trocado no corpo dá `assinatura`;
  - `agora` + 31 dias dá `vencido`;
  - `agora` + 24 dias dá `renovar: true`;
  - sem `INTERNAL_SECRET`, assinar lança `webchat_token_secret_missing` e ler devolve
    `segredo_ausente`;
  - lixo sem ponto dá `formato`, sem lançar.
- [ ] **Passos 2 a 4:** vermelho, implementar, verde.
- [ ] **Passo 5: commit** `feat(webchat): token assinado do visitante`.

### Task 5: a ingestão

**Arquivos:**
- Criar: `lib/channels/webchat/ingest.ts`
- Teste: `tests/unit/channel-webchat-ingest.test.ts`, com o cliente falso de
  `tests/unit/helpers/cliente-admin-falso.ts`, no molde de `channel-telegram-ingest.test.ts`

**Interfaces:**
- Consome: a tarefa 2; `marcarConversaComMensagem`; `aplicarEfeitosPosEntrada`.
- Produz: `ingerirMensagemDoChat(admin, p: { organizationId: string; channelSessionId: string;
  visitanteId: string; mensagemId: string; texto: string; agora: Date }) → Promise<{ status:
  "ingested" | "duplicate"; conversationId: string; messageId: string | null }>`

- [ ] **Passo 1: o teste.**
  - o contato nasce com `social_identity = "webchat:<cs>:<vis>"`, nome `"Visitante do site"` e
    `phone_number` nulo;
  - a conversa fica com `channel = "webchat"` e `provider_conversation_id = <vis>`;
  - a mensagem tem `external_id = "wc:<cs>:<vis>:<mensagemId>"`;
  - a segunda chamada com o mesmo `mensagemId` dá `duplicate`, sem lançar;
  - o mesmo `mensagemId` vindo de **outro** visitante grava (é `external_id` diferente);
  - `aplicarEfeitosPosEntrada` é chamado uma vez, com `canal: "webchat"`, e
    `marcarConversaComMensagem` também.
- [ ] **Passos 2 a 4:** vermelho, implementar, verde. A conversa nasce pelo caminho do Telegram
  (`lib/channels/bot/ingest.ts:200-229`).
- [ ] **Passo 5: commit** `feat(webchat): ingestão pelo pós-entrada`.

### Task 6: o módulo opcional

**Arquivos:**
- Alterar:
  - `lib/instalacao/modulos.ts`: `canal_webchat` em `MODULOS_OPCIONAIS`,
    `MODULOS_OPCIONAIS_POR_FLAG` e `MODULOS_POR_EMPRESA`, com a chave `MODULO_CANAL_WEBCHAT`;
  - `lib/recursos-opcionais/catalogo.ts`;
  - `app/admin/(protected)/sistema/_form.tsx`.
- Teste:
  - `tests/unit/porta-do-modulo-ligado.test.tsx`;
  - novo `tests/unit/webchat-modulo.test.ts`.

**Interfaces:**
- Produz: `chatNoSiteLigado(admin, organizationId: string): Promise<boolean>`, em
  `lib/channels/webchat/modulo.ts`, que chama `moduloLigado(admin, "canal_webchat", organizationId)`.

- [ ] **Passo 1: o teste.**
  - sem linha em `platform_config`, o resultado é `false`;
  - com `ligado` na instalação, é `true`;
  - com `ligado` na instalação e desligado na empresa, é `false`.
- [ ] **Passos 2 a 4:** vermelho, implementar, verde.
- [ ] **Passo 5: commit** `feat(webchat): módulo opcional desligado de fábrica`.

### Task 7: a rota de quem administra

**Arquivos:**
- Criar:
  - `app/api/v1/channels/webchat/route.ts` (`GET`, `POST`, `PATCH`);
  - `app/api/v1/channels/webchat/girar/route.ts` (`POST`);
  - `lib/channels/webchat/config.ts` (o schema Zod de `metadata.webchat` e da lista de origens).
- Teste: `app/api/v1/channels/webchat/route.test.ts`, no molde de
  `app/api/v1/channels/bot/route.test.ts`

**Interfaces:**
- Produz:
  - `POST` devolve `{ data: { id, public_key, allowed_origins } }`;
  - `PATCH` aceita `{ allowed_origins?: string[]; config?: ConfiguracaoDoChat }`;
  - `girar` devolve a chave nova;
  - `configuracaoDoChatSchema` e `origensPermitidasSchema(instalacaoEmLoopback: boolean)`.

- [ ] **Passo 1: o teste.**
  - papel `manager` recebe 403;
  - em acompanhamento de suporte, recebe 403 (`requireSupportWrite`);
  - com o módulo desligado, recebe 404;
  - o segundo `POST` da mesma organização dá 409;
  - `http://localhost:3000` só é aceito com a instalação em loopback;
  - girar invalida a chave antiga (a linha muda);
  - cada sucesso chama `audit` com `channel.webchat_created`, `channel.webchat_updated` ou
    `channel.webchat_key_rotated`;
  - a conexão nasce com `display_name: "Chat no site"` e `status: "WORKING"`.
- [ ] **Passos 2 a 4:** vermelho, implementar, verde.
- [ ] **Passo 5: commit** `feat(webchat): conexão criada por quem administra`.

### Task 8: as rotas públicas de sessão e de mensagens

**Arquivos:**
- Criar:
  - `app/api/v1/webchat/sessao/route.ts`;
  - `app/api/v1/webchat/mensagens/route.ts`;
  - `lib/channels/webchat/conexao-pela-chave.ts`.
- Alterar:
  - `lib/auth/public-paths.ts` e `lib/auth/public-paths.test.ts`;
  - `tests/unit/suporte-cobertura-de-efeitos.test.ts`: exceção escrita para `app/api/v1/webchat/`,
    com o motivo da spec.
- Teste: `tests/unit/webchat-rotas-publicas.test.ts`

**Interfaces:**
- Consome: as tarefas 4, 5 e 6.
- Produz: `conexaoPelaChave(admin, chave: string) → Promise<{ id: string; organizationId: string;
  config: ConfiguracaoDoChat } | null>`. Ela devolve `null` nos quatro casos de 404 da spec.

- [ ] **Passo 1: o teste.**
  - chave inexistente, conexão arquivada, organização suspensa e módulo desligado dão o mesmo 404,
    com o mesmo corpo;
  - `sessao` sem token devolve um token novo; com um token válido da mesma conexão, devolve o mesmo
    `visitante_id`; com um token de outra conexão, devolve um token novo;
  - `mensagens` sem `Authorization` dá 401;
  - texto vazio, só espaços, com 2.001 caracteres ou com `\u0000` dá 422, e nada é gravado;
  - o 21º envio em um minuto dá 429 com `Retry-After`;
  - o sucesso responde 201 sem esperar a IA;
  - com `renovar`, a resposta traz `token_novo`.
- [ ] **Passos 2 a 4:** vermelho, implementar, verde. Os limites usam `checkRateLimit` com o balde
  `webchat:<rota>:<ipDoCliente ou visitante>`.
- [ ] **Passo 5: commit** `feat(webchat): rotas públicas de sessão e mensagem`.

### Task 9: a rota de eventos

**Arquivos:**
- Criar:
  - `app/api/v1/webchat/eventos/route.ts`;
  - `lib/channels/webchat/eventos.ts` (a consulta e o cursor).
- Teste: `tests/unit/webchat-eventos.test.ts`

**Interfaces:**
- Produz:
  - `lerSaidasDepoisDe(admin, p: { organizationId: string; conversationId: string; cursor: string |
    null; limite: number }) → Promise<{ mensagens: Array<{ id: string; texto: string; em: string }>;
    cursor: string | null }>`;
  - `assinarCursor` e `lerCursor`, com HMAC no mesmo molde da tarefa 4 e o prefixo
    `deskcomm:webchat-cursor:v1:`.

- [ ] **Passo 1: o teste.**
  - entrega só `direction = 'outbound'`, `type = 'text'` e estado fora de `failed` e `queued`;
  - uma nota interna e uma mensagem `system` na conversa não aparecem;
  - a consulta filtra por `organization_id` e `conversation_id` vindos do token (o dublê registra
    os filtros);
  - um cursor adulterado dá 400;
  - a 7ª abertura em um minuto dá 429;
  - a resposta tem `Content-Type: text/event-stream` e fecha em 60 segundos (com relógio injetado).
- [ ] **Passos 2 a 4:** vermelho, implementar, verde.
- [ ] **Passo 5: commit** `feat(webchat): o visitante recebe as respostas por stream`.

### Task 10: isolamento em banco real e o fechamento

**Arquivos:**
- Criar:
  - `tests/invariants/webchat-nao-alcanca-outro-tenant.test.ts`;
  - `docs/architecture/canal-do-chat-no-site.architecture.json`, no molde de
    `canal-do-robo.architecture.json`;
  - `.changes/chat-no-site-parte-1.md` (`capacidade_nova`).
- Alterar:
  - `lib/i18n/dicionario.ts`;
  - `docs/specs/36-spec-chat-no-site.md`: o status passa a "parte 1 implementada" e entra o resultado
    do item do redact.

- [ ] **Passo 1: o invariante.**
  - duas organizações, cada uma com conexão e visitante;
  - a chave de A não cria mensagem na conversa de B;
  - a leitura de saídas com o token de A não traz mensagem de B;
  - dois visitantes de A não leem a conversa um do outro;
  - anonimizar o contato limpa a `social_identity`. Se não limpar, conserte no redact nesta tarefa,
    porque vale também para o Telegram.
- [ ] **Passo 2:** empurrar; o `invariants` fica verde.
- [ ] **Passo 3:** quem confere sabota três vezes e vê o vermelho em cada uma:
  - tirar o filtro de `organization_id` em `lerSaidasDepoisDe`;
  - gravar o UUID cru como `external_id`;
  - tirar `webchat` do CHECK de conversa.
- [ ] **Passo 4: commit** `test(webchat): isolamento entre organizações e fechamento da parte 1`.
