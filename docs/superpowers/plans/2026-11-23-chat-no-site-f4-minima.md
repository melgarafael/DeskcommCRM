# Chat no site — F4 mínima (teto de respostas da IA para visitante anônimo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Antes de qualquer código: skills `deskcomm-contribuir`, `deskcomm-doutrina` e `sistema-vivo`.

**Goal:** a IA responde a um visitante anônimo do chat no máximo N vezes por conversa (padrão 20, configurável na aba "Chat no site"); passado o teto, a conversa fica para a equipe e a IA não é chamada.

**Architecture:** a regra mora no gate de elegibilidade que o drain e o turno já usam (`lib/ai/elegibilidade/gate.ts`, função pura `decidirElegibilidade`), com um motivo novo e um fato novo no estado. Quem sabe qual canal tem teto e quanto vale é o seam de canais (`lib/channels/`); o gate e os loaders não nomeiam provedor (`pnpm lint:channels`). A contagem é a das respostas da IA já gravadas em `messages` (mesma régua de `teto-de-respostas.ts`), sem tabela nem coluna nova: **sem migration**.

**Spec:** `docs/specs/36-spec-chat-no-site.md`, seção "F4 — Agente, passagem e teto do visitante anônimo". Decisão do mantenedor no #5095 (21/11): o módulo só liga com a barreira de site e este teto.

## Global Constraints

- Anônimo = contato sem `phone_number` e sem `email`. Quem deixou um dos dois sai do teto do anônimo (segue o teto por conversa que já existe, `teto-de-respostas.ts`, que continua valendo para todos).
- Resposta da IA que conta: `messages.direction = 'outbound'`, `sent_via = 'ai'`, `status <> 'failed'`, na conversa e na organização (`organization_id` sempre filtrado). Sem janela de tempo: é por conversa, no total.
- Falhou a leitura da contagem: o gate passa, com registro em log (mesma doutrina do teto existente: auxiliar falha aberta, nunca em silêncio).
- Nenhum nome de provedor fora de `lib/channels/` (`pnpm lint:channels`). Sem `console.log`. Sem migration.
- Sem janela do chat nova e sem texto novo para o visitante nesta fatia (o "pedir o contato" fica para a F4 completa).
- Texto de tela e mensagens em português simples; chaves novas no `lib/i18n/dicionario.ts` (es). Exemplo de domínio só `example.com`.

## Review Focus

- Visitante que deixou só o e-mail (sem telefone) deixa de ser anônimo; o contrário também.
- Conversa de outro canal (sem teto declarado pelo canal) nunca é afetada.
- Teto 1 e teto máximo (200) funcionam; valor fora de 1–200 na configuração cai no padrão 20, nunca em "sem teto".
- Organização A nunca conta mensagem da organização B.
- O teto chega ao motor pelos DOIS caminhos de leitura (pg e supabase), com o mesmo resultado.

---

### Task 1: O teto no seam e no gate

**Files:**
- Create: `lib/channels/teto-do-anonimo.ts`, `lib/channels/teto-do-anonimo.test.ts`
- Modify: `lib/ai/elegibilidade/gate.ts` (+ `gate.test.ts`), `lib/ai/elegibilidade/consulta-pg.ts`, `lib/ai/elegibilidade/consulta-supabase.ts`, `lib/ai/elegibilidade/pre-go-live.ts` (só se o montador `montarEstadoDeElegibilidade` morar nele)
- Test: os `.test.ts` acima, mais um teste do loader pg com dublê, no estilo dos vizinhos

**Interfaces:**
- Produces `tetoDoAnonimoDoCanal(provider: string, metadata: unknown): number | null` em `lib/channels/teto-do-anonimo.ts`: `null` = canal sem teto de anônimo; para o canal de chat devolve a configuração (`metadata.webchat.teto_anonimo`, inteiro de 1 a 200) ou 20 se ausente/inválida.
- `EstadoDeElegibilidade` ganha `tetoDoAnonimo: { limite: number; respostasDaIa: number | null } | null` (null = não se aplica, o padrão).
- `MotivoDeElegibilidade` ganha `"teto_do_visitante_anonimo"`; `decidirElegibilidade` devolve `{ permite: false, motivo: "teto_do_visitante_anonimo", bloqueioPorAllowlist: false }` quando `respostasDaIa !== null && respostasDaIa >= limite`, depois dos vetos que valem sempre (org, canal, force_human, opt-out, silêncio, dono humano, contato interno) e antes do `modo`.

