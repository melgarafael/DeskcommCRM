# Chat no site — F3 (horário de atendimento) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Antes de qualquer código: skills `deskcomm-contribuir`, `deskcomm-doutrina` e `sistema-vivo`.

**Goal:** a janela do chat sabe, ao abrir, se o atendimento está dentro ou fora do horário do agente que atende a conexão, e se não há agente. Fora do horário, mostra o aviso que o agente já tem configurado e quando volta. Sem agente, diz "Recebemos sua mensagem" depois da primeira mensagem.

**Architecture:** o motor do agente já adia o turno fora da janela (`lib/agent-engine/agent/janela-de-atendimento.ts`: `lerJanelaDeAtendimento`, `msAteAJanelaAbrir`) e já tem o texto do aviso (`aviso-fora-do-horario.ts`: `lerTextoDoAvisoForaDoHorario`). Esta fatia NÃO cria horário novo: lê a versão publicada do agente da conexão (`ai_agent_versions` com `status='published'` e `channel_session_id` = a conexão, o mesmo critério de `escolherAgenteDoNumero`), decide o estado com uma função pura e o devolve na resposta de `POST /api/v1/webchat/sessao`. A janela mostra. Sem migration.

**Spec:** `docs/specs/36-spec-chat-no-site.md`, seção "F3 — Horário". Issue #1333, fatia F3.

## Global Constraints

- Nenhum nome de provedor fora de `lib/channels/` (`pnpm lint:channels`). Sem `console.log`. Sem migration. Sem variável de ambiente nova.
- `organization_id` e a conexão vêm SEMPRE da chave pública já resolvida na rota (`conexaoPelaChave`), nunca do corpo. A leitura da versão do agente filtra `organization_id` e `channel_session_id`.
- Falha ao ler o agente: estado `aberto` (falha aberta) com `logger.warn` e `organizationId`. O chat nunca fica mudo por erro de leitura.
- Agente pausado (`ai_agents.paused_at` não nulo) ou arquivado NÃO atende: conta como sem agente, a menos que exista outro não pausado (a lista vem ordenada, o primeiro não pausado vale).
- Texto da janela em português simples, com acentos escritos como escape Unicode de UMA barra em `public/webchat-janela.js` (`ç`), como o resto do arquivo.
- Feriados: a opção `fechado_em_feriado_nacional` do agente NÃO entra nesta fatia (precisa do país da organização). Fica declarado em "O que não cobre".

## Review Focus

- Agente sem `business_hours` = sempre `aberto`. Horário torto ou fuso inválido = `aberto` (falha aberta, como o motor).
- Todos os agentes da conexão pausados = `sem_agente`. Nenhum agente = `sem_agente`.
- Agente da conexão A nunca vale para a conexão B, nem de outra organização.
- Erro de rede/banco na leitura = `aberto` e a sessão do visitante segue funcionando (status 200).
- A janela com `atendimento` ausente (servidor antigo) funciona como hoje.

---

### Task 1: o estado do atendimento (função pura + leitura)

**Files:**
- Create: `lib/channels/webchat/atendimento.ts`, `lib/channels/webchat/atendimento.test.ts`

**Interfaces:**
- Produces:
  - `type EstadoDoAtendimento = { estado: "sem_agente" | "aberto" | "fechado"; abreEm: string | null; aviso: string | null }` (`abreEm` = instante ISO-8601 UTC em que o atendimento volta; só no estado `fechado`; `aviso` = texto configurado no agente, só no `fechado`, ou `null`).
  - `type VersaoDoAtendimento = { triggerConfig: unknown; pausado: boolean }`.
  - `decidirAtendimento(versoes: VersaoDoAtendimento[], agora: Date): EstadoDoAtendimento` (pura: usa o PRIMEIRO item com `pausado === false`; nenhum = `sem_agente`; `lerJanelaDeAtendimento(triggerConfig)` nulo = `aberto`; `msAteAJanelaAbrir(janela, agora)` nulo = `aberto`; número = `fechado` com `abreEm = new Date(agora.getTime() + ms).toISOString()` e `aviso = lerTextoDoAvisoForaDoHorario(triggerConfig)`).
  - `carregarAtendimento(admin: SupabaseClient, organizationId: string, channelSessionId: string, agora: Date): Promise<EstadoDoAtendimento>` (lê `ai_agent_versions` com `status='published'`, `organization_id`, `channel_session_id`, junto de `ai_agents(paused_at, archived_at, priority, created_at)`; descarta arquivados; ordena por `pausado` asc, `priority` desc, `created_at` asc; qualquer erro = `aberto` + `logger.warn`).
