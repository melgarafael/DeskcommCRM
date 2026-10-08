import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushPayload } from "./push_payload";

// `state.vapidPronto` é mutável de propósito: os testes de grupo abaixo
// precisam de VAPID "pronto" (senão o handler nem chega na ramificação), e o
// teste original precisa dele "ausente" — um só `vi.mock` por módulo por
// arquivo, então a alternância é por flag, não por uma segunda chamada.
const state = { vapidPronto: false };
vi.mock("@/lib/notifications/vapid", () => ({
  vapidPronto: () => state.vapidPronto,
}));

const enviarPushDaOrgMock = vi.fn(async (_organizationId: string, _payload: PushPayload) => ({ sent: 1, gone: 0 }));
const enviarPushAoUsuarioMock = vi.fn(
  async (_organizationId: string, _userId: string | null, _payload: PushPayload) => ({ sent: 0, gone: 0 }),
);
const enviarPushAosUsuariosMock = vi.fn(
  async (_organizationId: string, _userIds: ReadonlyArray<string>, _payload: PushPayload) => ({ sent: 2, gone: 0 }),
);
// A decisão de destinatários tem suíte própria (`destinatarios-da-mensagem.test.ts`);
// aqui só interessa que o handler OBEDEÇA ao que ela decidir.
const carregarDestinatariosMock = vi.fn(
  async (..._args: unknown[]): Promise<{ tipo: "todos" } | { tipo: "restrito"; userIds: string[] } | null> => ({
    tipo: "todos",
  }),
);
vi.mock("./destinatarios-da-mensagem", () => ({
  carregarDestinatariosDaMensagem: (...args: unknown[]) => carregarDestinatariosMock(...args),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca" }),
}));
vi.mock("./web_push", () => ({
  enviarPushAosUsuarios: (organizationId: string, userIds: ReadonlyArray<string>, payload: PushPayload) =>
    enviarPushAosUsuariosMock(organizationId, userIds, payload),
  // Referências indiretas de propósito: o factory do `vi.mock` é hoisted
  // acima das declarações `const` deste arquivo, então gravar o mock
  // diretamente como valor (`enviarPushDaOrg: enviarPushDaOrgMock`) estoura
  // "Cannot access before initialization". Fechos lazy (chamados só quando o
  // handler de fato invoca) resolvem — mesmo padrão de
  // `tests/unit/media-persist-worker.test.ts`.
  enviarPushDaOrg: (organizationId: string, payload: PushPayload) => enviarPushDaOrgMock(organizationId, payload),
  enviarPushAoUsuario: (organizationId: string, userId: string | null, payload: PushPayload) =>
    enviarPushAoUsuarioMock(organizationId, userId, payload),
}));

// A rota 1:1 (`handleInbound`) usa o admin client para buscar nome/avatar em
// `contacts`. A rota de grupo NUNCA deveria — é exatamente o que os testes
// abaixo travam. O client em si a rota de grupo pede (a régua do canal
// desativado, #2329, lê `channel_sessions`), então a trava é `from("contacts")`,
// não `createAdminClient`.
const fromMock = vi.fn();
const createAdminClientMock = vi.fn(() => ({ from: fromMock }) as unknown);
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { webPushInboundHandler } from "./push.handler";

