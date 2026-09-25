import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => undefined),
}));

const organizationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "44444444-4444-4444-8444-444444444444";
const userId = "11111111-1111-4111-8111-111111111111";
const rpc = vi.fn();
/** O `settings` da organização, lido pela rota antes de assumir. */
let settings: unknown = null;
const from = vi.fn((tabela: string) => {
  expect(tabela).toBe("organizations");
  const cadeia = {
    select: () => cadeia,
    eq: (coluna: string, valor: string) => {
      expect([coluna, valor]).toEqual(["id", organizationId]);
      return cadeia;
    },
    maybeSingle: async () => ({ data: { settings }, error: null }),
  };
  return cadeia;
});

function req() {
  return new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, type: "text", body: "Resposta" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    via: "session",
    organizationId,
    actor: { type: "user", id: userId },
    // Exercitamos a rota real com somente o banco dublado.
    supabase: { rpc, from } as never,
    idioma: "pt-BR",
  });
  vi.mocked(sendMessageHandler).mockResolvedValue({
    id: "message-1",
    conversation_id: conversationId,
    status: "sent",
  } as never);
  rpc.mockResolvedValue({
    data: [{ id: conversationId, contact_id: "55555555-5555-4555-8555-555555555555" }],
    error: null,
  });
  settings = { routing: { mode: "manual", conversation_stays_with_attendant: true } };
});

describe("POST /messages após resposta humana, com o ajuste LIGADO", () => {
  it("assume somente se a conversa ainda estiver livre", async () => {
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith("fn_conversation_assign", {
      p_organization_id: organizationId,
      p_conversation_id: conversationId,
      p_to_user_id: userId,
      p_reason: "claim",
      p_enforce_expected: true,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conversation.claimed" }));
    expect(registrarTrocaDeComando).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: "conversation_claimed", conversationId }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({
        p_event_type: "conversation.claimed",
        p_entity_id: conversationId,
        p_organization_id: organizationId,
      }),
    );
  });

  it("respeita quem assumiu primeiro e não informa falha falsa do envio", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(audit).not.toHaveBeenCalled();
  });

  it("não assume após falha do canal", async () => {
    vi.mocked(sendMessageHandler).mockResolvedValue({
      id: "message-1",
      conversation_id: conversationId,
      status: "failed",
    } as never);
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(rpc).not.toHaveBeenCalled();
  });
});

/**
 * O PADRÃO, e o de toda empresa que já existia: responder NÃO assume a
 * conversa. A IA segue calada só pelos minutos de sempre, que o envio aplica.
 */
describe("POST /messages após resposta humana, com o ajuste DESLIGADO", () => {
  it.each([
    ["sem settings", null],
    ["sem a chave", { routing: { mode: "round_robin" } }],
    ["com false", { routing: { conversation_stays_with_attendant: false } }],
    ["com texto \"true\"", { routing: { conversation_stays_with_attendant: "true" } }],
  ])("não assume a conversa (%s)", async (_nome, valor) => {
    settings = valor;
    // A rota engole erro do claim (falha dele não pode virar falha do envio).
    // Sem esta espia, um erro ANTES da leitura do ajuste passaria por "desligado".
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/v1/messages/route");
    const response = await POST(req());
    expect(response.status).toBe(201);
    expect(from).toHaveBeenCalledWith("organizations");
    expect(erro).not.toHaveBeenCalled();
    erro.mockRestore();
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(registrarTrocaDeComando).not.toHaveBeenCalled();
  });
});