- [ ] **Step 1: testes puros primeiro** — `gate.test.ts`: casos "abaixo do teto permite", "no teto veta com o motivo novo", "`respostasDaIa` nulo (leitura falhou) passa", "tetoDoAnonimo nulo não muda nada", "veto de contato interno vence o teto". `teto-do-anonimo.test.ts`: canal de chat sem config = 20; 1 e 200 aceitos; 0, 201, texto, fracionário = 20; outro provedor = null.
- [ ] **Step 2: implementar o seam e o gate** (assinaturas acima).
- [ ] **Step 3: loader pg** — `decidirElegibilidadeDaConversa` passa a ler `cs.provider`, `ct.email` e, só quando `tetoDoAnonimoDoCanal(provider, metadata)` for número e o contato não tiver telefone nem e-mail, a contagem (uma consulta, `organization_id` e `conversation_id` filtrados). Falha na contagem: `respostasDaIa = null` + `logger.warn` com `organizationId`.
- [ ] **Step 4: loader supabase** — mesmo resultado, mesma contagem (`select count`, `head: true`).
- [ ] **Step 5: teste do loader** — dois casos: anônimo no teto veta; o mesmo contato com e-mail não veta. Um caso de isolamento: conversa de outra organização com 25 respostas da IA não afeta.
- [ ] **Step 6: commit** — `feat(chat): teto de respostas da IA para visitante anônimo no gate de elegibilidade`

### Task 2: A configuração na aba e na rota

**Files:**
- Modify: `lib/channels/webchat/config.ts` (+ teste), `components/connections/CanalChatClient.tsx` (+ `.test.tsx`), `lib/i18n/dicionario.ts`
- Test: os dois testes acima

**Interfaces:**
- Consumes: o campo `teto_anonimo` lido por `tetoDoAnonimoDoCanal` (Task 1).
- Produces: `config.teto_anonimo?: number` (mesmo nome que `tetoDoAnonimoDoCanal` lê em `metadata.webchat.teto_anonimo`) no schema Zod da configuração (inteiro, 1 a 200, opcional); a aba mostra "Respostas da IA para quem ainda não deixou contato" (padrão 20) com a explicação em uma frase; salvar usa o mesmo PATCH da aba.

- [ ] **Step 1: teste do schema** — 1 e 200 aceitos; 0, 201 e 1,5 recusados; ausente = padrão.
- [ ] **Step 2: teste da aba** — o campo aparece com 20; digitar 5 e salvar manda `teto_anonimo: 5`; valor inválido mostra o erro em português e não envia.
- [ ] **Step 3: implementar** schema, aba e chaves de tradução.
- [ ] **Step 4: commit** — `feat(chat): teto de respostas da IA para anônimo configurável na aba`

### Task 3: Documentos e fechamento

**Files:** `docs/specs/36-spec-chat-no-site.md` (F4: marcar o que entrou), `docs/testing/chat-no-site.md` e a jornada J74 (caso do teto), `.changes/chat-no-site-parte-2a.md` (acrescentar o teto, sem prometer chat ligado), `docs/architecture/canal-do-chat-no-site.architecture.json` (aresta gate de elegibilidade → conversa, com a contagem em `messages`), plano de sabotagem no fim deste plano.

- [ ] **Step 1:** atualizar cada documento com o que existe de fato (teto no gate e na aba; o "pedir o contato" e o horário seguem pendentes).
- [ ] **Step 2: Sabotagem** (sobre o commit verde, em PR à parte do fork, só fechar): (a) trocar `>=` por `>` na regra do gate; (b) fazer `tetoDoAnonimoDoCanal` devolver `null` para o canal de chat; (c) tirar o filtro `organization_id` da contagem. Previsão: `gate.test.ts`, `teto-do-anonimo.test.ts` e o teste do loader ficam vermelhos, cada ponto num grupo próprio.
- [ ] **Step 3: commit** — `docs(chat): F4 mínima nos documentos`

### Ajuste da Tarefa 3 (resposta do mantenedor no #5095, 23/11)

- A "barreira de site" já está entregue (o `frame-ancestors` por conexão da F2-A). O que falta para ligar o módulo é só este teto.
- O mantenedor vai pôr `canal_webchat` em `MODULOS_AINDA_NAO_LIGAVEIS` (`lib/instalacao/modulos.ts`) com um teste que reprova ligar. **O PR da F4 mínima só é aberto ao mantenedor depois que o #5095 entrar**, e ele tira `canal_webchat` dessa lista (e inverte o teste) como último commit.
- O texto do fragmento `.changes/chat-no-site-parte-2a.md` é do mantenedor até lá; no PR da F4, o fragmento diz que o chat pode ser ligado.
