import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { sincronizarNegocioAbertoDoContato } from "@/lib/inbox/negocio-aberto-do-contato";
import { assumirConversaComEfeitos } from "./assumir-conversa";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => undefined),
}));
vi.mock("@/lib/inbox/negocio-aberto-do-contato", () => ({
  sincronizarNegocioAbertoDoContato: vi.fn(async () => ({
    gravou: true,
    motivo: "sincronizado",
    abertos: 1,
    leadId: "negocio",
  })),
}));

const entrada = {
  organizationId: "org-a",
  conversationId: "conversa-a",
  actor: { type: "user" as const, id: "atendente-a", role: "agent" },
  requestId: "requisicao",
};
const conversa = {
  id: "conversa-a",
  organization_id: "org-a",
  contact_id: "contato-a",
  assigned_to_user_id: "atendente-a",
};

function banco(resultados: Array<{ data: unknown; error: { message: string } | null }>) {
  const rpc = vi.fn(async (nome: string, _params: unknown) =>
    nome === "fn_conversation_assign" ? resultados.shift()! : { data: null, error: null },
  );
  return { cliente: { rpc } as unknown as SupabaseClient, rpc };
}

beforeEach(() => vi.clearAllMocks());

describe("assumir compartilha os efeitos canônicos", () => {
  it("abertura vencedora e claim posterior sem linhas deixam os efeitos uma única vez", async () => {
    const { cliente, rpc } = banco([
      { data: [conversa], error: null },
      { data: [], error: null },
    ]);
    expect((await assumirConversaComEfeitos(cliente, entrada)).conversation).toEqual(conversa);
    expect((await assumirConversaComEfeitos(cliente, entrada)).conversation).toBeNull();
    expect(sincronizarNegocioAbertoDoContato).toHaveBeenCalledExactlyOnceWith(cliente, {
      organizationId: "org-a",
      contactId: "contato-a",
      toUserId: "atendente-a",
      soSemResponsavel: true,
    });
    expect(audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "conversation.claimed",
        actorUserId: "atendente-a",
        organizationId: "org-a",
        resourceId: "conversa-a",
        metadata: { negocio_aberto: "sincronizado", negocio_id: "negocio" },
      }),
    );
    expect(registrarTrocaDeComando).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        supabase: cliente,
        organizationId: "org-a",
        conversationId: "conversa-a",
        contactId: "contato-a",
        actor: entrada.actor,
      }),
    );
    expect(rpc.mock.calls.filter(([nome]) => nome === "emit_event")).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_organization_id: "org-a", p_entity_id: "conversa-a" }),
    );
  });

  it.each([
    { data: [], error: null },
    { data: null, error: { message: "recusado" } },
  ])("recusa/zero linhas não emite efeitos ($error)", async (resultado) => {
    const { cliente, rpc } = banco([resultado]);
    expect(await assumirConversaComEfeitos(cliente, entrada)).toEqual({
      conversation: null,
      error: resultado.error,
    });
    expect(audit).not.toHaveBeenCalled();
    expect(registrarTrocaDeComando).not.toHaveBeenCalled();
    expect(sincronizarNegocioAbertoDoContato).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("takeover consciente conserva expected e CAS da rota canônica", async () => {
    const { cliente, rpc } = banco([{ data: [conversa], error: null }]);
    await assumirConversaComEfeitos(cliente, { ...entrada, expectedAssignee: "dono-anterior" });
    expect(rpc).toHaveBeenCalledWith(
      "fn_conversation_assign",
      expect.objectContaining({
        p_organization_id: "org-a",
        p_to_user_id: "atendente-a",
        p_expected_assignee: "dono-anterior",
        p_reason: "claim",
        p_enforce_expected: true,
      }),
    );
  });
});
