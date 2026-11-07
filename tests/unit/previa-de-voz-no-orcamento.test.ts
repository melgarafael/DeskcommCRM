/**
 * A PRÉVIA DE VOZ CONTA NO ORÇAMENTO DE IA DA ORGANIZAÇÃO.
 *
 * `POST /api/v1/ai/voz/preview` paga a síntese ao ElevenLabs como a voz do
 * agente paga — então passa pelo MESMO gate (`aplicarOrcamento`, purpose
 * `sintese_de_voz`) antes de sintetizar, e grava o MESMO custo
 * (`registrarCustoDeVoz`) depois, sempre com a organização da SESSÃO.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rateLimit: vi.fn(),
  resolveOrgLlmConfig: vi.fn(),
  aplicarOrcamento: vi.fn(),
  sintetizarVoz: vi.fn(),
  registrarCustoDeVoz: vi.fn(),
  pool: { tag: "pool" },
  admin: { tag: "admin" },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rateLimit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.admin }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => deps.pool }));
vi.mock("@/lib/agent-engine/env", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/instalacao/comportamento", () => ({ chaveDeOrcamentoDaInstalacao: (piso: string) => piso }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: deps.resolveOrgLlmConfig,
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  aplicarOrcamento: deps.aplicarOrcamento,
  llmEdgeConfigFromEnv: () => ({ budgetEnforcement: "on" }),
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {},
}));
vi.mock("@/lib/agent-engine/edge/crm/send-voice", () => ({ registrarCustoDeVoz: deps.registrarCustoDeVoz }));
vi.mock("@/lib/ai/voz/sintetizar", () => ({ sintetizarVoz: deps.sintetizarVoz }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (texto: string) => texto }));

import { POST } from "@/app/api/v1/ai/voz/preview/route";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";
import { LlmNotConfiguredError } from "@/lib/agent-engine/edge/llm/credentials";

const ORG_DA_SESSAO = "11111111-1111-4111-8111-111111111111";
const ORG_DO_CORPO = "99999999-9999-4999-8999-999999999999";

function req(corpo: Record<string, unknown> = { voice_id: "v1" }) {
  return new NextRequest("http://localhost/api/v1/ai/voz/preview", {
    method: "POST",
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.requireRole.mockResolvedValue({
    ok: true,
    user: { id: "user-1", idioma: "pt-BR" },
    org: { orgId: ORG_DA_SESSAO },
  });
  deps.rateLimit.mockResolvedValue({ allowed: true });
  deps.resolveOrgLlmConfig.mockResolvedValue({
    provider: "elevenlabs",
    apiKey: "chave-da-org",
    origemDaChave: "credencial_da_organizacao",
    orcamento: { modo: "bloquear", tetoCents: 100 },
    orcamentoIndisponivelPorque: null,
  });
  deps.aplicarOrcamento.mockResolvedValue(undefined);
  deps.sintetizarVoz.mockResolvedValue({ audio: Buffer.from("mp3"), mimeType: "audio/mpeg", caracteres: 42 });
});

describe("POST /api/v1/ai/voz/preview — orçamento de IA", () => {
  it("orçamento esgotado: não sintetiza, não registra custo e devolve budget_exceeded", async () => {
    deps.aplicarOrcamento.mockRejectedValue(new LlmBudgetExceededError());

    const res = await POST(req());

    expect(res.status).toBe(402);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("budget_exceeded");
    expect(corpo.error.message).toMatch(/orçamento de IA/);
    expect(deps.sintetizarVoz).not.toHaveBeenCalled();
    expect(deps.registrarCustoDeVoz).not.toHaveBeenCalled();
  });

  it("orçamento ok: passa pelo gate da voz, sintetiza e registra o custo na organização da sessão", async () => {
    const res = await POST(req({ voice_id: "v1", organization_id: ORG_DO_CORPO }));

    expect(res.status).toBe(200);
    expect(deps.resolveOrgLlmConfig).toHaveBeenCalledWith(deps.pool, expect.anything(), ORG_DA_SESSAO, {
      provider: "elevenlabs",
    });
    expect(deps.aplicarOrcamento).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_DA_SESSAO,
        purpose: "sintese_de_voz",
        provider: "elevenlabs",
        chave: "on",
        origemDaChave: "credencial_da_organizacao",
      }),
    );
    expect(deps.aplicarOrcamento.mock.invocationCallOrder[0]).toBeLessThan(
      deps.sintetizarVoz.mock.invocationCallOrder[0]!,
    );
    expect(deps.sintetizarVoz).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "chave-da-org", voiceId: "v1" }));
    expect(deps.registrarCustoDeVoz).toHaveBeenCalledWith({
      supabase: deps.admin,
      organizationId: ORG_DA_SESSAO,
      jobId: null,
      caracteres: 42,
      modelId: "eleven_multilingual_v2",
    });
  });

  it("síntese que falhou não registra custo", async () => {
    deps.sintetizarVoz.mockRejectedValue(new Error("synthesis_503"));

    const res = await POST(req());

    expect(res.status).toBe(502);
    expect(deps.registrarCustoDeVoz).not.toHaveBeenCalled();
  });

  it("sem credencial do ElevenLabs: credential_required, sem gate nem síntese", async () => {
    deps.resolveOrgLlmConfig.mockRejectedValue(new LlmNotConfiguredError());

    const res = await POST(req());

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("credential_required");
    expect(deps.aplicarOrcamento).not.toHaveBeenCalled();
    expect(deps.sintetizarVoz).not.toHaveBeenCalled();
  });
});
