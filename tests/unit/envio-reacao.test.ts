import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const conv = "33333333-3333-4333-8333-333333333333";
const session = "44444444-4444-4444-8444-444444444444";
const sendReaction = vi.fn(async () => ({ externalId: "reaction-1" }));
const writes: unknown[] = [];
let provider = "waha";
const contatoPadrao = { phone_number: "123", wa_identity: null, wa_lid: null, is_blocked: false, is_personal: false };
let contato: Record<string, unknown> = contatoPadrao;
let conversa: Record<string, unknown> = { id: conv, contact_id: "contact", channel_session_id: session, is_group: false, group_chat_id: null };
const audit = vi.hoisted(() => vi.fn(async (_entry: unknown) => undefined));
const resolveRecipient = vi.fn((_input: unknown) => "123@c.us");
const message = { id, organization_id: org, conversation_id: conv, channel_session_id: session, contact_id: "contact", external_id: "false_123@c.us_ABC", type: "text", revoked_at: null };
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(async () => ({ ok: true, user: { id: "user", idioma: "pt-BR" }, org: { orgId: org } })) }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/channels", () => ({ CHANNEL_SESSION_REF_COLUMNS: "id,provider", transportaMensagem: () => true, resolveSessionRef: () => "default", getAdapter: () => ({ sendReaction, isConfigured: () => true, resolveRecipient }) }));
vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({ enderecoDaUltimaRecebida: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (table: string) => {
  const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === "messages" ? message : table === "conversations" ? conversa : table === "channel_sessions" ? { id: session, provider, archived_at: null } : contato, error: null }), insert: async (payload: unknown) => { writes.push(payload); return { error: null }; } }; return q;
} }) }));
import { POST } from "@/app/api/v1/messages/[id]/reactions/route";
const request = (emoji: string) => new NextRequest(`https://crm.test/api/v1/messages/${id}/reaction`, { method: "POST", body: JSON.stringify({ emoji }) });
const ctx = { params: Promise.resolve({ id }) };
describe("envio de reação", () => {
  it.each(["waha", "meta_cloud"])("envia no adapter %s e grava reação ligada sem carimbar conversa", async (channel) => {
    provider = channel; writes.length = 0; sendReaction.mockClear();
    const response = await POST(request("👍"), ctx);
    expect(response.status).toBe(200);
    expect(sendReaction).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, externalId: message.external_id, emoji: "👍" }));
    expect(writes).toEqual([expect.objectContaining({ type: "reaction", direction: "outbound", reply_to_message_id: id, external_id: "reaction-1", metadata: { reaction: expect.objectContaining({ emoji: "👍", target_external_id: message.external_id }) } })]);
  });
  it("recusa entrada que não é emoji antes de enviar", async () => {
    sendReaction.mockClear(); writes.length = 0;
    for (const emoji of ["", "hello", "👍texto", "👍\n", "👍👍"]) {
      expect((await POST(request(emoji), ctx)).status).toBe(422);
    }
    expect(sendReaction).not.toHaveBeenCalled(); expect(writes).toHaveLength(0);
  });
  it("WAHA confirma o envio sem inserir linha: o webhook registra o eco", async () => {
    provider = "waha"; writes.length = 0;
    sendReaction.mockResolvedValueOnce({ externalId: null as unknown as string });
    const response = await POST(request("👩🏽‍💻"), ctx);
    expect(response.status).toBe(200);
    expect(sendReaction).toHaveBeenCalledWith(expect.objectContaining({ emoji: "👩🏽‍💻" }));
    expect(writes).toHaveLength(0);
  });
  it("não grava se o transporte falhar", async () => {
    sendReaction.mockRejectedValueOnce(new Error("transport failed")); writes.length = 0; audit.mockClear();
    expect((await POST(request("👍"), ctx)).status).toBe(502);
    expect(writes).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
  it("audita a reação enviada", async () => {
    provider = "waha"; audit.mockClear();
    expect((await POST(request("👍"), ctx)).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.reaction_sent", organizationId: org, resourceId: id }));
  });
  it.each([
    ["bloqueou o atendimento (opt-out)", { is_blocked: true }, "Contato bloqueou o atendimento."],
    ["é pessoal", { is_personal: true }, "Contato marcado como pessoal."],
  ])("não reage a contato que %s", async (_caso, extra, mensagem) => {
    contato = { ...contatoPadrao, ...extra }; sendReaction.mockClear(); writes.length = 0; audit.mockClear();
    const response = await POST(request("👍"), ctx);
    contato = contatoPadrao;
    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual(expect.objectContaining({ code: "forbidden", message: mensagem }));
    expect(sendReaction).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
  it("destinatário indisponível vira 409, não 502", async () => {
    sendReaction.mockRejectedValueOnce(new Error("recipient_unavailable"));
    const response = await POST(request("👍"), ctx);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("recipient_unavailable");
  });
  it("conversa de grupo passa o chat do grupo ao canal", async () => {
    conversa = { ...conversa, is_group: true, group_chat_id: "120363000000000000@g.us" }; resolveRecipient.mockClear();
    const response = await POST(request("👍"), ctx);
    conversa = { ...conversa, is_group: false, group_chat_id: null };
    expect(response.status).toBe(200);
    expect(resolveRecipient).toHaveBeenCalledWith(expect.objectContaining({ isGroup: true, groupChatId: "120363000000000000@g.us" }));
  });
});