- Imports: `lerJanelaDeAtendimento` e `msAteAJanelaAbrir` de `@/lib/agent-engine/agent/janela-de-atendimento`; `lerTextoDoAvisoForaDoHorario` de `@/lib/agent-engine/agent/aviso-fora-do-horario`.

- [ ] **Step 1: testes da função pura primeiro** (`atendimento.test.ts`, relógio fixo `new Date("2026-11-24T15:00:00Z")` = terça 12h em São Paulo; janela `{ filters: { business_hours: { timezone: "America/Sao_Paulo", start: "08:00", end: "18:00", weekdays: [1,2,3,4,5] } } }`): lista vazia = `sem_agente`; só pausado = `sem_agente`; sem `business_hours` = `aberto`; dentro da janela (terça 12h) = `aberto`; terça 22h (`2026-11-25T01:00:00Z`) = `fechado` com `abreEm` = `2026-11-25T11:00:00.000Z` (quarta 8h) e `aviso` do `notice` configurado (e `null` sem `notice`); sábado = `fechado` com `abreEm` na segunda 8h; fuso inválido = `aberto`; pausado primeiro e ativo depois = usa o ativo; com `notice` e dentro da janela, `aviso` é `null`.
- [ ] **Step 2:** implementar `decidirAtendimento`.
- [ ] **Step 3: testes do loader** com dublê do cliente Supabase (encadeado `.from().select().eq()...`; copie o estilo de `lib/ai/elegibilidade/consulta-supabase.test.ts` ou de outro teste de loader com dublê): erro do banco = `aberto`; resposta com uma versão ativa e janela fechada = `fechado`; o filtro usa `organization_id` e `channel_session_id` (asserte que `.eq` foi chamado com os dois).
- [ ] **Step 4:** implementar `carregarAtendimento`.
- [ ] **Step 5: commit** `feat(chat): estado do atendimento do chat pelo horário do agente da conexão`.

### Task 2: a rota de sessão devolve o atendimento

**Files:**
- Modify: `app/api/v1/webchat/sessao/route.ts` (+ o teste da rota: `git grep -ln "webchat/sessao" -- tests lib app`)

**Interfaces:**
- Consumes: `carregarAtendimento` (Task 1).
- Produces: `data.atendimento: { estado: "sem_agente" | "aberto" | "fechado"; abre_em: string | null; aviso: string | null }` na resposta 200 (snake_case no JSON público, como o resto da rota).

- [ ] **Step 1: teste** no teste da rota: com o dublê de `carregarAtendimento` (`vi.mock`) devolvendo `fechado`, a resposta tem `data.atendimento` com `estado`, `abre_em`, `aviso`; quando `carregarAtendimento` lança, a resposta continua 200 e `atendimento.estado === "aberto"`.
- [ ] **Step 2:** chamar `carregarAtendimento(admin, conexao.organizationId, conexao.id, agora)` na rota (use os nomes reais que `conexaoPelaChave` devolve; leia `lib/channels/webchat/conexao-pela-chave.ts`), dentro de `try/catch` próprio (falha = `aberto`).
- [ ] **Step 3: commit** `feat(chat): a sessão do visitante devolve o estado do atendimento`.

### Task 3: a janela mostra o horário e o "Recebemos sua mensagem"

