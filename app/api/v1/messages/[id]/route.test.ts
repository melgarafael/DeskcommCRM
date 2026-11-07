import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  message: null as Record<string, unknown> | null,
  calls: [] as Array<{ table: string; update?: Record<string, unknown> }>,
  edit: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  /** Provider da sessão da conversa (a decisão do endereço não depende dele aqui). */
  provider: "canal-teste" as string,
  /** Endereço da última mensagem recebida, que o módulo de canal devolve no caso de telefone extra. */
  chat: null as string | null,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "usuario-1", idioma: "pt-BR" }, org: { orgId: "org-1" } }),
}));
vi.mock("@/lib/audit", () => ({ audit: state.audit }));
vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({
  enderecoDaUltimaRecebida: async () => state.chat,
}));
vi.mock("@/lib/channels", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transportaMensagem: () => true,
  resolveSessionRef: () => "numero-1",
  getAdapter: () => ({
    isConfigured: () => true,
    // Devolve o endereço da última recebida quando a rota a passa; senão o de sempre.
    resolveRecipient: (entrada: { ultimoRecebidoChatId?: string | null }) => entrada.ultimoRecebidoChatId ?? "chat-1",
    editMessage: state.edit,
    revokeMessage: state.remove,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
        update: (update: Record<string, unknown>) => { state.calls.push({ table, update }); return q; },
        // `await` direto (update sem leitura de volta).
        then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(ok, falha),
        maybeSingle: async () => ({ data: table === "messages"
          ? state.calls.some((c) => c.table === "messages" && c.update)
            ? { id: state.message?.id, body: state.message?.body, edited_at: "agora", revoked_at: null }
            : state.message
          : table === "conversations"
            ? { id: "conversa-1", contact_id: "contato-1", is_group: false, channel_session_id: "sessao-1" }
            : table === "channel_sessions"
              ? { provider: state.provider, archived_at: null }
              : { phone_number: "5511999999999", wa_identity: null, wa_lid: null }, error: null }),
      };
      return q;
    },
  }),
}));

import { DELETE, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };
const url = `http://localhost/api/v1/messages/${id}`;

beforeEach(() => {
  state.calls.length = 0;
  state.edit.mockClear();
  state.remove.mockClear();
  state.audit.mockClear();
  state.provider = "canal-teste";
  state.chat = null;
  state.message = {
    id, organization_id: "org-1", conversation_id: "conversa-1", channel_session_id: "sessao-1",
    external_id: "ABC", direction: "outbound", type: "text", status: "sent",
    body: "antes", sent_via: "user", sent_by_user_id: "usuario-1",
    sent_at: new Date().toISOString(), revoked_at: null,
  };
});

describe("alterar mensagem enviada", () => {
  it("rejeita mensagem recebida antes de chamar o canal", async () => {
    state.message = { ...state.message, direction: "inbound" };
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
    expect(res.status).toBe(403);
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("edita só mensagem própria pelo adaptador do canal, e audita", async () => {
    const res = await PATCH(new NextRequest(url, {
      method: "PATCH", body: JSON.stringify({ text: "depois" }),
    }), ctx);
    expect(res.status).toBe(200);
    expect(state.edit).toHaveBeenCalledWith({
      organizationId: "org-1", sessionRef: "numero-1", recipient: "chat-1", externalId: "ABC", text: "depois",
    });
    expect(state.calls).toContainEqual({ table: "messages", update: expect.objectContaining({ body: "depois" }) });
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.edited", resourceId: id }));
  });

  it("a trilha do apagamento guarda o EVENTO — e nunca o corpo", async () => {
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "message.revoked",
      resourceId: id,
      metadata: expect.objectContaining({
        conversation_id: "conversa-1",
        direction: "outbound",
        external_id: "ABC",
        conteudo_preservado: true,
      }),
    }));
    // `api_audit_log` é append-only, com retenção de 5 anos, e sobrevive ao
    // apagamento da organização: o corpo da mensagem NÃO entra na trilha, senão
    // vira dado pessoal fora do alcance da cascata de anonimização.
    expect(JSON.stringify(state.audit.mock.calls)).not.toContain("antes");
  });

  it("não marca como apagada quando o canal recusa", async () => {
    state.remove.mockRejectedValueOnce(new Error("recusado_403"));
    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx);
    expect(res.status).toBe(502);
    expect(state.calls).toEqual([]);
    expect(state.audit).not.toHaveBeenCalled();
  });
});

describe("alterar mensagem — ficha com telefone extra (Spec 31 B1)", () => {
  it("com a ficha de telefone extra, a edição vai para o número que a pessoa escreveu", async () => {
    state.chat = "5531988887777@c.us";
    const res = await PATCH(new NextRequest(url, {
      method: "PATCH", body: JSON.stringify({ text: "depois" }),
    }), ctx);
    expect(res.status).toBe(200);
    expect(state.edit).toHaveBeenCalledWith(expect.objectContaining({ recipient: "5531988887777@c.us" }));
    // Sabotagem: não passar `ultimoRecebidoChatId` à rota deixa o endereço em "chat-1"
    // (o de sempre), e este teste fica vermelho.
  });
});
