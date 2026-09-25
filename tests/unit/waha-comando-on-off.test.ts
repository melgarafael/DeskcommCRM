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
// O transporte de volta (revogar o comando no WhatsApp do cliente).
const deleteMessage = vi.fn(async () => {});
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => ({ deleteMessage }) }));

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
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

/** Updates em `contacts` da última chamada de `makeAdmin` (o opt-out mora lá). */
const contactUpdates: Array<Record<string, unknown>> = [];

interface AgenteFalso {
  id: string;
  aceita?: boolean;
  pausado?: boolean;
}

function makeAdmin(
  cap: Captura,
  opts: {
    jaRegistrada?: boolean;
    aceitaComandos?: boolean;
    /** Agentes da org; sem isto, um único agente no ar com `aceitaComandos`. */
    agentes?: AgenteFalso[];
    /** `conversations.active_ai_agent_id` — a stickiness gravada pelo router. */
    agenteDaConversa?: string | null;
    /** A leitura da conversa por `devolverAtendimentoAoAgente` falha. */
    devolucaoFalha?: boolean;
  } = {},
) {
  contactUpdates.length = 0;
  const agentes = (opts.agentes ?? [{ id: "ag-1", aceita: opts.aceitaComandos === true }]).map((a) => ({
    id: a.id,
    config: { aceita_comandos_celular: a.aceita === true },
    kind: "mcp_agent",
    is_active: true,
    paused_at: a.pausado ? "2026-09-24T12:00:00Z" : null,
    published_version_id: `v-${a.id}`,
    archived_at: null,
    priority: 0,
    created_at: "2026-09-01T00:00:00Z",
  }));
  const table = (name: string) => {
    let mode: "select" | "insert" | "update" = "select";
    let colunas = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (c?: string) => {
        colunas = c ?? "";
        return chain;
      },
      insert: (linha: Record<string, unknown>) => {
        mode = "insert";
        if (name === "messages") cap.insertedMessages.push(linha);
        return chain;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        if (name === "conversations") cap.conversationUpdates.push(p);
        if (name === "contacts") contactUpdates.push(p);
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      is: () => chain,
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
        if (name === "conversations" && mode === "select" && opts.devolucaoFalha && colunas.includes("assigned_to_user_id")) {
          return Promise.resolve({ data: null, error: { message: "conexão caiu" } });
        }
        if (name === "conversations" && mode === "select") {
          return Promise.resolve({
            data: {
              bot_silenced_until: null,
              channel_session_id: null,
              active_ai_agent_id: opts.agenteDaConversa ?? null,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // Lista sem `maybeSingle`: os candidatos de `resolverAgenteDaConversa`.
      then: (r: (v: unknown) => unknown) =>
        Promise.resolve(
          name === "ai_agents" && mode === "select" ? { data: agentes, error: null } : { data: null, error: null },
        ).then(r),
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

  it("#on → devolve o atendimento à IA (limpa as travas), sem pausar", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, { aceitaComandos: true }), SESSION, comando("#on"), "req-on");

    // A mensagem do comando é gravada…
    expect(cap.insertedMessages).toHaveLength(1);
    // …e o caminho de devolução foi acionado (sinal durável de retomada).
    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(true);
    // NÃO pausou: nenhum update gravou o silêncio durável.
    expect(cap.conversationUpdates.some((u) => u.bot_silenced_until === "infinity")).toBe(false);
  });

  it("mensagem NORMAL do celular continua pausando (com prazo, como antes)", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap), SESSION, comando("Oi, já te respondo"), "req-n");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa).toBeDefined();
    expect(pausa!.bot_silenced_until).not.toBe("infinity");
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
  const auditado = () =>
    vi.mocked(audit).mock.calls.map((c) => (c[0] as { metadata?: Record<string, unknown> }).metadata ?? {});

  it("DESLIGADO: '#off' é texto comum — pausa COM PRAZO, não revoga, nada de comando no rastro", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap), SESSION, comando("#off"), "req-off-igual");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa!.bot_silenced_until).not.toBe("infinity");
    expect(Number.isFinite(new Date(String(pausa!.bot_silenced_until)).getTime())).toBe(true);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cap.insertedMessages[0]!.metadata).toEqual({ raw_type: "text", fromMe: true });
    expect(auditado().some((m) => "control_command" in m)).toBe(false);
  });

  it("LIGADO: '#off' silencia DURÁVEL, revoga o comando e deixa rastro no audit", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, { aceitaComandos: true }), SESSION, comando("#off"), "req-off-ligado");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa!.bot_silenced_until).toBe("infinity");
    expect(String(pausa!.last_handoff_reason)).toMatch(/#off/);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(auditado().some((m) => m.control_command === "off")).toBe(true);
  });

  it("LIGADO: '#on' religa (devolve ao agente) e revoga o comando", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, { aceitaComandos: true }), SESSION, comando("#on"), "req-on-ligado");

    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(true);
    expect(cap.conversationUpdates.some((u) => u.bot_silenced_until === null)).toBe(true);
    expect(cap.conversationUpdates.some((u) => u.bot_silenced_until === "infinity")).toBe(false);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    // STOP/opt-out é do CLIENTE: o #on do operador nunca o desfaz.
    expect(contactUpdates.some((u) => "is_blocked" in u)).toBe(false);
  });

  it("LIGADO: '#on' que NÃO devolveu fica no chat (não revoga) e deixa log", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(
      makeAdmin(cap, { aceitaComandos: true, devolucaoFalha: true }),
      SESSION,
      comando("#on"),
      "req-on-falhou",
    );

    expect(cap.conversationUpdates.some((u) => u.bot_silenced_until === null)).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("#on do celular nao devolveu"),
      expect.objectContaining({ erro: "conversation_not_found" }),
    );
  });

  it("LIGADO: resposta NORMAL pelo celular pausa DURÁVEL (o #on é quem religa)", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(makeAdmin(cap, { aceitaComandos: true }), SESSION, comando("Oi, já te respondo"), "req-n-ligado");

    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa!.bot_silenced_until).toBe("infinity");
    expect(String(pausa!.last_handoff_reason)).toMatch(/manual/i);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("o interruptor é do agente DA CONVERSA: ligado no vizinho não vale aqui", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(
      makeAdmin(cap, {
        agentes: [
          { id: "ag-ligado", aceita: true },
          { id: "ag-desta-conversa", aceita: false },
        ],
        agenteDaConversa: "ag-desta-conversa",
      }),
      SESSION,
      comando("#off"),
      "req-vizinho",
    );
    const pausa = cap.conversationUpdates.find((u) => u.last_handoff_reason !== undefined);
    expect(pausa!.bot_silenced_until).not.toBe("infinity");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("agente PAUSADO não atende — o interruptor dele não vale", async () => {
    const cap: Captura = { conversationUpdates: [], insertedMessages: [], rpcs: [] };
    await dispatchWahaEvent(
      makeAdmin(cap, { agentes: [{ id: "ag-1", aceita: true, pausado: true }] }),
      SESSION,
      comando("#on"),
      "req-pausado",
    );
    expect(cap.rpcs.some((r) => r.fn === "emit_event")).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

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
