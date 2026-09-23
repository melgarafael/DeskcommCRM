import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

const organizationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "44444444-4444-4444-8444-444444444444";
const userId = "11111111-1111-4111-8111-111111111111";
const rpc = vi.fn();

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
    supabase: { rpc } as never,
    idioma: "pt-BR",
  });
  vi.mocked(sendMessageHandler).mockResolvedValue({
    id: "message-1",
    conversation_id: conversationId,
    status: "sent",
  } as never);
  rpc.mockResolvedValue({ data: [{ id: conversationId }], error: null });
});

describe("POST /messages após resposta humana", () => {
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
