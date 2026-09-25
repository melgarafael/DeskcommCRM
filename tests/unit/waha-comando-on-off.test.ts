/**
 * C-075 — LIGA/DESLIGA DO AGENTE PELO CELULAR (`#on`/`#off`).
 *
 * O dono digita o comando no chat do cliente (o celular dele é o número do bot):
 *   - `#off` → pausa DURÁVEL (`bot_silenced_until='infinity'`)
 *   - `#on`  → devolve o atendimento à IA (limpa as 3 travas)
 *
 * Regras que estes casos prendem:
 *   1. o cliente NUNCA dispara comando (só mensagem `fromMe`/saída);
 *   2. comando só vale quando é a mensagem INTEIRA;
 *   3. o comando NÃO pode ser confundido com o eco de um envio nosso;
 *   4. TODA mensagem — inclusive o próprio comando — continua sendo GRAVADA.
 *
 * Prova pelo `dispatchWahaEvent` real (admin client mockado).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { dispatchWahaEvent } from "@/lib/waha/ingest";

const ORG = "org-1";
const SESSION = {
  id: "sess-1",
  organization_id: ORG,
  waha_session_name: "default",
  is_warmup_complete: true,
  warmup_started_at: null,
};

interface Captura {
  conversationUpdates: Array<Record<string, unknown>>;
  insertedMessages: Array<Record<string, unknown>>;
  rpcs: Array<{ fn: string; args: unknown }>;
}

function makeAdmin(
  cap: Captura,
  opts: {
    jaRegistrada?: boolean;
    aceitaComandos?: boolean;
    ligar?: string;
    desligar?: string;
    /** Estado da conversa que o SELECT inicial devolve. Default: destravada. */
    conversa?: { bot_silenced_until: string | null; assignee_kind?: string };
  } = {},
) {
  const table = (name: string) => {
    let mode: "select" | "insert" | "update" = "select";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: (linha: Record<string, unknown>) => {
        mode = "insert";
        if (name === "messages") cap.insertedMessages.push(linha);
        return chain;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        if (name === "conversations") cap.conversationUpdates.push(p);
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      not: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        if (name === "messages" && mode === "select") {
          return Promise.resolve({
            data: opts.jaRegistrada ? { id: "eco" } : null,
            error: null,
          });
        }
        if (name === "messages" && mode === "insert") {
          return Promise.resolve({ data: { id: "msg-nova" }, error: null });
        }
        if (name === "conversations" && mode === "update") {
          // Contrato de `pausarIaDuravelmente`: linha de volta = gravou.
          return Promise.resolve({ data: { id: "conv-1" }, error: null });
        }
        if (name === "conversations" && mode === "select") {
          // Campos que o `pausarIaDuravelmente` e o `reativarAutomaticoNaConversa`
          // leem. Default = conversa destravada (pausa grava); o teste do `#on`
          // passa `conversa` travada.
          return Promise.resolve({
            data: {
              bot_silenced_until: opts.conversa?.bot_silenced_until ?? null,
              assigned_to_user_id: "user-1",
              assignee_kind: opts.conversa?.assignee_kind ?? "user",
              status: "claimed",
              contact_id: "contact-1",
            },
            error: null,
          });
        }
        // C-076/C-077: consulta da config do agente (flag + sequências).
        if (name === "ai_agents" && mode === "select") {
          return Promise.resolve({
            data: {
              config: {
                aceita_comandos_celular: opts.aceitaComandos === true,
                ...(opts.ligar !== undefined ? { comando_ligar: opts.ligar } : {}),
                ...(opts.desligar !== undefined ? { comando_desligar: opts.desligar } : {}),
              },
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
    };
    return chain;
  };
  return {
    from: (n: string) => table(n),
    rpc: (fn: string, args?: unknown) => {
      cap.rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return Promise.resolve({ data: "contact-1", error: null });
      if (fn === "fn_upsert_wa_conversation")
        return Promise.resolve({ data: "conv-1", error: null });
      if (fn === "fn_conversation_assign")
        return Promise.resolve({ data: [{ id: "conv-1" }], error: null });
      // `emit_event` (sinal de ai.handoff_resolved) e demais: sucesso.
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

const comando = (body: string) => ({
  event: "message.any",
  payload: {
    id: `true_5511999999999@c.us_${body.replace(/\W/g, "")}${Date.now()}`,
    fromMe: true,
    to: "5511999999999@c.us",
    body,
    type: "text",
    timestamp: Math.floor(Date.now() / 1000),
  },
});

beforeEach(() => vi.clearAllMocks());

describe("C-075 · comando do celular controla o automático", () => {
  it("#off → pausa DURÁVEL e grava a mensagem", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, { aceitaComandos: true }), SESSION, comando("#off"), "req-off");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(pausa!.bot_silenced_until).toBe("infinity");
    expect(String(pausa!.last_handoff_reason)).toMatch(/#off/i);
    // A mensagem do comando NUNCA deixa de ser registrada.
    expect(cap.insertedMessages).toHaveLength(1);
    // `#off` já está pausado — não dispara o claim/devolver.
    expect(cap.rpcs.some((r) => r.fn === "fn_conversation_assign")).toBe(false);
  });

  it("#on → devolve o automático (limpa as travas), sem pausar", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, { aceitaComandos: true, conversa: { bot_silenced_until: "infinity" } }), SESSION, comando("#on"), "req-on");

    // A mensagem do comando é gravada…
    expect(cap.insertedMessages).toHaveLength(1);
    // …e a reativação foi gravada (bot_silenced_until = null).
    expect(
      cap.conversationUpdates.some((u) => u.bot_silenced_until === null && u.assignee_kind === "ai"),
    ).toBe(true);
    // C-080: o `#on` é um INTERRUPTOR — NÃO dispara a retomada de follow-up
    // (`ai.handoff_resolved`), que é do botão "devolver" da tela.
    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(false);
    // NÃO pausou.
    expect(cap.conversationUpdates.some((u) => u.bot_silenced_until === "infinity")).toBe(false);
  });

  it("mensagem NORMAL do celular continua pausando (durável)", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap), SESSION, comando("Oi, já te respondo"), "req-n");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(pausa!.bot_silenced_until).toBe("infinity");
    expect(String(pausa!.last_handoff_reason)).toMatch(/manual/i);
  });

  it("texto com #on/#off no MEIO da frase NÃO é comando (pausa como mensagem normal)", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap), SESSION, comando("vou dar um #off agora"), "req-meio");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(String(pausa!.last_handoff_reason)).toMatch(/manual/i);
    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(false);
  });

  it("eco do próprio envio com corpo '#off' NÃO pausa nem devolve", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(
      makeAdmin(cap, { jaRegistrada: true }),
      SESSION,
      comando("#off"),
      "req-eco",
    );
    expect(cap.conversationUpdates.some((u) => u.last_handoff_reason !== undefined)).toBe(false);
    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(false);
  });
});