**Files:**
- Modify: `public/webchat-janela.js`, `tests/unit/webchat-janela-cliente.test.ts`

**Interfaces:**
- Consumes: `data.atendimento` da resposta de `/sessao` (Task 2).
- Produces: comportamento: (a) `fechado`: ao abrir a conversa, uma linha de atendente no registro com o `aviso` do agente, ou, sem aviso, `"Estamos fora do horário de atendimento. Voltamos às HH:MM de DD/MM (no horário do seu aparelho)."` calculado de `abre_em` com `Date` local do navegador; (b) `sem_agente`: depois que a primeira mensagem do visitante é aceita (2xx), uma linha de atendente `"Recebemos sua mensagem. Nossa equipe responde por aqui."`; (c) `aberto` ou `atendimento` ausente: nada muda.

- [ ] **Step 1: testes** (jsdom, copie o jeito do teste de `mostrarResposta`/respostas rápidas: roteador, `abrirJanela`, aceite, `esperarTudo`): `fechado` com `aviso` mostra o aviso no `.msg-texto`; `fechado` sem aviso mostra o texto padrão com a hora; `sem_agente` mostra a linha só DEPOIS do primeiro envio aceito (e uma vez só, no segundo envio não repete); `aberto` e ausente não mostram nada; texto vindo do servidor entra por `textContent` (um aviso com `<b>x</b>` aparece literal). Atenção às lições: a conversa só existe depois do aceite (`botao("Aceitar e continuar").click()`); o roteador se passa como `r.fn`; a mensagem do roteador de sessão leva `atendimento` dentro de `data`.
- [ ] **Step 2:** implementar em `iniciar`: guardar `estado.atendimento` (validado: `estado` entre os três valores, `abre_em` string ISO válida, `aviso` string ou null, senão ignora); `fechado` mostra a linha em `telaConversa`; `sem_agente` mostra a linha no sucesso do primeiro envio. Linhas por `criarLinha(doc, "atendente", texto, "")`. Escapes Unicode de uma barra.
- [ ] **Step 3: commit** `feat(chat): a janela avisa fora do horário e quando não há agente`.

### Task 4: documentos e fechamento

**Files:** `docs/specs/36-spec-chat-no-site.md` (F3: marcar o que entrou e o que não), `docs/testing/chat-no-site.md` (caso C9: fora do horário e sem agente), `docs/testing/user-journey-map.md` (J74.11), `docs/architecture/canal-do-chat-no-site.architecture.json` (peça `atendimento` com arestas: lê `ai_agent_versions`, alimenta a janela), `.changes/chat-no-site-parte-3.md` (`capacidade_nova`).

- [ ] **Step 1:** atualizar cada documento com o que existe de fato.
- [ ] **Step 2: Sabotagem** (sobre o commit verde, PR à parte do fork, só fechar): (a) `decidirAtendimento` ignorar `pausado`; (b) `msAteAJanelaAbrir` nunca consultado (sempre `aberto`); (c) tirar o filtro `channel_session_id` do loader; (d) a janela não mostrar o `sem_agente`. Previsão: cada um derruba testes do seu grupo.
- [ ] **Step 3: commit** `docs(chat): F3 nos documentos`.

## O que este plano não cobre (de propósito)

Feriado nacional (`fechado_em_feriado_nacional`), horário próprio do canal (a spec decidiu usar o do agente), captura offline com formulário de recado (a mensagem do visitante já vira conversa e lead pelo `pos-entrada`), e o aviso automático por mensagem do motor (`enviaAvisoForaDoHorario`), cuja chegada à janela do chat será medida na F4, junto do agente.

## Como cada tarefa é verificada antes de empurrar (Paulo, 23/11)

Rodar aqui só o leve: parser do TypeScript nos arquivos tocados, `vitest.mjs` focado nos arquivos tocados e `tsc` focado com tsconfig temporário. Suíte inteira, e2e e `test:db` vão ao CI do fork.
