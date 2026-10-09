import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const enviarPushAQuemVeAConversaMock = vi.fn(
  async (
    _organizationId: string,
    _conversationId: string,
    _payload: PushPayload,
    _soUsuarios?: ReadonlyArray<string>,
  ) => ({ sent: 1, gone: 0 }),
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
  // Referências indiretas de propósito: o factory do `vi.mock` é hoisted
  // acima das declarações `const` deste arquivo, então gravar o mock
  // diretamente como valor (`enviarPushDaOrg: enviarPushDaOrgMock`) estoura
  // "Cannot access before initialization". Fechos lazy (chamados só quando o
  // handler de fato invoca) resolvem — mesmo padrão de
  // `tests/unit/media-persist-worker.test.ts`.
  enviarPushDaOrg: (organizationId: string, payload: PushPayload) => enviarPushDaOrgMock(organizationId, payload),
  enviarPushAoUsuario: (organizationId: string, userId: string | null, payload: PushPayload) =>
    enviarPushAoUsuarioMock(organizationId, userId, payload),
  enviarPushAQuemVeAConversa: (
    organizationId: string,
    conversationId: string,
    payload: PushPayload,
    soUsuarios?: ReadonlyArray<string>,
  ) => enviarPushAQuemVeAConversaMock(organizationId, conversationId, payload, soUsuarios),
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
    enviarPushAQuemVeAConversaMock.mockClear();
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

  describe("mensagem recebida (message.received) — só a quem pode ver a conversa", () => {
    beforeEach(() => {
      state.vapidPronto = true;
    });

    function inboundRow(payload: Record<string, unknown> = {}) {
      return {
        id: "e-1a1",
        organization_id: "org1",
        event_type: "message.received",
        entity_kind: "message",
        entity_id: "m-1a1",
        payload: { conversation_id: "conv-de-a", body_preview: "oi", type: "text", ...payload },
        metadata: {},
        consumed_by: [],
        attempts: 0,
      };
    }

    it("envia pelas inscrições que veem a conversa, nunca pela organização inteira", async () => {
      const result = await webPushInboundHandler.handle(inboundRow());

      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).toHaveBeenCalledTimes(1);
      const [orgId, conversationId] = enviarPushAQuemVeAConversaMock.mock.calls[0]!;
      expect(orgId).toBe("org1");
      expect(conversationId).toBe("conv-de-a");
    });

    it("sem conversation_id não envia a ninguém", async () => {
      const result = await webPushInboundHandler.handle(inboundRow({ conversation_id: undefined }));

      expect(result).toMatchObject({ status: "skipped", detail: "sem_conversa" });
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).not.toHaveBeenCalled();
    });
  });

  describe("grupo (message.group_received) — nunca a cópia do 1:1", () => {
    beforeEach(() => {
      state.vapidPronto = true;
    });

    it("título é a cópia de grupo, href aponta pra conversa, envia só a quem vê a conversa", async () => {
      const result = await webPushInboundHandler.handle(grupoRow());

      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).toHaveBeenCalledTimes(1);
      const [orgId, conversationId, payload, soUsuarios] = enviarPushAQuemVeAConversaMock.mock.calls[0]!;
      expect(orgId).toBe("org1");
      expect(conversationId).toBe("conv-1");
      // Grupo não tem regra própria de destinatário: o recorte é só a visibilidade.
      expect(soUsuarios).toBeUndefined();
      expect(payload).toMatchObject({
        title: "Nova mensagem no grupo",
        href: "/app/inbox?id=conv-1",
      });
      // Nunca o desfecho do 1:1 ("Nova mensagem" quando não há nome de contato).
      expect(payload.title).not.toBe("Nova mensagem");
      expect(enviarPushAoUsuarioMock).not.toHaveBeenCalled();
    });

    it("não busca nome/avatar do contato — `contacts` nunca é lido", async () => {
      await webPushInboundHandler.handle(grupoRow());
      expect(fromMock).not.toHaveBeenCalledWith("contacts");
    });

    it("sem conversation_id não envia a ninguém (mesma régua do 1:1)", async () => {
      const result = await webPushInboundHandler.handle(grupoRow({ conversation_id: undefined }));
      expect(result).toMatchObject({ status: "skipped", detail: "sem_conversa" });
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).not.toHaveBeenCalled();
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

    it("conversa sem responsável → todos os que podem ver a conversa", async () => {
      carregarDestinatariosMock.mockResolvedValueOnce({ tipo: "todos" });
      const result = await webPushInboundHandler.handle(inboundRow());
      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).toHaveBeenCalledTimes(1);
      expect(enviarPushAQuemVeAConversaMock.mock.calls[0]![3]).toBeUndefined();
    });

    it("conversa com responsável → push SÓ para a lista decidida (responsável + admins)", async () => {
      carregarDestinatariosMock.mockResolvedValueOnce({ tipo: "restrito", userIds: ["u-ana", "u-admin"] });
      const result = await webPushInboundHandler.handle(inboundRow());
      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).toHaveBeenCalledTimes(1);
      const [orgId, conversationId, payload, userIds] = enviarPushAQuemVeAConversaMock.mock.calls[0]!;
      expect(orgId).toBe("org1");
      expect(conversationId).toBe("conv-1");
      expect(userIds).toEqual(["u-ana", "u-admin"]);
      expect(payload).toMatchObject({ body: "oi" });
      // A decisão é pedida para a conversa e a org DO EVENTO.
      expect(carregarDestinatariosMock.mock.calls[0]!.slice(1)).toEqual(["org1", "conv-1", null]);
    });

    it("falha ao decidir → cai para todos os que podem ver (aviso a mais incomoda; a menos perde cliente)", async () => {
      carregarDestinatariosMock.mockRejectedValueOnce(new Error("banco fora"));
      const result = await webPushInboundHandler.handle(inboundRow());
      expect(result.status).toBe("ok");
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock.mock.calls[0]![3]).toBeUndefined();
    });

    it("conversa não encontrada (null) → todos os que podem ver; evento sem conversa → ninguém", async () => {
      carregarDestinatariosMock.mockResolvedValueOnce(null);
      await webPushInboundHandler.handle(inboundRow());
      await webPushInboundHandler.handle(inboundRow({ conversation_id: undefined }));
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).toHaveBeenCalledTimes(1);
      // Sem conversa nem há o que perguntar.
      expect(carregarDestinatariosMock).toHaveBeenCalledTimes(1);
    });

    it("grupo NÃO passa pela regra de responsável — só pela de visibilidade", async () => {
      await webPushInboundHandler.handle(grupoRow());
      expect(carregarDestinatariosMock).not.toHaveBeenCalled();
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock.mock.calls[0]![3]).toBeUndefined();
    });
  });

  // A régua de quem vê é `fn_push_inscricoes_que_veem_a_conversa` (invariante
  // `push-so-a-quem-ve-a-conversa`: em 'own', o agent não vê a conversa sem dono).
  // Aqui o mock responde por ela: só QUEM_VE tem inscrição que vê a conversa.
  describe("menção (user.mentioned) — só se o mencionado pode ver a conversa", () => {
    const QUEM_VE = "user-que-ve";
    beforeEach(() => {
      state.vapidPronto = true;
      enviarPushAQuemVeAConversaMock.mockImplementation(async (_org, _conv, _payload, soUsuarios) => ({
        sent: (soUsuarios ?? []).filter((u) => u === QUEM_VE).length,
        gone: 0,
      }));
    });
    afterEach(() => {
      enviarPushAQuemVeAConversaMock.mockImplementation(async () => ({ sent: 1, gone: 0 }));
    });

    function mencaoRow(payload: Record<string, unknown> = {}) {
      return {
        id: "e-mencao",
        organization_id: "org1",
        event_type: "user.mentioned",
        entity_kind: "conversation_note",
        entity_id: "conv-1",
        payload: { conversation_id: "conv-1", from_user_id: "autor", body_preview: "dados do cliente", ...payload },
        metadata: {},
        consumed_by: [],
        attempts: 0,
      };
    }

    it("mencionado que NÃO vê a conversa: nenhum aviso, nem sem prévia", async () => {
      const result = await webPushInboundHandler.handle(mencaoRow({ to_user_id: "user-que-nao-ve" }));
      expect(result.detail).toBe("sent:0");
      expect(enviarPushAoUsuarioMock).not.toHaveBeenCalled();
      expect(enviarPushDaOrgMock).not.toHaveBeenCalled();
      const [org, conv, , soUsuarios] = enviarPushAQuemVeAConversaMock.mock.calls[0]!;
      expect([org, conv, soUsuarios]).toEqual(["org1", "conv-1", ["user-que-nao-ve"]]);
    });

    it("mencionado que vê a conversa: recebe o aviso com a prévia", async () => {
      const result = await webPushInboundHandler.handle(mencaoRow({ to_user_id: QUEM_VE }));
      expect(result.detail).toBe("sent:1");
      const payload = enviarPushAQuemVeAConversaMock.mock.calls[0]![2];
      expect(payload.title).toBe("Você foi mencionado");
      expect(payload.body).toBe("dados do cliente");
    });

    it("sem conversa não há como conferir: ninguém recebe", async () => {
      const result = await webPushInboundHandler.handle(mencaoRow({ to_user_id: QUEM_VE, conversation_id: undefined }));
      expect(result.status).toBe("skipped");
      expect(enviarPushAoUsuarioMock).not.toHaveBeenCalled();
      expect(enviarPushAQuemVeAConversaMock).not.toHaveBeenCalled();
    });
  });
});
