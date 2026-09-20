import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  context: vi.fn(),
  rate: vi.fn(),
  model: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
  client: {},
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: m.support }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => m.client }));
vi.mock("@/lib/workspace/context", () => ({ loadWorkspaceContext: m.context }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: m.rate }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ connect: async () => ({ release: m.release }) }),
}));
vi.mock("@/lib/prospecting/agent-setup", () => ({ resolveSetupModel: m.model }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: m.run,
  llmEdgeConfigFromEnv: () => ({}),
}));
vi.mock("@/lib/env", () => ({ env: {} }));
import { askWorkspace } from "@/app/app/_workspace-action";
const input = { question: "Resuma", scope: "all", history: [] };
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({
    ok: true,
    user: { id: "user" },
    org: { orgId: "org-session", role: "agent" },
  });
  m.support.mockResolvedValue(null);
  m.rate.mockResolvedValue({ allowed: true });
  m.context.mockResolvedValue({
    sources: [
      {
        id: "source1",
        title: "Fonte",
        text: "Texto",
        href: "/app/inbox?id=source1",
        kind: "Conversa",
      },
    ],
    notice: "Recorte",
  });
  m.model.mockResolvedValue({ provider: "openai", model: "test", credential_id: "key-org" });
  m.run.mockResolvedValue({ result: { text: '{"answer":"Resposta","sourceIds":["source1"]}' } });
});
describe("consulta autenticada do CRM", () => {
  it("não consulta conteúdo sem autenticação ou em suporte somente leitura", async () => {
    m.auth.mockResolvedValueOnce({ ok: false });
    expect((await askWorkspace(input)).ok).toBe(false);
    m.support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await askWorkspace(input)).ok).toBe(false);
    expect(m.context).not.toHaveBeenCalled();
  });
  it("recusa tenant fornecido pelo cliente e respeita rate limit", async () => {
    expect((await askWorkspace({ ...input, orgId: "outra" })).ok).toBe(false);
    m.rate.mockResolvedValueOnce({ allowed: false });
    expect((await askWorkspace(input)).ok).toBe(false);
    expect(m.context).not.toHaveBeenCalled();
  });
  it("consulta via client de sessão e usa tenant autenticado no orçamento, sem ferramentas", async () => {
    const result = await askWorkspace(input);
    expect(result.ok).toBe(true);
    expect(m.context).toHaveBeenCalledWith(m.client, "org-session", "agent", "all", "Resuma");
    const call = m.run.mock.calls[0]?.[2];
    expect(call.tenantId).toBe("org-session");
    expect(call.tools).toBeUndefined();
    expect(m.release).toHaveBeenCalledOnce();
  });
  it("recusa referência inventada pelo modelo", async () => {
    m.run.mockResolvedValueOnce({
      result: { text: '{"answer":"Inventado","sourceIds":["outra-org"]}' },
    });
    expect((await askWorkspace(input)).ok).toBe(false);
  });
  it("ausência de conteúdo é explícita e não consome modelo", async () => {
    m.context.mockResolvedValueOnce({ sources: [], notice: "Recorte" });
    const result = await askWorkspace(input);
    expect(result.ok).toBe(true);
    expect(m.run).not.toHaveBeenCalled();
  });
  it("falha não revela credenciais ou erro interno", async () => {
    m.run.mockRejectedValueOnce(new Error("private-key"));
    const result = await askWorkspace(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-key");
  });
});
