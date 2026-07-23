# Onda 4 — Split de Mensagens Configurável Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O agente pode responder em várias mensagens curtas (bolhas), uma por vez, em vez de um textão — configurável por agente, com o pacing anti-ban existente espaçando cada bolha.

**Architecture:** Dois mecanismos. (1) **Instrução ao modelo**: quando `split_messages` está on, o opening ganha um bloco instruindo a responder em mensagens curtas (o modelo chama `send_message` várias vezes — cada chamada já é uma bolha paced). (2) **Splitter determinístico (garantia)**: no `send` callback do `send_message`, o `finalBody` (após os guardrails) é quebrado em bolhas ≤ `split_max_chars` por parágrafo→sentença→palavra; cada bolha ganha seu `seq` e um jitter humano entre elas. O gating (stop/disclosure/promise/anti-ban) roda UMA vez no corpo lógico; só o ENVIO se divide.

**Tech Stack:** TypeScript puro, agent-engine, Vitest. Zero infra nova.

## Global Constraints

- Spec mestre (Onda 4): `docs/superpowers/specs/2026-07-21-inbox-multimodal-design.md`. Handoff `HANDOFF-inbox-multimodal.md` (protocolo de prova visível).
- Migration: arquivo versionado + apêndice idempotente no `baseline.sql` + linha no MANIFEST + `database.types.ts`. Próximo nº: **0059** (o pre-commit hook pode forçar renumeração se colidir com branch irmã — seguir o número que o hook aceitar, refletindo em todos os artefatos).
- O gating dos guardrails (`runBeforeSend`) roda UMA vez por corpo lógico — NÃO rodar a cadeia por bolha (evita disclosure duplicado, spinning falso-positivo). Só o `channel.send` se divide.
- Cada bolha incrementa `seq` (alinhamento do ledger F2-06). Jitter entre bolhas via `deps.sleep`.
- `split_max_chars` default **600**; range aceito 200–4000. `split_messages` default **false** (opt-in).
- Splitter é PURO e nunca devolve vazio: texto ≤ max → `[texto]`; nunca corta no meio de palavra sem necessidade.
- Zod em input; sem `console.log`; typecheck/lint/testes verdes por task (sem pipe-tail).
- Prova: agente com split on responde com MÚLTIPLAS mensagens outbound num turno (SQL + tela).

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/agent-engine/agent/split-message.ts` (novo) | `splitIntoBubbles(text, maxChars): string[]` — puro. |
| `lib/agent-engine/agent/agent-config.ts` (mod) | Lê `splitMessages`/`splitMaxChars`. |
| `lib/agent-engine/agent/inbound-turn.ts` (mod) | Split no `send` callback do `send_message`; instrução no opening. |
| `supabase/migrations/..._0059_...` + baseline + MANIFEST | Colunas `split_messages`, `split_max_chars`. |

---

### Task 1: Migration 0059 — flags de split por-agente

**Files:**
- Create: `supabase/migrations/20260722130000_0059_agent_split_messages.sql`
- Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`, `lib/database.types.ts`

**Interfaces:**
- Produces: `ai_agent_versions.split_messages boolean not null default false`, `ai_agent_versions.split_max_chars integer not null default 600`.

- [ ] **Step 1: Criar a migration**

```sql
-- 0059: split de mensagens por-agente (Onda 4). split_messages liga o
-- comportamento; split_max_chars é o teto por bolha antes de quebrar.
alter table ai_agent_versions
  add column if not exists split_messages boolean not null default false,
  add column if not exists split_max_chars integer not null default 600;
```

- [ ] **Step 2: Apêndice idempotente no `supabase/baseline.sql`** (ao fim, padrão dos blocos existentes)

```sql
-- ---- split de mensagens por-agente (migration 0059) ----
alter table ai_agent_versions
  add column if not exists split_messages boolean not null default false,
  add column if not exists split_max_chars integer not null default 600;
```

- [ ] **Step 3: Linha no MANIFEST**