describe("C-076 · o comando só VALE se o agente aceitar (config da UI)", () => {
  it("DESLIGADO (default): '#off' NÃO pausa por comando — só a pausa normal da mensagem", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap), SESSION, comando("#off"), "req-off-desligado");

    // A pausa que aconteceu é a da mensagem manual (não a do comando).
    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(String(pausa!.last_handoff_reason)).toMatch(/manual/i);
    expect(String(pausa!.last_handoff_reason)).not.toMatch(/#off/i);
  });

  it("DESLIGADO (default): '#on' NÃO devolve o atendimento à IA", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap), SESSION, comando("#on"), "req-on-desligado");

    // Sem devolução: nada de `emit_event` de retomada, e a linha vira pausa normal.
    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(false);
    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(String(pausa!.last_handoff_reason)).toMatch(/manual/i);
  });
});

describe("C-077 · sequências PERSONALIZADAS na tela", () => {
  it("emoji/palavra configurados controlam a IA (#on/#off deixam de valer)", async () => {
    const seq = { aceitaComandos: true, ligar: "religar", desligar: "pausar tudo" };
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, seq), SESSION, comando("pausar tudo"), "req-off-custom");
    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(pausa!.bot_silenced_until).toBe("infinity");

    const cap2: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap2, { ...seq, conversa: { bot_silenced_until: "infinity" } }), SESSION, comando("religar"), "req-on-custom");
    expect(
      cap2.conversationUpdates.some((u) => u.bot_silenced_until === null && u.assignee_kind === "ai"),
    ).toBe(true);

    // O padrão antigo NÃO dispara quando há sequência configurada: a mensagem
    // `#on` vira pausa normal (não reativa).
    const cap3: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap3, seq), SESSION, comando("#on"), "req-on-antigo");
    expect(cap3.conversationUpdates.some((u) => u.assignee_kind === "ai")).toBe(false);
    expect(cap3.conversationUpdates.some((u) => u.bot_silenced_until === "infinity")).toBe(true);
  });
});
