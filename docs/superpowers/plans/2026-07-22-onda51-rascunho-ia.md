# Onda 5.1 — Rascunho da IA no composer (sob demanda) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um botão "Sugerir resposta" no composer: o vendedor clica, a IA (o agente publicado da org) lê a conversa e devolve UM rascunho de texto que cai no composer para o vendedor editar e enviar como ele mesmo.

**Architecture:** Endpoint `POST /api/v1/conversations/[id]/draft-reply` (requireRole agent) resolve `{organization_id, contact_id, channel_session_id}` da conversa e chama uma nova função `generateDraftReply` do agent-engine, que REUSA `loadPublishedAgentConfig` + `getLeadContext` + `runModelCall` **sem tools** (a via limpa: `result.text` já é o rascunho — sem reconstruir o toolset do turno, sem guardrails de anti-ban/disclosure, que não se aplicam a texto revisado por humano). O front insere o texto no textarea (padrão de inserção do EmojiButton). Sem schema novo, sem persistência (nada é enviado até o vendedor mandar).

**Tech Stack:** Next.js Route Handlers, `lib/agent-engine` (pg.Pool), AI SDK v7 via `runModelCall`, React 19 + Tailwind, React Query.

## Global Constraints

- Spec mestre: `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md` (Onda 5, linha "Resposta rascunhada pela IA"). Handoff `HANDOFF-inbox-multimodal.md` (prova visível em conta REAL; "funcionou BEM").
- **Decisões travadas pelo Rafael:** (1) gatilho = **botão sob demanda** (não automático); (2) cérebro = **o agente publicado da org em modo rascunho** (mesma persona/RAG/prompt do bot, mas NÃO envia).
- **`leadId` no agent-engine = `contact_id`** (confirmado em `inbound-turn.ts:504`). `tenantId` = `organization_id`. Tudo sai da row da conversa.
- Reuso obrigatório (NÃO duplicar a resolução BYOK/credencial): `loadPublishedAgentConfig` (`lib/agent-engine/agent/agent-config.ts:63`), `getLeadContext` (`lib/agent-engine/edge/crm/get-lead-context.ts:101`), `runModelCall` (`lib/agent-engine/edge/llm/run-model-call.ts:141`), `llmEdgeConfigFromEnv`/`crmEdgeConfigFromEnv`, `createPool` (`lib/agent-engine/db/pool.ts`).
- **Guardrails que NÃO se aplicam ao rascunho** (não invocar): `runBeforeSend` inteiro, `pacingGate` (anti-ban), `disclosureGate` (bot), `sendInBubbles`/split, checkpoint de fechamento. **Aplicar antes de gerar:** early-return se contato `is_blocked` ou `is_anonymized` (não sugerir resposta a lead bloqueado), e se o lead está em handoff humano.
- `runModelCall` já tem `assertBudget` (teto mensal de custo por org) — é o rate-limit natural. NÃO criar rate-limiter novo (ponytail); o botão desabilita enquanto pendente.
- Auth: `requireRole("agent", ...)`; org SEMPRE de `authz`, nunca do body. `getUser()` via requireRole. Zod no input. Sem `console.log`. typecheck/lint/testes verdes por task (sem pipe-tail).
- Pool no processo web: `SUPABASE_DB_URL` vem de `process.env` (como o worker; não está em `lib/env.ts` e NÃO deve virar obrigatório lá — não quebrar o build). Handler retorna 503 claro se ausente. Pool é **singleton lazy** por processo (padrão do `media-derive-worker.ts:34`). Ceiling aceito (ponytail): cada instância web abre 1 pool; ok pro BPO.
- Prova: botão real numa conversa REAL, rascunho gerado pelo agente publicado, texto no composer, vendedor edita e envia → entregue no WhatsApp real (ack).

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/agent-engine/agent/draft-reply.ts` (novo) | `generateDraftReply(...)` — orquestra config+contexto+LLM sem tools |
| `lib/agent-engine/db/request-pool.ts` (novo) | pool singleton lazy p/ o processo web |
| `app/api/v1/conversations/[id]/draft-reply/route.ts` (novo) | POST: resolve conversa, chama generateDraftReply, retorna `{data:{draft}}` |
| `hooks/inbox/useDraftReply.ts` (novo) | React Query mutation |
| `components/inbox/composer/DraftReplyButton.tsx` (novo) | botão "Sugerir resposta" + estados |
| `components/inbox/Composer.tsx` (mod) | renderiza o botão; insere o rascunho no textarea |

---

### Task 1: `generateDraftReply` (núcleo)

**Files:**
- Create: `lib/agent-engine/agent/draft-reply.ts`
- Test: `lib/agent-engine/agent/__tests__/draft-reply.test.ts` (ou `tests/unit/draft-reply.test.ts` — seguir onde os testes do agent-engine vivem; grep por `*.test.ts` em `lib/agent-engine`)

**Interfaces:**
- Consumes: `loadPublishedAgentConfig(db, organizationId, channelSessionId)`, `getLeadContext(db, crmCfg, {tenantId, leadId, conversationId}, knobs)`, `runModelCall(db, llmCfg, input)`.
- Produces:
  ```ts
  export interface DraftReplyInput {
    tenantId: string;        // = organization_id
    leadId: string;          // = contact_id
    conversationId: string;
    channelSessionId: string;
  }
  export type DraftReplyResult =
    | { ok: true; draft: string }
    | { ok: false; reason: "no_agent" | "blocked" | "empty" };
  export async function generateDraftReply(
    db: pg.Pool, llmCfg: LlmEdgeConfig, crmCfg: CrmEdgeConfig, input: DraftReplyInput,
  ): Promise<DraftReplyResult>;
  ```

- [ ] **Step 1: Ler os contratos reais** — abrir `agent-config.ts` (o shape de `PublishedAgentConfig`: `systemPrompt`, `provider`, `model`, `credentialId`, `historyMessageWindow`, `multimodalInput`), `get-lead-context.ts` (o shape de `LeadContextResult` — como pegar `context.messages` em `ModelMessage[]` e o `lgpd`/`is_blocked` do contato), e `run-model-call.ts` (`RunModelCallInput`, `LlmEdgeConfig`, `LlmResolveOverride`). Espelhar como `inbound-turn.ts:523,561-568,1182-1202` usa cada um.

- [ ] **Step 2: Teste (falhando)** — com um `db`/cfgs fake e as três funções mockadas (vitest `vi.mock`), cobrir:
  - agente publicado + contexto com histórico → chama `runModelCall` SEM `tools` e SEM `maxSteps`, com `purpose: "draft_suggestion"`, e retorna `{ok:true, draft: <result.text>}`.
  - `loadPublishedAgentConfig` retorna `null` → `{ok:false, reason:"no_agent"}` (não chama runModelCall).
  - contato `is_blocked` (ou `is_anonymized`) no contexto → `{ok:false, reason:"blocked"}` (não chama runModelCall).
  - `result.text` vazio/whitespace → `{ok:false, reason:"empty"}`.
  Assertar que `runModelCall` foi chamado sem a chave `tools` (o defeito a evitar: mandar tools faz o modelo tentar `send_message`).

- [ ] **Step 3: Rodar e ver falhar.**

- [ ] **Step 4: Implementar** — esqueleto (ajustar nomes aos contratos lidos no Step 1):
  ```ts
  export async function generateDraftReply(db, llmCfg, crmCfg, input): Promise<DraftReplyResult> {
    const agent = await loadPublishedAgentConfig(db, input.tenantId, input.channelSessionId);
    if (!agent) return { ok: false, reason: "no_agent" };

    const ctx = await getLeadContext(db, crmCfg, {
      tenantId: input.tenantId, leadId: input.leadId, conversationId: input.conversationId,
    }, { maxTokens: agent.historyMessageWindow ?? DEFAULT_WINDOW /* ver knob real */ });

    if (ctx.context.contact.is_blocked || ctx.lgpd?.anonymized) return { ok: false, reason: "blocked" };

    const system =
      `${agent.systemPrompt}\n\n` +
      `[MODO RASCUNHO] Gere UMA resposta pronta para o vendedor humano enviar ao cliente. ` +
      `Escreva como o vendedor (NÃO se identifique como assistente/IA, NÃO use disclosure de bot). ` +
      `Responda só com o texto da mensagem, sem aspas nem comentários.`;

    const result = await runModelCall(db, llmCfg, {
      tenantId: input.tenantId,
      leadId: input.leadId,
      jobId: null,
      purpose: "draft_suggestion",
      system,
      messages: ctx.context.messages,      // ModelMessage[] — mesmo que o turno usa
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.provider && agent.credentialId
        ? { llmOverride: { provider: agent.provider, credentialId: agent.credentialId } }
        : {}),
      // SEM tools, SEM maxSteps → SDK para no 1º step, result.text vem pronto
    });

    const draft = (result.text ?? "").trim();
    if (!draft) return { ok: false, reason: "empty" };
    return { ok: true, draft };
  }
  ```

- [ ] **Step 5: Rodar e ver passar.**

- [ ] **Step 6: typecheck + commit**
  ```bash
  npm run typecheck
  git add lib/agent-engine/agent/draft-reply.ts lib/agent-engine/agent/__tests__/draft-reply.test.ts
  git commit -m "feat(draft): generateDraftReply — agente publicado em modo rascunho (sem tools/send/guardrails)"
  ```

---

### Task 2: Pool singleton + rota `draft-reply`

**Files:**
- Create: `lib/agent-engine/db/request-pool.ts`, `app/api/v1/conversations/[id]/draft-reply/route.ts`
- Test: `tests/unit/draft-reply-route.test.ts` (opcional se o padrão de rotas do repo tiver testes; senão cobrir via a prova E2E da Task 4 — verificar se há testes de rota em `app/api/v1/**/__tests__`)

**Interfaces:**
- Consumes: `generateDraftReply` (Task 1), `createPool`, `requireRole`, `ok`/`fail`, `createClient` (Supabase, p/ ler a conversa).
- Produces: `getRequestPool(): pg.Pool` (singleton lazy); `POST` → `{ data: { draft: string } }` ou erro.

- [ ] **Step 1: `request-pool.ts`** — singleton lazy espelhando `media-derive-worker.ts:34`:
  ```ts
  import { createPool } from "./pool";
  import type pg from "pg";
  let _pool: pg.Pool | null = null;
  export function getRequestPool(): pg.Pool {
    const url = process.env.SUPABASE_DB_URL;
    if (!url) throw new Error("SUPABASE_DB_URL ausente — rascunho da IA indisponível");
    if (!_pool) _pool = createPool(url);
    return _pool;
  }
  ```

- [ ] **Step 2: rota** — `app/api/v1/conversations/[id]/draft-reply/route.ts`:
  ```ts
  export async function POST(_req, { params }) {
    const requestId = randomUUID();
    const authz = await requireRole("agent", { requestId, resource: "conversations" });
    if (!authz.ok) return authz.response;
    const { org } = authz;
    const { id } = await params;

    const supabase = await createClient();
    const { data: conv } = await supabase
      .from("conversations")
      .select("id, organization_id, contact_id, channel_session_id, status")
      .eq("id", id).eq("organization_id", org.orgId).maybeSingle();
    if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });
    if (!conv.contact_id || !conv.channel_session_id)
      return fail("unprocessable", "Conversa sem contato/canal.", 422, { requestId });

    let pool; try { pool = getRequestPool(); }
    catch { return fail("unavailable", "Rascunho da IA indisponível (config).", 503, { requestId }); }

    const result = await generateDraftReply(
      pool, llmEdgeConfigFromEnv(process.env), crmEdgeConfigFromEnv(process.env),
      { tenantId: org.orgId, leadId: conv.contact_id, conversationId: conv.id, channelSessionId: conv.channel_session_id },
    ).catch((e) => { /* log estruturado */ return { ok: false, reason: "error" } as const; });

    if (!result.ok) {
      const map = { no_agent: ["no_agent","Nenhum agente publicado para sugerir resposta.",422],
                    blocked: ["blocked","Contato bloqueado/anonimizado.",422],
                    empty: ["empty","A IA não gerou um rascunho.",422],
                    error: ["internal_error","Erro ao gerar rascunho.",500] };
      const [code,msg,status] = map[result.reason] ?? map.error;
      return fail(code, msg, status, { requestId });
    }
    return ok({ draft: result.draft }, { requestId });
  }
  export const dynamic = "force-dynamic";
  ```
  Confirmar os nomes reais de `crmEdgeConfigFromEnv` (vem de `lib/agent-engine/edge/crm/mcp-client`) e `llmEdgeConfigFromEnv` (de `edge/llm/run-model-call`), como o worker importa (`workers/agent-worker/main.ts:32,37`).

- [ ] **Step 3: typecheck + lint + commit**
  ```bash
  npm run typecheck && npx eslint app/api/v1/conversations/[id]/draft-reply/route.ts lib/agent-engine/db/request-pool.ts
  git add lib/agent-engine/db/request-pool.ts "app/api/v1/conversations/[id]/draft-reply/"
  git commit -m "feat(draft): rota POST /conversations/[id]/draft-reply (pool singleton no web)"
  ```

---

### Task 3: Botão no composer + inserção

**Files:**
- Create: `hooks/inbox/useDraftReply.ts`, `components/inbox/composer/DraftReplyButton.tsx`
- Modify: `components/inbox/Composer.tsx`
- Test: `tests/unit/draft-reply-button.test.tsx`

**Interfaces:**
- Consumes: rota da Task 2 (via `apiClient`), `showApiError`.
- Produces: `useDraftReply()` (mutation → `{draft}`); `<DraftReplyButton conversationId onDraft(text) disabled />`; no Composer, ao receber o rascunho, insere no textarea (substitui o conteúdo atual se vazio, senão insere no cursor — reusar o padrão do EmojiButton) e foca.

- [ ] **Step 1: Teste (falhando)** — render do `DraftReplyButton`: clicar dispara a mutation (mockar `apiClient`), estado `pending` desabilita e mostra "Gerando…"; ao resolver, chama `onDraft("texto")`. Erro → `showApiError` (mockado) e não chama onDraft.

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: `useDraftReply`** — React Query `useMutation`, `mutationFn: (conversationId) => apiClient.post<{data:{draft:string}}>(\`/api/v1/conversations/${conversationId}/draft-reply\`)`, `onError: showApiError`. Sem invalidate (não muda estado do servidor).

- [ ] **Step 4: `DraftReplyButton`** — `Button variant="ghost" size="icon"` com ícone (usar `Sparkle` ou `MagicWand` se existir em `@/lib/ui/icons` — grep; senão `Robot`), `aria-label="Sugerir resposta"`, `disabled` quando `disabled || mutation.isPending`; enquanto pendente, um spinner/`aria-busy`. `onClick`: `mutation.mutate(conversationId, { onSuccess: (r) => onDraft(r.data.draft) })`.

- [ ] **Step 5: Integrar no Composer** — colocar `<DraftReplyButton>` na barra de ações (ao lado de AttachMenu/EmojiButton), passar `conversationId` e `disabled={isDisabled}`. `onDraft(text)`: se o textarea está vazio → `setText(text)`; senão inserir no cursor (padrão EmojiButton). Depois `requestAnimationFrame(() => { taRef.current?.focus(); autoresize(); })`. NÃO enviar automaticamente — o vendedor revisa e clica enviar.

- [ ] **Step 6: typecheck + testes + lint + commit**
  ```bash
  npm run typecheck && npx vitest run tests/unit/draft-reply-button.test.tsx && npx vitest run && npm run lint
  git add hooks/inbox/useDraftReply.ts components/inbox/composer/DraftReplyButton.tsx components/inbox/Composer.tsx tests/unit/draft-reply-button.test.tsx
  git commit -m "feat(draft): botão Sugerir resposta no composer (insere rascunho editável)"
  ```

---

### Task 4: Prova E2E real + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `inbox-multimodal-onda51-*.png`

- [ ] **Step 1: Ambiente** — dev server (porta deste worktree) + WAHA + sessão WORKING + agente publicado na org de teste (a org E2E `6e567068` tem `default_agent_id`; confirmar que há versão publicada no canal `e2e-wave12`; se não, publicar uma). Worker do agente NÃO é necessário (o endpoint roda o LLM inline). Precisa de credencial LLM real da org (OpenAI BYOK já cadastrada em sessões anteriores).
- [ ] **Step 2: Login como agente** (`e2e-agent`), abrir a conversa REAL `bcb64692` (contato "Rafael Melgaço").
- [ ] **Step 3:** clicar "Sugerir resposta" → confirmar loading → o rascunho aparece no composer (texto coerente com o histórico da conversa, na persona do agente, SEM "sou um assistente virtual"). Screenshot do rascunho no composer. Medir por ferramenta que o textarea tem conteúdo não-vazio.
- [ ] **Step 4:** editar levemente e enviar → provar entrega no WhatsApp real (SQL: `external_id` + `ack>=2`, `by_user=t`).
- [ ] **Step 5:** caso de erro amigável — numa org/canal SEM agente publicado, o botão retorna toast claro ("Nenhum agente publicado…"), não quebra a UI.
- [ ] **Step 6:** `npm run typecheck` + `lint` + `npx vitest run` verdes; atualizar HANDOFF (Onda 5.1 → status + provas) e commitar.

---

## Self-review (na escrita)

- **Cobertura do spec:** botão sob demanda (T3) + agente publicado em modo rascunho sem enviar (T1) + entra no composer editável (T3/T5) + prova real com envio (T4). ✅
- **Sem placeholders:** código concreto; os 2 pontos de "confirmar contrato" (shapes de PublishedAgentConfig/LeadContextResult; nomes dos `*EdgeConfigFromEnv`) mandam LER o arquivo real e espelhar o `inbound-turn.ts`, com as linhas exatas — não deixam lógica em aberto.
- **Riscos nomeados:** pg.Pool no web (singleton + 503 se sem env); `runModelCall` sem `tools` (senão o modelo tenta `send_message`); guardrails de anti-ban/disclosure deliberadamente pulados (rascunho revisado por humano). Custo limitado por `assertBudget` existente.
- **Tipos consistentes:** `DraftReplyResult` (T1) consumido na rota (T2) e mapeado a HTTP; `{data:{draft}}` (T2) consumido no hook (T3).
