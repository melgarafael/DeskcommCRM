/**
 * `crm_get_conversation_history` devolve, para mensagens com mídia, um link temporário do arquivo
 * guardado (e o estado: ready / pending). Quem consome pela API (ex.: um sistema externo que
 * transcreve áudio) não consegue usar o `media_url` interno do gateway.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSignedUrl = vi.fn();
const from = vi.fn(() => ({ createSignedUrl }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ storage: { from } })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ listMessagesHandler: vi.fn() }));
vi.mock("@/app/api/v1/conversations/_handler", () => ({
  getConversationHandler: vi.fn(),
  listConversationsHandler: vi.fn(),
}));

import { getConversationHandler } from "@/app/api/v1/conversations/_handler";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import { createAdminClient } from "@/lib/supabase/admin";
import type { McpContext } from "@/lib/mcp/types";

import { VALIDADE_DO_LINK_DE_MIDIA_S } from "@/lib/messaging/media/link-temporario";

import { crmGetConversationHistory, resolverMidiasDoHistorico } from "./conversations";

const mockedList = vi.mocked(listMessagesHandler);
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const ctx = {
  organizationId: "org",
  role: "agent",
  actor: { type: "api_token", id: "tok" },
  requestId: "req",
  supabase: {},
} as unknown as McpContext;

const msg = (o: Record<string, unknown>) => ({
  id: "m",
  direction: "inbound",
  type: "text",
  body: null,
  media_url: null,
  media_mime: null,
  media_size_bytes: null,
  media_storage_path: null,
  sent_via: null,
  sent_at: "2026-09-30T12:00:00Z",
  status: "delivered",
  ...o,
});

beforeEach(() => {
  createSignedUrl.mockReset();
  from.mockClear();
  vi.mocked(createAdminClient).mockClear();
  mockedList.mockReset();
});

describe("resolverMidiasDoHistorico", () => {
  it("não toca no storage quando nenhuma mensagem tem mídia", async () => {
    const r = await resolverMidiasDoHistorico([msg({ id: "a", body: "oi" })]);
    expect(r.size).toBe(0);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("mídia guardada vira ready com o link; ainda não guardada vira pending", async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://s/x?token=1" }, error: null });
    const r = await resolverMidiasDoHistorico([
      msg({
        id: "audio",
        media_storage_path: "org/conv/a.ogg",
        media_url: "https://gateway.exemplo/a",
      }),
      msg({ id: "novo", media_url: "https://gateway.exemplo/b" }),
      msg({ id: "texto", body: "oi" }),
    ]);
    expect(r.get("audio")).toEqual({ status: "ready", signedUrl: "https://s/x?token=1" });
    expect(r.get("novo")).toEqual({ status: "pending", signedUrl: null });
    expect(r.has("texto")).toBe(false);
    expect(from).toHaveBeenCalledWith("whatsapp-media");
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledWith("org/conv/a.ogg", VALIDADE_DO_LINK_DE_MIDIA_S);
  });

  it("falha ao assinar nunca derruba o histórico: vira pending", async () => {
    createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    createSignedUrl.mockRejectedValueOnce(new Error("rede"));
    createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: "" }, error: null });
    const r = await resolverMidiasDoHistorico([
      msg({ id: "a", media_storage_path: "p/a" }),
      msg({ id: "b", media_storage_path: "p/b" }),
      msg({ id: "c", media_storage_path: "p/c" }),
    ]);
    for (const id of ["a", "b", "c"])
      expect(r.get(id)).toEqual({ status: "pending", signedUrl: null });
  });

  it("mídia apagada pela retenção sai expired, sem tocar no storage (a mesma régua do 410 da rota)", async () => {
    const r = await resolverMidiasDoHistorico([
      msg({
        id: "podada",
        type: "audio",
        metadata: { media_status: "expired", media_retention_days: 90 },
      }),
      msg({ id: "texto", body: "oi", metadata: {} }),
    ]);
    expect(r.get("podada")).toEqual({ status: "expired", signedUrl: null });
    expect(r.has("texto")).toBe(false);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("sem link: guardada vira ready sem assinar nada", async () => {
    const r = await resolverMidiasDoHistorico([msg({ id: "audio", media_storage_path: "p/a" })], {
      comLink: false,
    });
    expect(r.get("audio")).toEqual({ status: "ready", signedUrl: null });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("crm_get_conversation_history", () => {
  it("devolve tipo, tamanho, estado e link da mídia, e mantém os campos de sempre", async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://s/y" }, error: null });
    mockedList.mockResolvedValue({
      messages: [
        msg({
          id: "m1",
          type: "audio",
          media_mime: "audio/ogg",
          media_size_bytes: 1234,
          media_storage_path: "p/m1.ogg",
        }),
        msg({ id: "m2", body: "oi" }),
      ],
      cursor: null,
      has_more: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const out = (await crmGetConversationHistory.handler(
      { conversation_id: CONVERSATION_ID, limit: 20 } as never,
      ctx,
    )) as {
      messages: Record<string, unknown>[];
    };
    expect(out.messages[0]).toMatchObject({
      id: "m1",
      type: "audio",
      media_mime: "audio/ogg",
      media_size_bytes: 1234,
      media_status: "ready",
      media_signed_url: "https://s/y",
    });
    expect(out.messages[1]).toMatchObject({
      id: "m2",
      body: "oi",
      media_status: "none",
      media_signed_url: null,
      media_mime: null,
    });
    expect(Object.keys(out.messages[1] ?? {})).toEqual(
      expect.arrayContaining([
        "id",
        "direction",
        "type",
        "body",
        "media_url",
        "sent_via",
        "sent_at",
        "status",
      ]),
    );
  });

  it("no turno do agente de atendimento o link não sai; tipo e estado ficam", async () => {
    const conversa = { contact_id: "c1" };
    vi.mocked(getConversationHandler).mockResolvedValue(conversa as never);
    mockedList.mockResolvedValue({
      messages: [
        msg({ id: "m1", type: "audio", media_mime: "audio/ogg", media_storage_path: "p/m1.ogg" }),
      ],
      cursor: null,
      has_more: false,
    } as never);
    const ctxDoTurno = { ...ctx, contatoDoTurno: "c1" } as McpContext;
    const out = (await crmGetConversationHistory.handler(
      { conversation_id: CONVERSATION_ID, limit: 20 } as never,
      ctxDoTurno,
    )) as {
      messages: Record<string, unknown>[];
    };
    expect(out.messages[0]).toMatchObject({
      id: "m1",
      media_mime: "audio/ogg",
      media_status: "ready",
      media_signed_url: null,
    });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("derivados MCP por permissão explícita", () => {
  const derived = msg({
    id: "derivado",
    type: "audio",
    media_derived_text: "texto sintético",
    media_derived_status: "ready",
  });
  async function history(context: McpContext, message: Record<string, unknown> = derived) {
    mockedList.mockResolvedValue({ messages: [message], cursor: null, has_more: false } as never);
    return (await crmGetConversationHistory.handler(
      { conversation_id: CONVERSATION_ID, limit: 20 } as never,
      context,
    )) as { messages: Record<string, unknown>[] };
  }
  it("token anterior não ganha derivados na atualização", async () => {
    const out = await history(ctx);
    expect(out.messages[0]).not.toHaveProperty("media_derived_text");
    expect(out.messages[0]).not.toHaveProperty("media_derived_status");
  });
  it("permissão explícita retorna texto pronto sem modificar body nem assinar mídia", async () => {
    const out = await history({ ...ctx, tokenScopes: ["mcp:read", "messages:derived:read"] });
    expect(out.messages[0]).toMatchObject({
      body: null,
      media_derived_status: "ready",
      media_derived_text: "texto sintético",
    });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
  it.each(["failed", "pending", null])("estado %s nunca expõe texto parcial", async (status) => {
    const out = await history(
      { ...ctx, tokenScopes: ["messages:derived:read"] },
      { ...derived, media_derived_status: status },
    );
    expect(out.messages[0]).toMatchObject({
      media_derived_text: null,
      media_derived_status: status,
    });
  });
  it("retenção impede conteúdo derivado remanescente", async () => {
    const out = await history(
      { ...ctx, tokenScopes: ["messages:derived:read"] },
      { ...derived, metadata: { media_status: "expired" } },
    );
    expect(out.messages[0]).toMatchObject({ media_derived_text: null, media_derived_status: null });
  });
  it("escopo não substitui identidade autenticada de token", async () => {
    const out = await history({
      ...ctx,
      actor: { type: "user", id: "synthetic" },
      tokenScopes: ["messages:derived:read"],
    });
    expect(out.messages[0]).not.toHaveProperty("media_derived_text");
  });
});
