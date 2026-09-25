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
}));

// A rota 1:1 (`handleInbound`) usa `createAdminClient` para buscar
// nome/avatar do contato. A rota de grupo NUNCA deveria — é exatamente o que
// os testes abaixo travam.
const createAdminClientMock = vi.fn(() => ({}) as unknown);
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
    createAdminClientMock.mockClear();
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

    it("não busca nome/avatar do contato — a rota 1:1 (createAdminClient) nunca é chamada", async () => {
      await webPushInboundHandler.handle(grupoRow());
      expect(createAdminClientMock).not.toHaveBeenCalled();
    });

    it("sem conversation_id: href cai para /app/inbox (mesma forma do 1:1 sem conversa)", async () => {
      await webPushInboundHandler.handle(grupoRow({ conversation_id: undefined }));
      const [, payload] = enviarPushDaOrgMock.mock.calls[0]!;
      expect(payload).toMatchObject({ title: "Nova mensagem no grupo", href: "/app/inbox" });
    });
  });
});
