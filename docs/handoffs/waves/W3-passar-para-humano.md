# W3 — Passar para um humano (pacote `escalar`)

**Worktree:** `/Users/rafaelmelgaco/SonghaiCRM-ia360-w3-escalar` (branch `feat/ia-360-w3-escalar`, base `d25cd1c`)
**Pacote alvo:** `escalar` — hoje com **1 capacidade só** (abrir handoff). Falta a volta inteira.

---

## CONTEXTO

Leia **antes de tudo**, nesta ordem:

1. `docs/handoffs/BRIEFING-ia-360.md` — o contrato inteiro. Não é opcional.
2. `docs/doctrine/sistema-vivo.md` — **o invariante 2 é o seu.**
3. `HANDOFF-ia-360.md` — a linha de base medida.

### Por que esta wave existe

O invariante 2 da doutrina exige continuidade **nas duas direções**:

> **IA → humano:** quando a IA para, o humano recebe contexto pronto para continuar — um resumo do
> que aconteceu e por quê, não a conversa crua.
> **Humano → IA:** quando o humano para (responde, atribui, agenda), fica um input estruturado que
> a IA lê para retomar com contexto.

A direção IA→humano **já é viva**: `buildHandoffSummary()` em
`lib/agent-engine/agent/human-handoff.ts` monta resumo contextual e entrega no inbox.

A volta é que está capenga. O agente tem **uma** capacidade — `crm_request_human_handoff`, abrir o
chamado. Depois disso ele fica cego: não sabe listar casos, não lê o que o humano decidiu, não sabe
se o caso foi resolvido, não consegue retomar. E do outro lado, o agente também não enxerga **quem
está disponível** para receber a conversa — existe `attendant_availability`, com carga e
capacidade, e o agente não alcança.

Resultado prático: o agente joga o problema por cima do muro e some. Isso não é continuidade.

## FUNÇÃO

Você fecha o ciclo IA ↔ humano. Não é "mais tools de handoff" — é fazer o agente participar do
atendimento humano em vez de terminar nele.

## DIRECIONAMENTO

### O que já existe e você REUSA (Decisão 4: a tool é fachada fina)

- `app/api/v1/ai/cases/`, `.../[id]/`, `.../[id]/reply/` — casos humanos
- `app/api/v1/ai/inbox/`, `.../[id]/` — a caixa do humano
- `app/api/v1/attendants/availability/`, `.../[user_id]/` — disponibilidade e capacidade
- `app/api/v1/metrics/attendants/` — carga e desempenho
- `app/api/v1/team/assignable/` — quem pode receber
- `app/api/v1/conversations/[id]/`: `claim`, `release`, `transfer`, `close`, `snooze`,
  `reactivate-bot`, `notes`, `notes/[noteId]`
- `lib/agent-engine/agent/human-handoff.ts` (`buildHandoffSummary`), `human-cases.ts`
- `lib/routing/` — a distribuição

Tabelas: `agent_cases`, `agent_case_events`, `agent_inbox_items`, `conversation_notes`,
`attendant_availability`, `conversation_assignment_events`.

**Nunca duplique o SQL.** Regra dentro do `route.ts` → extraia para `lib/<dominio>/operations.ts` e
o route passa a chamar. O teste existente da rota é a rede de segurança.

### Capacidades a entregar

Declare em `lib/mcp/tools/catalogo/escalacao.ts` (arquivo **novo**, seu) e os handlers em
`lib/mcp/tools/escalacao.ts`. Registre no agregador com **uma linha de import e uma de spread**.

Cobertura esperada:

- **Ver quem está disponível agora** — atendentes online, capacidade livre, carga atual. Sem isso o
  agente escala para uma fila cega.
- **Listar os chamados abertos** e o estado de cada um.
- **Ler um chamado** — inclusive o resumo de continuidade e o que o humano decidiu.
- **Registrar o que aconteceu num chamado** (evento/nota interna), para o humano seguinte não
  começar do zero.
- **Encerrar um chamado** com o desfecho registrado.
- **Devolver o atendimento para o agente** — a volta humano→IA, com o input estruturado que o
  agente lê para retomar. Hoje existe `conversations/[id]/reactivate-bot`; exponha isso como
  capacidade e garanta que o agente **recebe o contexto do que o humano fez**, não só o controle.

Rótulos em português de gente. Atenção: **"handoff" está na lista de jargão proibido** do gate
(`tests/unit/catalogo-tools-leigo-friendly.test.ts`). Para o dono da clínica isso se chama
**passar para uma pessoa**, **chamado**, **atendente**.

### O gate do sistema vivo (por capacidade)

As 7 respostas do checklist (briefing §5), com foco no que é seu:

- **Continuidade nas duas direções é o critério de aceite desta wave**, não um item de lista.
  Quando o humano devolve a conversa, o agente tem que retomar **sabendo o que foi feito**. Se ele
  volta cego, você entregou roteamento, não continuidade — e a wave não está pronta.
- **Emite atividade visível.** Passagem de atendimento é evento de vida do lead. Use
  `lib/leads/activity-emitter.ts` com a constante compartilhada de
  `lib/leads/activity-vocabulary.ts` — **nunca string literal**.
- **Aparece na tela.** O que o agente registrar num chamado tem que ser legível no inbox/nos casos.

## OBJETIVO

Que o cliente nunca perceba a costura: a IA para, uma pessoa continua de onde parou, e quando a
pessoa devolve, a IA retoma sabendo o que foi combinado.

## RESULTADO ESPERADO

- `pnpm typecheck` limpo, `pnpm lint` sem erros novos, `pnpm test:unit` verde.
- `pnpm test:db` verde — você toca emissão de atividade e atribuição; `test:unit` **não** inclui
  `tests/invariants/**`.
- **E2E em tela com Playwright**, o ciclo inteiro numa corrida: agente atende → escala para pessoa
  disponível → humano responde e registra → devolve ao agente → **o agente retoma citando o que o
  humano fez**. Evidência visual salva. Esse último passo é o que prova a wave; sem ele, não está
  pronta.
- Mudança de schema (se houver): migration versionada + apêndice idempotente no `baseline.sql` +
  linha no `MANIFEST.md`. Os três, sempre juntos.
- `HANDOFF-ia-360.md` alimentado a cada marco, com SHA.

**Sabote antes de confiar.** Quebre a propriedade de propósito, confirme que reprova, desfaça.

## LIMITES

- Não toque em `lib/mcp/tools/catalogo/` além do **seu** arquivo + as 2 linhas no agregador.
- Não renomeie `name` de tool existente (contrato de wire).
- Não mexa em RBAC nem no engine de envio.
- Bug encontrado é para consertar na causa raiz.