function grupoRow(payload: Record<string, unknown> = {}) {
  return {
    id: "e-grupo",
    organization_id: "org1",
    event_type: "message.group_received",
    entity_kind: "message",
    entity_id: "m-grupo",
    payload: { conversation_id: "conv-1", contact_id: "contato-placeholder-grupo", body_preview: "bom dia, grupo", type: "text", ...payload },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

describe("webPushInboundHandler", () => {
  beforeEach(() => {
    state.vapidPronto = false;
    enviarPushDaOrgMock.mockClear();
    enviarPushAoUsuarioMock.mockClear();
    enviarPushAosUsuariosMock.mockClear();
    carregarDestinatariosMock.mockClear();
    createAdminClientMock.mockClear();
    fromMock.mockClear();
  });

  it("pula quando VAPID não está configurado", async () => {
    const result = await webPushInboundHandler.handle({
      id: "e1",
      organization_id: "org",
      event_type: "message.received",
      entity_kind: "message",
      entity_id: "m1",
      payload: { conversation_id: "c1", body_preview: "oi", type: "text" },
      metadata: {},
      consumed_by: [],
      attempts: 0,
    });
    expect(result.status).toBe("skipped");
    expect(result.detail).toBe("vapid_ausente");
  });

  describe("grupo (message.group_received) — nunca a cópia do 1:1", () => {
    beforeEach(() => {
      state.vapidPronto = true;
    });

    it("título é a cópia de grupo, href aponta pra conversa, envia pela ORG (não por usuário)", async () => {
      const result = await webPushInboundHandler.handle(grupoRow());

      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).toHaveBeenCalledTimes(1);
      const [orgId, payload] = enviarPushDaOrgMock.mock.calls[0]!;
      expect(orgId).toBe("org1");
      expect(payload).toMatchObject({
        title: "Nova mensagem no grupo",
        href: "/app/inbox?id=conv-1",
      });
      // Nunca o desfecho do 1:1 ("Nova mensagem" quando não há nome de contato).
      expect(payload.title).not.toBe("Nova mensagem");
      // Recipiente é a ORG inteira — nunca `enviarPushAoUsuario` (que é o
      // caminho de lead.assigned/user.mentioned, dirigido a UM usuário).
      expect(enviarPushAoUsuarioMock).not.toHaveBeenCalled();
    });

    it("não busca nome/avatar do contato — `contacts` nunca é lido", async () => {
      await webPushInboundHandler.handle(grupoRow());
      expect(fromMock).not.toHaveBeenCalledWith("contacts");
    });

    it("sem conversation_id: href cai para /app/inbox (mesma forma do 1:1 sem conversa)", async () => {
      await webPushInboundHandler.handle(grupoRow({ conversation_id: undefined }));
      const [, payload] = enviarPushDaOrgMock.mock.calls[0]!;
      expect(payload).toMatchObject({ title: "Nova mensagem no grupo", href: "/app/inbox" });
    });
  });
  describe("mensagem recebida (message.received) — responsável + admins, ou todos", () => {
    // Sem `contact_id` o handler não busca nome/avatar: o foco aqui é o destino.
    function inboundRow(payload: Record<string, unknown> = {}) {
      return {
        id: "e-in",
        organization_id: "org1",
        event_type: "message.received",
        entity_kind: "message",
        entity_id: "m-in",
        payload: { conversation_id: "conv-1", body_preview: "oi", type: "text", ...payload },
        metadata: {},
        consumed_by: [],
        attempts: 0,
      };
    }

    beforeEach(() => {
      state.vapidPronto = true;
    });

    it("conversa sem responsável → push para a organização inteira (como antes)", async () => {
      carregarDestinatariosMock.mockResolvedValueOnce({ tipo: "todos" });
      const result = await webPushInboundHandler.handle(inboundRow());
      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).toHaveBeenCalledTimes(1);
      expect(enviarPushAosUsuariosMock).not.toHaveBeenCalled();
    });

    it("conversa com responsável → push SÓ para a lista decidida (responsável + admins)", async () => {
      carregarDestinatariosMock.mockResolvedValueOnce({ tipo: "restrito", userIds: ["u-ana", "u-admin"] });
      const result = await webPushInboundHandler.handle(inboundRow());
      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAosUsuariosMock).toHaveBeenCalledTimes(1);
      const [orgId, userIds, payload] = enviarPushAosUsuariosMock.mock.calls[0]!;
      expect(orgId).toBe("org1");
      expect(userIds).toEqual(["u-ana", "u-admin"]);
      expect(payload).toMatchObject({ body: "oi" });
      // A decisão é pedida para a conversa e a org DO EVENTO.
      expect(carregarDestinatariosMock.mock.calls[0]!.slice(1)).toEqual(["org1", "conv-1", null]);
    });

    it("falha ao decidir → cai para todos (aviso a mais incomoda; a menos perde cliente)", async () => {
      carregarDestinatariosMock.mockRejectedValueOnce(new Error("banco fora"));
      const result = await webPushInboundHandler.handle(inboundRow());
      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).toHaveBeenCalledTimes(1);
      expect(enviarPushAosUsuariosMock).not.toHaveBeenCalled();
    });

    it("conversa não encontrada (null) ou evento sem conversa → todos", async () => {
      carregarDestinatariosMock.mockResolvedValueOnce(null);
      await webPushInboundHandler.handle(inboundRow());
      await webPushInboundHandler.handle(inboundRow({ conversation_id: undefined }));
      expect(enviarPushDaOrgMock).toHaveBeenCalledTimes(2);
      // Sem conversa nem há o que perguntar.
      expect(carregarDestinatariosMock).toHaveBeenCalledTimes(1);
    });

    it("grupo NÃO passa pela regra — continua indo para a organização", async () => {
      await webPushInboundHandler.handle(grupoRow());
      expect(carregarDestinatariosMock).not.toHaveBeenCalled();
      expect(enviarPushDaOrgMock).toHaveBeenCalledTimes(1);
    });
  });
});
