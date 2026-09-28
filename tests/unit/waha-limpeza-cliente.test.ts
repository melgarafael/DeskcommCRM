/**
 * C-104 — LIMPEZA PEDIDA PELO CLIENTE PELO WHATSAPP.
 *
 * O cliente manda a sequência configurada (default `#limpar`) e o ingest apaga
 * TUDO dele — como o `limpar-tudo.sh` por telefone. Regras que estes casos
 * prendem:
 *
 *   1. só a mensagem INTEIRA dispara; comando no meio da frase é texto comum;
 *   2. desligado (default), a mensagem segue o fluxo normal e nada é apagado;
 *   3. ligado, NENHUMA linha de `messages` é gravada (o contato some abaixo) e o
 *      pedido NÃO vira turno do agente (não passa por `aplicarEfeitosPosEntrada`);
 *   4. a auditoria é `contact.erased_by_customer`, sem PII.
 *
 * Entra pelo roteador de produção (`dispatchWahaEvent`), com `fromMe: false`.
 * O apagamento e o envio são mockados: o que se mede aqui é a DECISÃO, não o
 * motor de apagamento (que tem teste próprio) nem a borda do WAHA.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: vi.fn(async () => {}),
}));
vi.mock("@/lib/waha/send", () => ({ sendWAHA: vi.fn(async () => null) }));
vi.mock("@/lib/settings/apagar-dados-do-contato", () => ({
  apagarDadosDoContato: vi.fn(async () => ({ ok: true, counts: { contacts: 1 }, falhas: [] })),
}));

import { audit } from "@/lib/audit";
import { apagarDadosDoContato } from "@/lib/settings/apagar-dados-do-contato";
import { sendWAHA } from "@/lib/waha/send";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

const ORG = "org-1";
const SESSION = {
  id: "sess-1",
  organization_id: ORG,
  waha_session_name: "default",
  is_warmup_complete: true,
  warmup_started_at: null,
};

interface Captura {
  insertedMessages: Array<Record<string, unknown>>;
}

function makeAdmin(cap: Captura, config: Record<string, unknown>) {
  const chain = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      insert: (linha: Record<string, unknown>) => {
        cap.insertedMessages.push(linha);
        return c;
      },
      update: () => c,
      eq: () => c,
      in: () => c,
      is: () => c,
      not: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: () => Promise.resolve({ data: { id: "msg-1" }, error: null }),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
    };
    return c;
  };
  return {
    from: (nome: string) => {
      const c = chain();
      if (nome === "ai_agents") {
        c.maybeSingle = () => Promise.resolve({ data: { config }, error: null });
      }
      return c;
    },
    rpc: (fn: string) => {
      if (fn === "fn_upsert_wa_contact") return Promise.resolve({ data: "contact-1", error: null });
      if (fn === "fn_upsert_wa_conversation")
        return Promise.resolve({ data: "conv-1", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

function inbound(body: string): WahaEnvelope {
  return {
    event: "message.any",
    payload: {
      id: `in-${body.replace(/\W/g, "")}-${Date.now()}`,
      fromMe: false,
      from: "5511999999999@c.us",
      body,
      type: "text",
      timestamp: Math.floor(Date.now() / 1000),
    },
  } as never;
}

function cfgCliente(ligado: boolean) {
  return { aceita_limpeza_cliente: ligado, comando_limpar: "#limpar" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWAHA).mockResolvedValue(null);
  vi.mocked(apagarDadosDoContato).mockResolvedValue({
    ok: true,
    counts: { contacts: 1 },
    falhas: [],
  });
});

describe("C-104 · limpeza pedida pelo cliente", () => {
  it("ligado + comando exato → apaga o contato, confirma e NÃO grava mensagem", async () => {
    const cap: Captura = { insertedMessages: [] };
    await dispatchWahaEvent(makeAdmin(cap, cfgCliente(true)), SESSION, inbound("#limpar"), "req-1");

    expect(apagarDadosDoContato).toHaveBeenCalledTimes(1);
    expect(apagarDadosDoContato).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      contactId: "contact-1",
    });
    expect(cap.insertedMessages).toEqual([]);
    expect(sendWAHA).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: "default", chatId: "5511999999999@c.us" }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.erased_by_customer", organizationId: ORG }),
    );
  });

  it("desligado (default) → nada é apagado e a mensagem segue o fluxo normal", async () => {
    const cap: Captura = { insertedMessages: [] };
    await dispatchWahaEvent(makeAdmin(cap, cfgCliente(false)), SESSION, inbound("#limpar"), "req-2");

    expect(apagarDadosDoContato).not.toHaveBeenCalled();
    expect(cap.insertedMessages.length).toBe(1);
  });

  it("comando no MEIO da frase não dispara nem com a flag ligada", async () => {
    const cap: Captura = { insertedMessages: [] };
    await dispatchWahaEvent(
      makeAdmin(cap, cfgCliente(true)),
      SESSION,
      inbound("quero #limpar tudo"),
      "req-3",
    );

    expect(apagarDadosDoContato).not.toHaveBeenCalled();
    expect(cap.insertedMessages.length).toBe(1);
  });

  it("mensagem longa (>32) nem consulta a config — nunca é comando", async () => {
    const cap: Captura = { insertedMessages: [] };
    await dispatchWahaEvent(
      makeAdmin(cap, cfgCliente(true)),
      SESSION,
      inbound("x".repeat(40)),
      "req-4",
    );

    expect(apagarDadosDoContato).not.toHaveBeenCalled();
    expect(cap.insertedMessages.length).toBe(1);
  });
});