```markdown
| 0059 | 20260722130000_0059_agent_split_messages | Colunas `split_messages`/`split_max_chars` em ai_agent_versions (Onda 4 split de mensagens). |
```

- [ ] **Step 4: Aplicar e provar** — via `supabase db query --linked` (aprendizado das ondas anteriores: MCP exige OAuth; `agent_worker` sem grants). Prova:

```sql
select column_name from information_schema.columns
where table_name='ai_agent_versions' and column_name in ('split_messages','split_max_chars') order by column_name;
```

Expected: 2 linhas.

- [ ] **Step 5: Refletir em `lib/database.types.ts`** — nas Row/Insert/Update de `ai_agent_versions`: `split_messages: boolean` (Insert/Update `?: boolean`), `split_max_chars: number` (Insert/Update `?: number`).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add supabase/migrations/20260722130000_0059_agent_split_messages.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts
git commit -m "feat(split): migration 0059 — flags split_messages/split_max_chars por-agente"
```

---

### Task 2: `splitIntoBubbles` — splitter puro

**Files:**
- Create: `lib/agent-engine/agent/split-message.ts`
- Test: `tests/unit/agent-split-message.test.ts`

**Interfaces:**
- Produces: `splitIntoBubbles(text: string, maxChars: number): string[]`. Regras: `text.trim()` ≤ maxChars → `[trimmed]`; senão quebra por parágrafo (`\n\n`), depois por sentença (`. ! ?`), depois por palavra; junta pedaços adjacentes que caibam; nunca devolve `""` nem excede maxChars (exceto uma única palavra maior que maxChars, que vai sozinha). Vazio/whitespace → `[]`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/agent-split-message.test.ts
import { describe, expect, it } from "vitest";

import { splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

describe("splitIntoBubbles", () => {
  it("texto curto vira uma bolha só (trim)", () => {
    expect(splitIntoBubbles("  Olá, tudo bem?  ", 600)).toEqual(["Olá, tudo bem?"]);
  });
  it("vazio/whitespace → []", () => {
    expect(splitIntoBubbles("", 600)).toEqual([]);
    expect(splitIntoBubbles("   \n  ", 600)).toEqual([]);
  });
  it("quebra por parágrafo quando cabe", () => {
    const out = splitIntoBubbles("Primeiro parágrafo.\n\nSegundo parágrafo.", 30);
    expect(out).toEqual(["Primeiro parágrafo.", "Segundo parágrafo."]);
  });
  it("nenhuma bolha excede maxChars (quebra por sentença)", () => {
    const text = "Oi! Como você está hoje? Queria falar do seu pedido. Ele já saiu para entrega.";
    const out = splitIntoBubbles(text, 30);
    expect(out.every((b) => b.length <= 30)).toBe(true);
    expect(out.join(" ")).toContain("pedido");
  });
  it("junta sentenças curtas adjacentes até o teto", () => {
    const out = splitIntoBubbles("Oi. Tudo bem? Beleza.", 100);
    expect(out).toHaveLength(1); // tudo cabe em 100
  });
  it("palavra única maior que o teto vai sozinha (não corta no meio)", () => {
    const big = "a".repeat(50);
    const out = splitIntoBubbles(`curto ${big} fim`, 20);
    expect(out).toContain(big);
    expect(out.every((b) => b.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/unit/agent-split-message.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/agent-engine/agent/split-message.ts
/**
 * Quebra o texto da resposta em "bolhas" curtas (Onda 4) — parágrafo → sentença
 * → palavra, juntando pedaços adjacentes que caibam em maxChars. Puro. Usado no
 * send do agente quando split_messages está on; o pacing anti-ban espaça cada
 * bolha. Nunca devolve bolha vazia nem (salvo palavra atômica gigante) > maxChars.
 */
export function splitIntoBubbles(text: string, maxChars: number): string[] {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Unidades atômicas: parágrafos → sentenças. Cada unidade que ainda estoura é
  // quebrada por palavra.
  const units: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (p === "") continue;
    if (p.length <= maxChars) {
      units.push(p);
      continue;
    }
    for (const sentence of splitSentences(p)) {
      if (sentence.length <= maxChars) units.push(sentence);
      else units.push(...splitWords(sentence, maxChars));
    }
  }

  // Junta unidades adjacentes enquanto couberem (com espaço).
  const bubbles: string[] = [];
  let cur = "";
  for (const u of units) {
    const joined = cur === "" ? u : `${cur} ${u}`;
    if (joined.length <= maxChars) {
      cur = joined;
    } else {
      if (cur !== "") bubbles.push(cur);
      cur = u;
    }
  }
  if (cur !== "") bubbles.push(cur);
  return bubbles;
}

/** Divide em sentenças mantendo a pontuação final (. ! ?). */
function splitSentences(text: string): string[] {
  const out = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g);
  return (out ?? [text]).map((s) => s.trim()).filter((s) => s !== "");
}

/** Última linha de defesa: agrupa palavras até maxChars; palavra atômica > max vai sozinha. */
function splitWords(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if (w === "") continue;
    const joined = cur === "" ? w : `${cur} ${w}`;
    if (joined.length <= maxChars) cur = joined;
    else {
      if (cur !== "") out.push(cur);
      cur = w;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar** — PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add lib/agent-engine/agent/split-message.ts tests/unit/agent-split-message.test.ts
git commit -m "feat(split): splitIntoBubbles — quebra pura por parágrafo/sentença/palavra"
```

