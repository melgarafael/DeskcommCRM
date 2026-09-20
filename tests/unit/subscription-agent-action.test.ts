import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-test", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org-test", role: "admin" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/mcp/tools", () => ({ VALID_TOOL_IDS: [] }));
import { createMcpAgentAction } from "@/app/app/ai/agents/[id]/_actions";

it("the actual form action returns the plan recovery message without creating a version", async () => {
  const insert = vi
    .fn()
    .mockReturnValue({
      select: () => ({
        single: async () => ({
          data: null,
          error: { code: "P4020", message: "private database diagnostic" },
        }),
      }),
    });
  mocks.from.mockReturnValue({ insert });
  const result = await createMcpAgentAction({
    name: "Atendente",
    priority: 0,
    version: {
      system_prompt: "Responda às dúvidas dos clientes.",
      provider: "openai",
      model: "gpt-5.6-terra",
      credential_id: null,
      channel_session_id: null,
      tool_ids: [],
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: "subscription_resource_limit",
    message: expect.stringContaining("Planos e assinatura"),
  });
  expect(JSON.stringify(result)).not.toContain("private database diagnostic");
  expect(mocks.from).toHaveBeenCalledExactlyOnceWith("ai_agents");
  expect(insert).toHaveBeenCalledWith(
    expect.objectContaining({ organization_id: "org-test", is_active: false }),
  );
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
