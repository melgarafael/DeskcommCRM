import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ingestRyzeInbound } from "@/lib/channels/ryze/ingest";

const efeitos = vi.hoisted(() => ({ aplicar: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: efeitos.aplicar }));

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };

function adminFake(options: {
  insert?: QueryResult;
  status?: QueryResult;
  outgoing?: QueryResult;
} = {}) {
  const calls: Array<{ op: string; table?: string; values?: unknown }> = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push({ op: name });
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    if (name === "fn_mark_conversation_message") return { data: null, error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    const builder = {
      insert(values: unknown) {
        calls.push({ op: "insert", table, values });
        return {
          select: () => ({ maybeSingle: async () => options.insert ?? { data: { id: "message-1" }, error: null } }),
        };
      },
      update(values: unknown) {
        calls.push({ op: "update", table, values });
        return builder;
      },
      eq() { return builder; },
      not() { return builder; },
      select: async () => options.status ?? options.outgoing ?? { data: [{ id: "message-1" }], error: null },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return builder;
  });
  return { admin: { rpc, from } as unknown as SupabaseClient, calls };
}

const base = {
  organizationId: "org-1",
  channelSessionId: "session-1",
};

function envelope(direction: "incoming" | "outgoing", extra: Record<string, unknown> = {}) {
  return {
    event: "message.exchange" as const,
    data: {
      id: "event-1",
      message: {
        id: "message-external-1",
        direction,
        text: "Olá",
        remoteJid: "5511999999999@c.us",
        ...extra,
      },
    },
  };
}

describe("Ryze ingestão F4", () => {
  it("insere incoming, marca conversa e aciona efeitos uma vez", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake();
    const result = await ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") });

    expect(result).toEqual({ status: "ingested", conversationId: "conversation-1", messageId: "message-1" });
    expect(calls.filter((call) => call.op === "fn_upsert_wa_contact")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "fn_upsert_wa_conversation")).toHaveLength(1);
    expect(calls.filter((call) => call.op === "fn_mark_conversation_message")).toHaveLength(1);
    expect(efeitos.aplicar).toHaveBeenCalledTimes(1);
  });

  it("trata 23505 como duplicate e não aciona efeitos", async () => {
    efeitos.aplicar.mockClear();
    const { admin } = adminFake({ insert: { data: null, error: { code: "23505", message: "duplicate" } } });
    const result = await ingestRyzeInbound(admin, { ...base, envelope: envelope("incoming") });

    expect(result).toEqual({ status: "duplicate", conversationId: "conversation-1" });
    expect(efeitos.aplicar).not.toHaveBeenCalled();
  });

  it("outgoing reconcilia mensagem existente sem criar contato, conversa ou IA", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake({ outgoing: { data: [{ id: "message-1" }], error: null } });
    const result = await ingestRyzeInbound(admin, { ...base, envelope: envelope("outgoing", { status: "sent" }) });

    expect(result).toEqual({ status: "reconciled", messageId: "message-1" });
    expect(calls.some((call) => call.op === "fn_upsert_wa_contact")).toBe(false);
    expect(calls.some((call) => call.op === "fn_upsert_wa_conversation")).toBe(false);
    expect(efeitos.aplicar).not.toHaveBeenCalled();
  });

  it("status atualiza somente mensagem existente e ignora mensagem desconhecida", async () => {
    efeitos.aplicar.mockClear();
    const { admin, calls } = adminFake({ status: { data: [], error: null } });
    const result = await ingestRyzeInbound(admin, {
      ...base,
      envelope: {
        event: "message.status",
        data: { id: "delivery-1", message: { id: "message-external-1", status: "read" } },
      },
    });

    expect(result).toEqual({ status: "ignored", reason: "mensagem_desconhecida" });
    expect(calls.some((call) => call.op === "insert")).toBe(false);
    expect(calls.some((call) => call.op === "fn_upsert_wa_contact")).toBe(false);
    expect(efeitos.aplicar).not.toHaveBeenCalled();
  });
});