---

### Task 3: agent-config lê as flags de split

**Files:**
- Modify: `lib/agent-engine/agent/agent-config.ts`
- Test: (coberto pela prova E2E; agent-config não tem teste unitário isolado no repo)

**Interfaces:**
- Consumes: colunas da Task 1.
- Produces: `PublishedAgentConfig.splitMessages: boolean` e `PublishedAgentConfig.splitMaxChars: number`.

- [ ] **Step 1: Estender a interface** — em `PublishedAgentConfig` (após `handoffToolEnabled`):

```ts
  splitMessages: boolean;
  splitMaxChars: number;
```

- [ ] **Step 2: Estender `Row`** — após `handoff_tool_enabled: boolean;`:

```ts
  split_messages: boolean;
  split_max_chars: number;
```

- [ ] **Step 3: SELECT** — após `v.handoff_tool_enabled,`:

```ts
            v.split_messages,
            v.split_max_chars,
```

- [ ] **Step 4: return** — após `handoffToolEnabled: r.handoff_tool_enabled,`:

```ts
    splitMessages: r.split_messages,
    splitMaxChars: r.split_max_chars,
```

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add lib/agent-engine/agent/agent-config.ts
git commit -m "feat(split): agent-config lê split_messages/split_max_chars"
```

---

### Task 4: Split no envio + instrução no opening

**Files:**
- Modify: `lib/agent-engine/agent/inbound-turn.ts`
- Test: `tests/unit/agent-split-send.test.ts` (testa o helper de envio-em-bolhas isolado)

**Interfaces:**
- Consumes: `splitIntoBubbles` (Task 2); `agentConfig.splitMessages`/`splitMaxChars` (Task 3).
- Produces: no `send` callback do `send_message`, quando split on e `finalBody` > maxChars, envia N bolhas (cada uma `channel.send` com `seq++`), com jitter entre elas; retorna o outcome da última (ou o primeiro não-`sent`, encerrando). Instrução no opening quando split on.

- [ ] **Step 1: Escrever o teste do helper de envio-em-bolhas**

O envio-em-bolhas é extraído como helper puro-ish `sendInBubbles` para ser testável sem o turno inteiro.

```ts
// tests/unit/agent-split-send.test.ts
import { describe, expect, it, vi } from "vitest";

import { sendInBubbles } from "@/lib/agent-engine/agent/split-message";

