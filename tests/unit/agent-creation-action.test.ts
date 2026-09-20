import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  auth: vi.fn(),
  rate: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
  run: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: mocks.connect }),
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: mocks.run,
  llmEdgeConfigFromEnv: () => ({}),
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/prospecting/agent-setup", () => ({
  resolveSetupModel: mocks.resolve,
  AgentSetupError: class extends Error {},
}));
import { prepareAgentConversation } from "@/app/app/ai/agents/new/_chat-action";
const input = { messages: [{ role: "user", content: "Quero atender interessados" }], draft: {} };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.auth.mockResolvedValue({
    ok: true,
    org: { orgId: "org-auth" },
    user: { id: "admin-auth" },
  });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.connect.mockResolvedValue({ release: mocks.release });
  mocks.resolve.mockResolvedValue({
    provider: "openai",
    model: "test-model",
    credential_id: "cred-org",
  });
  mocks.run.mockResolvedValue({
    result: { text: JSON.stringify({ message: "Qual o seu negócio?", draft: {} }) },
  });
});
describe("criação conversacional no servidor", () => {
  it("nega suporte somente leitura e sessão sem permissão antes de usar IA", async () => {
    mocks.support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await prepareAgentConversation(input)).ok).toBe(false);
    expect(mocks.auth).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValueOnce({ ok: false });
    expect((await prepareAgentConversation(input)).ok).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("recusa tenant fornecido pelo cliente e entradas inválidas", async () => {
    expect((await prepareAgentConversation({ ...input, tenantId: "outra-org" })).ok).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("respeita limite por organização e usuário antes de chamar modelo", async () => {
    mocks.rate.mockResolvedValueOnce({ allowed: false });
    expect((await prepareAgentConversation(input)).ok).toBe(false);
    expect(mocks.rate).toHaveBeenCalledWith("agent-creation:org-auth:admin-auth", 15, 60);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("usa tenant autenticado e seam de orçamento sem disponibilizar ferramentas", async () => {
    expect((await prepareAgentConversation(input)).ok).toBe(true);
    expect(mocks.auth).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "ai_agent" }),
    );
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), "org-auth");
    const request = mocks.run.mock.calls[0]![2];
    expect(request).toMatchObject({
      tenantId: "org-auth",
      purpose: "agent_creation_chat",
      maxSteps: 1,
      llmOverride: { provider: "openai", credentialId: "cred-org" },
    });
    expect(request.tools).toBeUndefined();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("não aceita publicação inventada nem expõe erro interno ou credencial", async () => {
    mocks.run.mockResolvedValueOnce({
      result: { text: '{"message":"Publiquei","draft":{"published":true}}' },
    });
    expect((await prepareAgentConversation(input)).ok).toBe(false);
    mocks.resolve.mockRejectedValueOnce(new Error("secret-provider-key"));
    const response = await prepareAgentConversation(input);
    expect(response.ok).toBe(false);
    expect(response.message).not.toContain("secret-provider-key");
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});
