# Chat no site, F2 (a janela e o link) — plano de implementação

> **Para quem executa:** use superpowers:subagent-driven-development (um implementador por tarefa, uma revisão por tarefa, revisão final do branch). Os passos usam `- [ ]`. **Teste só no GitHub:** não rode suíte, vitest nem Docker nesta máquina; o veredito é o CI do fork. Antes de empurrar: skills `deskcomm-doutrina` e `deskcomm-contribuir`, `pre-voo.sh`, `pnpm lint:channels`, revisão cega do diff.

**Meta:** (F2 da #1333, em dois PRs: F2-A e F2-B) quem tem um site cola uma linha de código e a janela do chat aparece; quem recebe um link direto (bio, e-mail, QR) abre a mesma janela. Quem administra configura tudo numa aba "Chat no site" em Conexões.

**Arquitetura:** a janela `/chat/<chave>` é uma resposta de route handler (HTML pequeno, sem React) para o cabeçalho `Content-Security-Policy: frame-ancestors` poder ser montado por conexão, a partir da lista de domínios. O comportamento da janela vive em JavaScript simples servido de `public/`, e conversa com as três rotas públicas da F1. A aba de administração é um componente de cliente nos moldes de `CanalBotClient`.

**Spec:** `docs/specs/36-spec-chat-no-site.md`, seção "F2 — A janela e o link". **Depende da F1** (PR melgarafael/DeskcommCRM#5095): provedor `webchat`, conexão com chave `wck_…`, rotas `/api/v1/webchat/{sessao,mensagens,eventos}`, módulo `canal_webchat`.

## Restrições globais

- Módulo `canal_webchat` desligado ⇒ `/chat/<chave>`, a aba e as rotas respondem como se não existissem (404; aba ausente). Nenhuma organização que não ligue o módulo vê diferença.
- A organização vem sempre da chave (ou do token), nunca de parâmetro livre; todo uso de cliente admin filtra `organization_id`.
- Marca: `marcaDaSaida(organizationId)`, tema claro, nunca a marca do produto. Nenhuma ocorrência de "deskcomm" em código novo.
- Texto do visitante entra na tela só por `textContent`; nunca `innerHTML` com dado de visitante, de organização ou de resposta.
- Nenhuma rota nova de `app/api/v1` sem `requireSupportWrite(` (a janela e os scripts não são rotas de `app/api/v1`).
- Nome de provedor fora de `lib/channels/` quebra `pnpm lint:channels` (inclusive em comentário): nos arquivos novos, "webchat" só em caminho e identificador do próprio canal, como a F1 fez.
- Sem `console.log`; `lib/random-id.ts` em vez de `crypto.randomUUID`; Zod em toda entrada externa.
- Texto de tela passa por `traduzir`/`t` como o resto de Conexões.

## Foco da revisão (o que a spec implica e nenhuma tarefa testaria sozinha)

1. **Site fora da lista embute a janela.** Lista vazia deve render `frame-ancestors 'none'`; lista com dois domínios, os dois e só eles. Teste na Tarefa 3.
2. **XSS pela configuração.** Título, saudação, nome da empresa e URL da política vêm do banco e entram no HTML: escapar, e só devolver URL de política pela régua `urlDePoliticaSegura` (`http`/`https`; `javascript:` e afins viram nulo). Teste na Tarefa 3.
3. **Coleta obrigatória burlada.** O servidor, e não a janela, recusa a primeira mensagem sem o campo marcado como obrigatório. Teste na Tarefa 2.
4. **Aceite de LGPD ausente ou forjado.** A primeira mensagem sem aceite é recusada; o aceite grava a versão do texto e a hora. Teste na Tarefa 2.
5. **`postMessage` de página estranha.** A janela só aceita mensagens de `window.parent`; o script da bolha só aceita mensagens da origem do CRM. Teste nas Tarefas 4 e 5.

## Como a F2 se divide em dois PRs

A #1333 define a F2 como "widget: `widget.js` + `/chat/<slug>` + aparência/formatos + textos + coleta + consentimento", e a tela do canal lista também a pausa. O escopo é o da issue, inteiro, entregue em dois PRs:

- **F2-A — a janela e o link (Tarefas 1 a 6 e 8):** a janela, o script da bolha, o link direto, cor, título e saudação, coleta, consentimento, domínios, código para colar, giro da chave e pausa. É o que dá chamador às rotas da F1.
- **F2-B — formatos e ajustes (Tarefas 9 e 10):** painel lateral, embutido e página inteira; posição, avatar, auto-abrir, som, badge e respostas rápidas.

O horário (janela por dia, feriados, mensagem fora do expediente, captura offline) continua sendo a F3 da issue.

## Decisões técnicas do plano (podem ser trocadas na revisão)

- **`/webchat.js` e `/webchat-janela.js` são arquivos estáticos em `public/`.** A chave vai em `?k=` e o script a lê do próprio endereço. Estático é cacheável pela borda e não toca banco. Custo se errado: virar route handler é trocar o arquivo por uma rota.
- **A janela é HTML de route handler, não página React.** É o único jeito de o CSP variar por conexão sem consultar o banco em `proxy.ts`.

---

### Task 1: Leitor do controlador dos dados

**Files:**
- Create: `lib/legal/controlador-do-chat.ts`
- Test: `lib/legal/controlador-do-chat.test.ts`

**Interfaces:**
- Consumes: `urlDePoliticaSegura(valor: unknown): string | null` de `lib/legal/operador.ts`; cliente admin (`createAdminClient`).
- Produces: `lerControladorDoChat(admin: SupabaseClient, organizationId: string): Promise<{ razaoSocial: string | null; politicaUrl: string | null }>` — nunca lança: em erro de leitura devolve os dois `null` e registra um aviso pelo logger do projeto.

- [ ] **Step 1: Teste que falha** — casos: organização com `legal_name` e `privacy_policy_url` https devolve os dois; URL `javascript:` ou `data:` vira `politicaUrl: null`, e `http:` é devolvido como está (a régua única `urlDePoliticaSegura` aceita `http` e `https`; não se cria segunda régua); o aviso de erro leva `organizationId`; organização inexistente devolve os dois `null`; erro do banco não lança; a consulta filtra por `id = organizationId` (assert no dublê).
- [ ] **Step 2:** o CI do fork mostra o vermelho.
- [ ] **Step 3: Implementar** `lerControladorDoChat` lendo `organizations` (`legal_name`, `privacy_policy_url`) com o `organizationId` recebido. Não chama `resolverOperador()` (ele lê a sessão do usuário, e o visitante não tem sessão).
- [ ] **Step 4:** CI verde. **Step 5: Commit** `feat(chat): leitor do controlador dos dados para a janela pública`.

### Task 2: Aceite de LGPD e coleta na entrada

**Files:**
- Modify: `app/api/v1/webchat/mensagens/route.ts`, `lib/channels/webchat/ingest.ts`, `lib/channels/webchat/config.ts` (exporta `TEXTO_DO_AVISO_VERSAO`)
- Test: `tests/unit/webchat-rotas-publicas.test.ts` (acrescenta casos), `tests/unit/channel-webchat-ingest.test.ts` (acrescenta casos)

**Interfaces:**
- Consumes: `ConexaoPublica.config.coleta` (`{ nome, telefone, email }`, cada um `oculto | opcional | obrigatorio`), contrato atual do corpo de `/mensagens` (`mensagem_id`, `texto`).
- Produces: o corpo de `/mensagens` aceita, além do que já aceita, `aceite?: { versao: string }` (máx. 40) e `contato?: { nome?: string; telefone?: string; email?: string }` (nome ≤ 120, telefone ≤ 30, e-mail válido ≤ 200, todos aparados). `ingerirMensagemDoChat` ganha `aceite?: { versao: string; em: string }` e `contato?` e os grava.

- [ ] **Step 1: Testes que falham** — (a) conversa nova (primeira mensagem do visitante) sem `aceite` ⇒ 422; (b) com `aceite`, a mensagem grava `metadata.webchat_aceite = { versao, em }` e `em` é a hora do servidor, nunca a enviada; (c) mensagens seguintes da mesma conversa não exigem aceite e não o regravam; (d) campo `obrigatorio` ausente na primeira mensagem ⇒ 422; campo `oculto` enviado é ignorado; (e) `contato.nome` preenche o nome do contato no lugar de "Visitante do site", telefone e e-mail vão para os campos do contato; (f) corpo com `organization_id` continua recusado (`.strict()`).
- [ ] **Step 2:** o CI mostra o vermelho.
- [ ] **Step 3: Implementar.** "Primeira mensagem" = o visitante ainda não tem mensagem de entrada na conversa (consulta com `organization_id` e `conversation_id`). A hora do aceite sai do servidor. Contato que já tem nome real não é sobrescrito por campo vazio.
- [ ] **Step 4:** CI verde. **Step 5: Commit** `feat(chat): aceite de LGPD e coleta de contato na primeira mensagem`.

### Task 3: A janela `/chat/<chave>` e o cabeçalho

**Files:**
- Create: `app/chat/[chave]/route.ts`, `lib/channels/webchat/janela-html.ts`
- Modify: `next.config.ts`, `lib/auth/public-paths.ts`, `lib/auth/public-paths.test.ts`
- Test: `lib/channels/webchat/janela-html.test.ts`, `tests/unit/webchat-janela-rota.test.ts`, `tests/unit/chat-cabecalhos.test.ts`

**Interfaces:**
- Consumes: `conexaoPelaChave` (404 idêntico nos quatro casos), `chatNoSiteLigado`, `marcaDaSaida`, `lerControladorDoChat` (Task 1), `TEXTO_DO_AVISO_VERSAO`.
- Produces: `montarJanela(entrada: { chave: string; marca: MarcaDeSaida; config: ConfiguracaoDoChat; controlador: { razaoSocial: string | null; politicaUrl: string | null }; origens: string[] }): { html: string; csp: string }`. `GET /chat/<chave>` responde HTML com `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `Content-Security-Policy: <csp>`; sem `X-Frame-Options`.

- [ ] **Step 1: Testes que falham** — `montarJanela`: lista vazia ⇒ `frame-ancestors 'none'`; dois domínios ⇒ os dois, separados por espaço, e mais nada; título com `<script>` sai escapado; `politicaUrl` `null` ⇒ aviso sem link; o CSP inclui `base-uri 'none'`, `object-src 'none'`, `form-action 'none'`, `default-src 'self'`. Rota: chave inexistente, conexão arquivada, módulo desligado ⇒ mesmo 404 e mesmo corpo; resposta 200 não traz `X-Frame-Options`. Cabeçalhos: o resultado de `headers()` de `next.config.ts` mantém `DENY` e o CSP global em `/app/...` e não os aplica a `/chat/x`, mas mantém `nosniff`, `Referrer-Policy` e HSTS em `/chat/x`. Public-paths: `/chat/<chave>` e `/webchat.js` públicos; `/chat` e `/chat/a/b` não.
- [ ] **Step 2:** o CI mostra o vermelho.
- [ ] **Step 3: Implementar.** O HTML referencia `/webchat-janela.js` e carrega a configuração (chave, textos, coleta, versão do aviso, rótulos) num elemento `<script type="application/json">` com `<` escapado. Cor: `marca.accent` e `marca.accentFg` em variáveis CSS. `next.config.ts`: trocar o `source` global por um que exclua `/chat/` e acrescentar um bloco para `/chat/:path*` só com `nosniff`, `Referrer-Policy`, HSTS e `Permissions-Policy`.
- [ ] **Step 4:** CI verde. **Step 5: Commit** `feat(chat): janela do chat com frame-ancestors por conexão`.

### Task 4: O script da bolha

**Files:**
- Create: `public/webchat.js`
- Test: `tests/unit/webchat-bolha.test.ts`

**Interfaces:**
- Produces: `public/webchat.js`, JavaScript simples (sem dependência, sem módulo), que lê a chave do `?k=` do próprio endereço, cria a bolha e um iframe para `<origem do script>/chat/<chave>`, e envia ao iframe, por `postMessage`, `{ tipo: "contexto", href, referrer, utm }`. Expõe, só quando `typeof module !== "undefined"`, `{ origemDoScript, montarContexto, aceitarMensagem }` para o teste.

- [ ] **Step 1: Testes que falham** — `montarContexto` devolve só `href`, `referrer` e as chaves `utm_*` da URL (nenhum outro parâmetro, nenhum cookie); `aceitarMensagem({origin, source}, origemDoCrm, iframe)` só é verdadeiro se `origin === origemDoCrm` e `source === iframe.contentWindow`; chave ausente no `?k=` não cria nada.
- [ ] **Step 2:** o CI mostra o vermelho.
- [ ] **Step 3: Implementar.** A origem do CRM vem do `src` do script, nunca de parâmetro. O iframe leva `title` e `allow=""`. Abrir e fechar a bolha muda só o tamanho do iframe.
- [ ] **Step 4:** CI verde. **Step 5: Commit** `feat(chat): script da bolha que embute a janela no site`.

### Task 5: O comportamento da janela

**Files:**
- Create: `public/webchat-janela.js`
- Test: `tests/unit/webchat-janela-cliente.test.ts`

**Interfaces:**
- Consumes: `POST /api/v1/webchat/sessao` (corpo `{ chave }`, devolve o token e o que a rota devolve hoje; o implementador lê a rota), `POST /api/v1/webchat/mensagens` (Bearer, `mensagem_id`, `texto`, `aceite?`, `contato?` — Task 2), `GET /api/v1/webchat/eventos` (Bearer, `text/event-stream`).
- Produces: `public/webchat-janela.js`, JavaScript simples. Guarda o token em `localStorage` da origem do CRM, dentro de `try/catch` (a janela funciona sem armazenamento, perdendo só a continuidade). Usa `token_novo`, quando a resposta de `/mensagens` o traz, no lugar do atual. Expõe, só em ambiente de teste, `{ montarMensagem, lerEventos, aceitarMensagemDoPai }`.

- [ ] **Step 1: Testes que falham** — `aceitarMensagemDoPai` só aceita `source === window.parent`; `montarMensagem` gera `mensagem_id` novo a cada texto e reaproveita o mesmo ao reenviar a mesma mensagem; `lerEventos` junta pedaços partidos do fluxo e entrega cada evento uma vez; texto de resposta com `<img onerror>` aparece como texto (assert no nó criado: `textContent`, nenhum filho elemento); sem `localStorage` a janela não quebra.
- [ ] **Step 2:** o CI mostra o vermelho.
- [ ] **Step 3: Implementar.** Ordem na tela: aviso de LGPD (com o controlador e o link) ⇒ botão de aceitar ⇒ formulário de coleta, só com os campos não ocultos ⇒ conversa. O aceite só vai junto da primeira mensagem. Reconexão do fluxo com espera crescente, teto de 30 s. Erro 404 ou 401 mostra "chat indisponível" e para de insistir; 429 respeita `Retry-After`.
- [ ] **Step 4:** CI verde. **Step 5: Commit** `feat(chat): comportamento da janela do visitante`.

### Task 6: A aba "Chat no site" em Conexões

**Files:**
- Create: `components/connections/CanalChatClient.tsx`, `lib/channels/webchat/codigo-para-colar.ts`
- Modify: `components/connections/ConexoesShell.tsx`, `app/app/connections/page.tsx`
- Test: `lib/channels/webchat/codigo-para-colar.test.ts`, `components/connections/CanalChatClient.test.tsx`

**Interfaces:**
- Consumes: `GET/POST/PATCH /api/v1/channels/webchat`, `POST .../girar` (F1); `moduloLigado(admin, "canal_webchat")`.
- Produces: `codigoParaColar(origemDoCrm: string, chave: string): string` devolve a linha `<script src="<origem>/webchat.js?k=<chave>" async></script>`; `ConexoesShell` recebe `chat?: { label: string } | null` e mostra a aba só quando vem preenchido (`abaParam === "chat"` abre a aba, como o `bot`).

- [ ] **Step 1: Testes que falham** — `codigoParaColar` não inclui espaço nem aspas soltas, e escapa a chave; a aba some com `chat` nulo; sem conexão a tela mostra "Ativar o chat" e a lista de domínios; com conexão mostra aparência (título, saudação, cor), coleta (três seletores), domínios (uma linha cada, com a validação da F1), o código para colar com botão de copiar e o botão "Gerar nova chave", que pede confirmação e diz que sites com o código antigo deixam de abrir conversas novas.
- [ ] **Step 2:** o CI mostra o vermelho.
- [ ] **Step 3: Implementar** no molde de `CanalBotClient` (mesmos componentes, mesmo tratamento de erro e de viewer). `page.tsx` consulta `moduloLigado(createAdminClient(), "canal_webchat")` e passa `chat={ligado ? { label: "Chat no site" } : null}`.
- [ ] **Step 4:** CI verde. **Step 5: Commit** `feat(chat): aba Chat no site em Conexões`.

### Task 7: Pausa do chat

**Files:**
- Modify: `app/api/v1/channels/webchat/route.ts`, `lib/channels/webchat/conexao-pela-chave.ts`, `lib/audit/actions.ts` (ação `channel.webchat_paused`), `components/connections/CanalChatClient.tsx`
- Test: `app/api/v1/channels/webchat/route.test.ts`, `tests/unit/webchat-rotas-publicas.test.ts`

**Interfaces:**
- Produces: `PATCH /api/v1/channels/webchat` aceita `pausado: boolean`. Pausado, `/sessao` responde o mesmo 404 dos outros casos; `/mensagens` e `/eventos` também. O implementador lê os valores válidos de `channel_sessions.status` e usa o que já existe para "parado"; se nenhum servir, guarda `metadata.webchat.pausado` e o diz na revisão.

- [ ] **Step 1: Testes que falham** — pausar e retomar pela rota de quem administra (com `requireSupportWrite(` e audit); com o chat pausado as três rotas públicas dão o mesmo 404; retomar volta a funcionar.
- [ ] **Step 2:** o CI mostra o vermelho. **Step 3: Implementar.** Botão "Pausar o chat" na aba. **Step 4:** CI verde. **Step 5: Commit** `feat(chat): pausa do chat no site`.

### Task 8: Prova pela tela da F2-A, documentos e fechamento

**Files:**
- Create: `docs/testing/chat-no-site.md` (roteiro de prova pela tela; a spec automatizada ficou de fora: a primeira versão era inválida e a prova fica com o mantenedor), `.changes/chat-no-site-parte-2.md`
- Modify: `.github/workflows/e2e.yml` (a spec entra em um `SPECS_PARTE_N`), `docs/architecture/canal-do-chat-no-site.architecture.json`, `docs/specs/36-spec-chat-no-site.md` (estado da F2 e a decisão sobre a pausa)

- [ ] **Step 1: Spec de ponta a ponta**, como um leigo: banco fresco, envs opcionais ausentes, módulo ligado em `/admin/sistema`; na aba, ativar o chat e cadastrar o domínio de um servidor de teste; abrir a página de teste com o código colado; ver a bolha, abrir, aceitar o aviso, mandar uma mensagem; ver a conversa no Inbox com o canal "Chat no site" e responder; ver a resposta na janela. Casos extras: site fora da lista não mostra a janela (o iframe não carrega); girar a chave faz a página antiga receber "indisponível" ao abrir conversa nova.
- [ ] **Step 2:** registrar em `docs/testing/chat-no-site.md` o roteiro e a evidência; fragmento `.changes/chat-no-site-parte-2a.md` com `impacto: capacidade_nova` (o texto é nota pública; `pnpm release:conferir` confere a forma); mapa de arquitetura com as peças novas e suas arestas (janela ⇄ rotas públicas ⇄ Inbox).
- [ ] **Step 3:** atualizar a spec (F2 entregue, pausa para a F3) e declarar o destino no PR: núcleo, com módulo opcional desligado de fábrica.
- [ ] **Step 4:** sabotagem: sobre o commit verde, tirar de propósito (1) a exclusão do `DENY` em `/chat/` e (2) a lista de domínios do `frame-ancestors`; os testes das Tarefas 3 e a spec e2e devem ficar vermelhos, e o controle verde fica em outro PR.
- [ ] **Step 5: Commit** `test(chat): prova pela tela da janela e do link`.

### Task 9: Formatos da janela (F2-B)

**Files:**
- Modify: `lib/channels/webchat/config.ts`, `lib/channels/webchat/janela-html.ts`, `public/webchat.js`, `components/connections/CanalChatClient.tsx`
- Test: `lib/channels/webchat/config.test.ts`, `lib/channels/webchat/janela-html.test.ts`, `tests/unit/webchat-bolha.test.ts`

**Interfaces:**
- Produces: `configuracaoDoChatSchema` ganha `formato: "bolha" | "painel" | "embutido" | "pagina"` (padrão `bolha`) e `posicao: "direita" | "esquerda"`. `public/webchat.js` monta o formato pedido: bolha flutuante, painel lateral fixo, iframe dentro de um elemento da página (`data-webchat-alvo`, seletor simples) ou redireciona para `/chat/<chave>` em página inteira. O formato é escolhido na aba, e o código para colar muda com ele.

- [ ] **Step 1: Testes que falham** — schema recusa formato fora da lista e posição fora da lista; `webchat.js` com `formato=embutido` e sem alvo na página não cria nada e não quebra a página; com alvo, cria o iframe dentro dele; `painel` e `bolha` respeitam a posição.
- [ ] **Step 2:** o CI mostra o vermelho. **Step 3: Implementar.** **Step 4:** CI verde. **Step 5: Commit** `feat(chat): formatos da janela do chat no site`.

### Task 10: Ajustes de aparência e comportamento (F2-B)

**Files:**
- Modify: `lib/channels/webchat/config.ts`, `lib/channels/webchat/janela-html.ts`, `public/webchat-janela.js`, `public/webchat.js`, `components/connections/CanalChatClient.tsx`, `lib/channels/webchat/codigo-para-colar.ts`
- Test: `lib/channels/webchat/config.test.ts`, `tests/unit/webchat-janela-cliente.test.ts`, `tests/unit/webchat-bolha.test.ts`, `components/connections/CanalChatClient.test.tsx`

**Interfaces:**
- Produces: no schema, `avatar_url?: string` (https, máx. 300), `auto_abrir_segundos?: number` (0 a 120; 0 desliga), `som?: boolean`, `respostas_rapidas?: string[]` (até 5, cada uma de 1 a 80 caracteres). A bolha mostra a contagem de mensagens não lidas (badge) quando a janela está fechada; a janela toca o som só quando `som` é verdadeiro e o visitante já interagiu com a página. As respostas rápidas aparecem como botões antes da primeira mensagem e enviam o texto como mensagem normal.

- [ ] **Step 1: Testes que falham** — schema recusa `avatar_url` que não seja https, mais de 5 respostas rápidas e `auto_abrir_segundos` fora de 0–120; as respostas rápidas entram na tela por `textContent`; o badge conta só mensagens de resposta e zera ao abrir; `auto_abrir_segundos = 0` nunca abre sozinho.
- [ ] **Step 2:** o CI mostra o vermelho. **Step 3: Implementar**, com os campos novos na aba. **Step 4:** CI verde. **Step 5: Commit** `feat(chat): avatar, auto-abrir, som, badge e respostas rápidas`.

Ao fechar a Tarefa 10: repetir a prova pela tela (Tarefa 8) para os formatos e ajustes novos, e escrever o fragmento `.changes/chat-no-site-parte-2b.md` (`capacidade_nova`).

## Living System Checklist (Definition of Done, item 13)

Peça: a janela do chat e a aba de administração. Cada resposta nomeia o artefato.

1. **Quem me alimenta?** O visitante, pelo script `public/webchat.js` ou pelo link `/chat/<chave>`; quem administra, pela aba `CanalChatClient`.
2. **Quem eu alimento?** As rotas da F1 (`/api/v1/webchat/*`) → `ingerirMensagemDoChat` → `aplicarEfeitosPosEntrada` → conversa no Inbox.
3. **Que registro eu emito?** `audit()` com `channel.webchat_created/updated/key_rotated` (F1) e `channel.webchat_paused` (Tarefa 7); o aceite de LGPD em `messages.metadata.webchat_aceite` (Tarefa 2).
4. **Onde apareço na tela?** Na aba "Chat no site" (Conexões) e, para a conversa, no Inbox com o selo do canal (F1, `lib/channels/presentation.ts`).
5. **Por qual porta se chega?** A aba é filha de `/app/connections?aba=chat`, que já tem porta em `lib/navigation/catalogo.ts`; `/chat/<chave>` é página pública de visitante e não entra na navegação (justificativa para a allowlist de `tests/unit/navegacao-completude.test.ts`, se o teste a cobrar).
6. **Qual meu anti-morte?** A mensagem do visitante vira conversa e lead pelo `pos-entrada`, e a partir daí valem o follow-up e o Radar de Risco como em qualquer canal. Sem agente na conexão, a conversa espera a equipe (a mensagem "Recebemos sua mensagem" é da F3).
7. **Onde se configura?** Na aba: ver o estado, mudar tudo, e o que aparece se faltar (sem controlador cadastrado a janela mostra o aviso sem link; sem domínios, `frame-ancestors 'none'` e só o link direto abre).
8. **Qual a continuidade IA↔humano?** Na F2, o atendente responde pelo composer do Inbox e a resposta chega à janela pelo stream da F1. O handoff estruturado é a F4.
9. **Qual meu laço de retorno?** **Nenhum na F2, declarado:** a janela mostra "indisponível" quando a chave é recusada, mas o sistema ainda não conta recusas (`metadata.webchat.recusas` ficou pendente na F1). Entra junto com o teto do anônimo, na F4.
10. **Atualizei o mapa?** Sim, na Tarefa 8: `docs/architecture/canal-do-chat-no-site.architecture.json` ganha a janela e a aba, cada uma com duas arestas.

## Regras de cada PR da F2

- Base `main`; a F2 só compila com a F1 dentro, então os dois PRs esperam o #5095 entrar (ou usam a F1 como base de prova no fork, como a F1 fez).
- Corpo com `Refs #1333` (nunca `Closes`: a issue é fatiada), o que muda para quem opera, o destino ("núcleo, com módulo opcional desligado de fábrica"), o que foi medido (rodapé do CI, sabotagem com controle verde) e o bloco "O que NÃO medi".
- Antes de empurrar: `pre-voo.sh`, `pnpm lint:channels`, `pnpm checar:colisao-de-migration` (a F2 não tem migration; o comando confirma), trazer a `main`, revisão cega do diff. Texto público assinado "— Paulo Lima Jr", sem decisão interna.
- Terminada a F2-A, avisar na #1333 que a F2 está com o Paulo (a oferta ao SPYDeEp1 ficou sem resposta desde 20/11).

## O que este plano não cobre (de propósito)

Horário de atendimento (janela por dia, feriados, mensagem fora do expediente e captura offline: F3 da issue), agente, passagem para humano e teto do visitante anônimo (F4), origem do negócio e relatório (F5). Também não cobre o corte dos tokens já emitidos ao girar a chave, que a F1 deixou declarado como pendência.

**Origem do site:** a lista de domínios só vale dentro da janela (`frame-ancestors`). Quem chama as rotas públicas direto, sem navegador, não é barrado por ela; o que protege essas rotas são o token, o limite por IP e o teto de corpo da F1. A issue pedia validar a origem na entrada, e isso fica registrado aqui como diferença aberta para o Rafael decidir.

## Plano de sabotagem (não rodar — veredito pelo CI)

Sobre o commit verde do PR de prova da Tarefa 8, sabotar de propósito e confirmar que os
testes ficam vermelhos:

1. **Tirar a exclusão de `/chat/` no `source` global de `next.config.ts`** → o `X-Frame-Options:
   DENY` passa a valer para `/chat/<chave>`, o iframe é bloqueado pelo navegador; `chat-cabecalhos.test.ts`
   e `webchat-janela-rota.test.ts` ficam vermelhos, e o e2e C5 (site fora da lista) também.
2. **Tirar a lista de domínios no `frame-ancestors` em `lib/channels/webchat/janela-html.ts`**
   (montar com `'*'` ou `'none'` sempre) → `janela-html.test.ts` fica vermelho (lista vazia deve
   render `'none'`, lista com dois domínios só os dois); o e2e C3/C5 também.
3. **Tirar a leitura de `pausado` em `lib/channels/webchat/conexao-pela-chave.ts`** → as rotas
   públicas continuam entregando a conexão mesmo pausada; `conexao-pela-chave.test.ts`,
   `webchat-rotas-publicas.test.ts` e o e2e C7 ficam vermelhos.

Controle verde: restaurar cada sabotagem e confirmar que os testes voltam ao verde. Cada
sabotagem tem seu próprio commit de controle (verde) antes da próxima. O controle verde fica
noutro PR.


## Decisões da F2-B (23/11, antes de despachar a Tarefa 9)

- **Como o `webchat.js` sabe o formato:** o script não faz requisição (cerca do teste: sem `fetch(`). O formato e a posição viajam no endereço do script, que o código para colar gera: `webchat.js?k=<chave>&f=<formato>&p=<posicao>`, só com o que difere do padrão (`bolha`, `direita`). O script lê só valores de uma lista fixa; qualquer outro é ignorado e vale o padrão. Mudar o formato na aba muda o código para colar: a pessoa cola de novo.
- **Os outros ajustes (Tarefa 10: avatar, auto-abrir, som, badge, respostas rápidas) NÃO vão no endereço:** a janela, que já conhece a configuração, os manda à bolha por `postMessage` (origem do CRM e janela conferidas, como o `pronto` e o `nao-lidas`). Assim mudar a configuração não exige colar o código de novo.
- **Quatro formatos:** `bolha` (padrão, o que existe); `painel` (a mesma bolha, mas o chat aberto vira um painel colado na lateral, altura da tela); `embutido` (sem bolha: o iframe vive dentro do elemento que o site marca com `data-webchat-alvo="#seletor"` no `<script>`; sem alvo achado, o script não cria nada e não quebra a página; o botão × da janela é ignorado); `pagina` (a bolha, mas o clique abre `/chat/<chave>` numa nova aba, com `noopener,noreferrer`; nada de redirecionar a página do cliente sozinho).
- **Código para colar do `embutido`:** duas linhas (uma `<div id="webchat-aqui"></div>` e o script com `data-webchat-alvo="#webchat-aqui"`).