describe("sendInBubbles", () => {
  it("split off → 1 envio com o corpo inteiro", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const sleep = vi.fn(async () => undefined);
    const out = await sendInBubbles("um texto qualquer", { enabled: false, maxChars: 600, send, sleep, jitter: () => 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("um texto qualquer");
    expect(out.kind).toBe("sent");
  });

  it("split on + texto longo → N envios com jitter entre eles", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const sleep = vi.fn(async () => undefined);
    const text = "Primeira ideia aqui.\n\nSegunda ideia aqui.\n\nTerceira ideia aqui.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 25, send, sleep, jitter: () => 900 });
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(sleep).toHaveBeenCalledWith(900); // jitter entre bolhas
    expect(out.kind).toBe("sent");
  });

  it("para no primeiro envio não-sent (veto/falha) e devolve esse outcome", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ kind: "sent", messageId: "m1" })
      .mockResolvedValueOnce({ kind: "blocked" });
    const sleep = vi.fn(async () => undefined);
    const text = "Bolha um aqui.\n\nBolha dois aqui.\n\nBolha três aqui.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 20, send, sleep, jitter: () => 0 });
    expect(out.kind).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(2); // parou na 2ª
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — FAIL (`sendInBubbles` não existe).

- [ ] **Step 3: Implementar `sendInBubbles`** — adicionar em `lib/agent-engine/agent/split-message.ts`:

```ts
/** Outcome mínimo que o send do canal devolve (subconjunto usado aqui). */
export interface BubbleOutcome {
  kind: string;
  messageId?: string;
}

export interface SendInBubblesOpts {
  enabled: boolean;
  maxChars: number;
  send: (body: string) => Promise<BubbleOutcome>;
  sleep: (ms: number) => Promise<void>;
  /** ms de jitter humano entre bolhas (só entre, não antes da 1ª). */
  jitter: () => number;
}

/**
 * Envia o corpo em bolhas quando `enabled`; senão um envio só. Cada bolha passa
 * pelo mesmo `send` (que no runtime é o channel.send pós-guardrails, com seq++).
 * Para no 1º outcome que não seja de sucesso ('sent'/'already_sent'/'queued')
 * e o devolve — não segue mandando bolha após veto/bloqueio/falha.
 */
const OK_KINDS = new Set(["sent", "already_sent", "queued"]);

export async function sendInBubbles(body: string, opts: SendInBubblesOpts): Promise<BubbleOutcome> {
  const bubbles = opts.enabled ? splitIntoBubbles(body, opts.maxChars) : [body];
  if (bubbles.length === 0) return opts.send(body); // corpo vazio: deixa o canal decidir
  let last: BubbleOutcome = { kind: "sent" };
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await opts.sleep(opts.jitter());
    last = await opts.send(bubbles[i]!);
    if (!OK_KINDS.has(last.kind)) return last; // veto/bloqueio/falha: para aqui
  }
  return last;
}
```

- [ ] **Step 4: Rodar e ver passar** — `npx vitest run tests/unit/agent-split-send.test.ts` → PASS (3 testes).

- [ ] **Step 5: Integrar no `send` callback do `send_message`** — em `lib/agent-engine/agent/inbound-turn.ts`, o `send: (finalBody) => { seq += 1; return channel.send({...}) }` (dentro de `runBeforeSend`, ~L809-819) passa a usar `sendInBubbles`:

```ts
            send: (finalBody) =>
              sendInBubbles(finalBody, {
                enabled: agentConfig?.splitMessages ?? false,
                maxChars: agentConfig?.splitMaxChars ?? 600,
                sleep: deps.sleep,
                jitter: () => 700 + Math.floor(Math.random() * 800), // 700–1500ms humano
                send: (bubble) => {
                  seq += 1;
                  return channel.send({
                    tenantId,
                    leadId,
                    jobId: job.id,
                    seq,
                    conversationId: input.conversationId,
                    body: bubble,
                  });
                },
              }),
```

Adicionar o import no topo: `import { sendInBubbles, splitIntoBubbles } from './split-message';` (o `splitIntoBubbles` pode já vir junto se usado no opening — ver Step 6).

> **Nota:** `channel.send` retorna um outcome com `kind` — confira o shape real (`sent`/`already_sent`/`queued`/`blocked`/`failed`/`unavailable`) e que `BubbleOutcome` (Task 4 Step 3) casa. Se `channel.send` devolver um tipo mais rico, `sendInBubbles` só lê `.kind` — compatível. Ajuste o tipo de retorno do `send` interno para o outcome real (não `any`).

- [ ] **Step 6: Instrução no opening quando split on** — em `ritualBlocks`/`buildOpeningMessage` (ou onde os blocos do opening são montados), acrescentar, condicionado a `splitMessages`, um bloco curto. O ponto mais simples: no `inbound-turn.ts`, onde `openingSuffixes` é montado (~L1150), incluir um sufixo:

```ts
  const splitHint = (agentConfig?.splitMessages ?? false)
    ? 'Responda em mensagens curtas e naturais, uma ideia por mensagem — como uma pessoa digitando no WhatsApp. Prefira várias mensagens curtas a um texto único e longo.'
    : '';
  const openingSuffixes = [matchedSkillsBlock, stageHintBlock, splitHint].filter((b) => b !== '');
```

(substitui a linha atual de `openingSuffixes`.)

- [ ] **Step 7: Rodar tudo + commit**

```bash
npm run typecheck
npx vitest run
git add lib/agent-engine/agent/inbound-turn.ts lib/agent-engine/agent/split-message.ts tests/unit/agent-split-send.test.ts
git commit -m "feat(split): envia em bolhas no send_message + instrução no opening (split on)"
```

---

### Task 5: Prova E2E real + HANDOFF

**Files:**
- Modify: `HANDOFF-inbox-multimodal.md`
- Evidência: `.superpowers/evidence/inbox-multimodal-onda4-*.png`

- [ ] **Step 1: Ambiente** — dev server + WAHA + worker de agente rodando; agente publicado com `split_messages=true`, `split_max_chars` pequeno (ex.: 120) para forçar split; provider com credencial válida (OpenAI).

- [ ] **Step 2: Turno com resposta longa** — disparar um turno cujo prompt leve o agente a uma resposta longa (ex.: pedir explicação de vários passos). Verificar por SQL que UM turno gerou VÁRIAS mensagens outbound (bolhas), cada uma com `seq` crescente e `sent_at` espaçado:

```sql
select seq_from_metadata, left(body,60), sent_at
from messages where conversation_id = '<conv>' and direction='outbound'
  and created_at > now() - interval '2 minutes' order by created_at;
```

Expected: ≥2 linhas (bolhas) do mesmo turno; nenhuma > split_max_chars.

- [ ] **Step 3: Prova na tela** — na conversa (Playwright), screenshot mostrando as várias bolhas curtas do agente (não um textão). Comparar com split off (uma bolha) num segundo turno.

- [ ] **Step 4: UX check** — as bolhas chegam espaçadas (jitter), em ordem; nenhuma cortada no meio de palavra; console limpo.

- [ ] **Step 5: Suíte + HANDOFF + commit** — `npm run typecheck` + `npm run lint` + `npx vitest run` verdes. Atualizar `HANDOFF-inbox-multimodal.md` (Onda 4 → status + prova) e commitar.

---

## Self-review (feito na escrita)

- **Cobertura do spec (Onda 4):** flag por-agente em `ai_agent_versions` (T1), instrução ao modelo (T4 Step 6), splitter determinístico com cada parte pelo before_send/pacing — nota de design: o gating roda 1x e só o SEND divide (evita disclosure duplicado), cada bolha com seq próprio e jitter; zero infra nova (T2+T4). Prova de múltiplas bolhas num turno (T5).
- **Sem placeholders:** código/comandos/expected concretos. A nota do Step 5 aponta verificar o shape real de `channel.send` — leitura obrigatória, não lógica em aberto.
- **Consistência de tipos:** `splitIntoBubbles`/`sendInBubbles`/`BubbleOutcome` (T2/T4) usados no inbound-turn; `splitMessages`/`splitMaxChars` (T3) lidos em T4.
