/**
 * POST /api/v1/ai/assistente/conversa: o módulo conversa com o modelo da organização.
 * Prova: recusa de autorização passa direto (modelo não é chamado), corpo inválido dá 422, a
 * organização vem da autorização (nunca do corpo), orçamento esgotado vira "indisponível" e erro
 * desconhecido sobe.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { LlmBudgetExceededError, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn(() => ({})) }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({ llmEdgeConfigFromEnv: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", async () => {
  class LlmBudgetExceededError extends Error {}
  class LlmProviderUnknownError extends Error {}
  class LlmModelNotEnabledError extends Error {}
  return { runModelCall: vi.fn(), LlmBudgetExceededError, LlmProviderUnknownError, LlmModelNotEnabledError };
});

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";

function req(corpo: unknown): NextRequest {
  return new NextRequest("http://x/api/v1/ai/assistente/conversa", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  vi.mocked(resolveAuthDual).mockReset();
  vi.mocked(runModelCall).mockReset();
  vi.mocked(resolveAuthDual).mockResolvedValue({ ok: true, organizationId: ORG, via: "token" } as never);
});

describe("POST /api/v1/ai/assistente/conversa", () => {
  it("recusa de autorização passa direto e o modelo NÃO é chamado", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) } as never);
    const r = await POST(req({ mensagens: [{ role: "user", content: "oi" }] }));
    expect(r.status).toBe(403);
    expect(runModelCall).not.toHaveBeenCalled();
  });

  it("corpo inválido (sem mensagens) dá 422 e o modelo NÃO é chamado", async () => {
    const r = await POST(req({ mensagens: [] }));
    expect(r.status).toBe(422);
    expect(runModelCall).not.toHaveBeenCalled();
  });

  it("devolve o texto do modelo; a organização vem da autorização, não do corpo", async () => {
    vi.mocked(runModelCall).mockResolvedValue({ result: { text: "olá" } } as never);
    const r = await POST(req({ organization_id: "outra", mensagens: [{ role: "user", content: "oi" }] }));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ disponivel: true, motivo: null, texto: "olá" });
    expect(vi.mocked(runModelCall).mock.calls[0]?.[2]).toMatchObject({ tenantId: ORG, purpose: "assistente_modulo" });
  });

  it("audita UM turno que chegou ao modelo, sem o texto da conversa; recusa e teto não auditam", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue({
      ok: true,
      organizationId: ORG,
      via: "token",
      apiTokenId: "tok-1",
      pessoaDoModulo: "pessoa-1",
      actor: { type: "module", id: "tok-1" },
    } as never);
    vi.mocked(runModelCall).mockResolvedValue({ result: { text: "olá" } } as never);
    await POST(req({ mensagens: [{ role: "user", content: "segredo da conversa" }] }));
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]?.[0];
    expect(entrada).toMatchObject({
      organizationId: ORG,
      actorApiTokenId: "tok-1",
      actorUserId: null,
      action: "ai.assistente_conversa",
      metadata: { mensagens: 1, pessoa_id: "pessoa-1" },
    });
    expect(JSON.stringify(entrada)).not.toContain("segredo da conversa");

    vi.mocked(audit).mockClear();
    vi.mocked(runModelCall).mockRejectedValue(new LlmBudgetExceededError("teto atingido"));
    await POST(req({ mensagens: [{ role: "user", content: "oi" }] }));
    vi.mocked(resolveAuthDual).mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) } as never);
    await POST(req({ mensagens: [{ role: "user", content: "oi" }] }));
    expect(audit).not.toHaveBeenCalled();
  });

  it("orçamento esgotado vira disponivel:false com o motivo, sem erro", async () => {
    vi.mocked(runModelCall).mockRejectedValue(new LlmBudgetExceededError("teto atingido"));
    const r = await POST(req({ mensagens: [{ role: "user", content: "oi" }] }));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ disponivel: false, motivo: "teto atingido", texto: null });
  });

  it("erro desconhecido sobe (não vira 200)", async () => {
    vi.mocked(runModelCall).mockRejectedValue(new Error("boom"));
    await expect(POST(req({ mensagens: [{ role: "user", content: "oi" }] }))).rejects.toThrow("boom");
  });
});
