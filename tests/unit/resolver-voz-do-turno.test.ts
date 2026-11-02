import { describe, expect, it, vi, beforeEach } from "vitest";

const { resolveOrgLlmConfigMock, aplicarOrcamentoMock, chaveDaTelaMock } = vi.hoisted(() => ({
  resolveOrgLlmConfigMock: vi.fn(),
  aplicarOrcamentoMock: vi.fn(),
  chaveDaTelaMock: vi.fn(),
}));

vi.mock("@/lib/instalacao/comportamento", () => ({ chaveDeOrcamentoDaInstalacao: chaveDaTelaMock }));

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: resolveOrgLlmConfigMock,
}));

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  aplicarOrcamento: aplicarOrcamentoMock,
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {
    constructor() {
      super("llm_budget_exceeded");
      this.name = "LlmBudgetExceededError";
    }
  },
}));

import { resolverVozDoTurno } from "@/lib/agent-engine/agent/voz-do-turno";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";

function pool(settings: Record<string, unknown> | null = { voz: { voice_id: "v1" } }) {
  return { query: vi.fn(async () => ({ rows: [{ settings }] })) } as never;
}

const base = { pool: pool(), tenantId: "org1", cfg: {}, voiceNote: "server-convert" as const };

beforeEach(() => {
  resolveOrgLlmConfigMock.mockReset();
  aplicarOrcamentoMock.mockReset();
  // Default: orçamento OK (não lança) — cada teste de orçamento sobrescreve.
  aplicarOrcamentoMock.mockResolvedValue(undefined);
  // Default: nada gravado na tela de admin — vale o piso que vem do env.
  chaveDaTelaMock.mockReset();
  chaveDaTelaMock.mockImplementation((piso: string) => piso);
});

describe("resolverVozDoTurno", () => {
  it("voz_enabled=false: nunca fala, nem consulta o banco", async () => {
    const db = pool();
    const r = await resolverVozDoTurno({
      ...base,
      pool: db,
      vozEnabled: false,
      vozQuando: "sempre",
      inboundType: "audio",
    });
    expect(r).toBeNull();
    expect((db as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it("canal que só aceita opus: não fala (o mp3 chegaria como anexo), nem consulta o banco", async () => {
    const db = pool();
    const r = await resolverVozDoTurno({
      ...base,
      pool: db,
      voiceNote: "opus-only",
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: "audio",
    });
    expect(r).toBeNull();
    expect((db as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it("vozQuando='nunca': não fala mesmo com voz_enabled=true", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "nunca",
      inboundType: "audio",
    });
    expect(r).toBeNull();
  });

  it("vozQuando='espelhar' e o cliente mandou TEXTO: não fala", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "espelhar",
      inboundType: "text",
    });
    expect(r).toBeNull();
  });

  it("vozQuando='espelhar' e o cliente mandou ÁUDIO: resolve a voz", async () => {
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk_elevenlabs" });
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool({ voz: { voice_id: "v1", model_id: "eleven_turbo_v2" } }),
      vozEnabled: true,
      vozQuando: "espelhar",
      inboundType: "audio",
    });
    expect(r).toEqual({ apiKey: "sk_elevenlabs", voiceId: "v1", modelId: "eleven_turbo_v2" });
    expect(resolveOrgLlmConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      {},
      "org1",
      { provider: "elevenlabs" },
    );
    // O gate de orçamento precisa ser CHAMADO — achado na revisão de código:
    // antes, a voz nunca passava por ele, e uma org sem teto continuava
    // chamando o ElevenLabs sem parar e sem avisar.
    expect(aplicarOrcamentoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        purpose: "sintese_de_voz",
        provider: "elevenlabs",
        model: "eleven_turbo_v2",
      }),
    );
  });

  it("vozQuando='sempre' sem mensagem inbound nenhuma (ex.: follow-up proativo): ainda fala", async () => {
    resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).not.toBeNull();
  });

  it("sem voice_id configurado (Fase 7 não existe ainda): fala em texto, não trava", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool({}),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).toBeNull();
    expect(resolveOrgLlmConfigMock).not.toHaveBeenCalled();
  });

  it("sem credencial ElevenLabs cadastrada: fala em texto, não lança", async () => {
    resolveOrgLlmConfigMock.mockRejectedValue(new Error("llm_not_configured"));
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).toBeNull();
  });

  it("falha de rede ao resolver credencial: fala em texto, não lança", async () => {
    resolveOrgLlmConfigMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await resolverVozDoTurno({
      ...base,
      pool: pool(),
      vozEnabled: true,
      vozQuando: "sempre",
      inboundType: null,
    });
    expect(r).toBeNull();
  });

  describe("gate de orçamento", () => {
    it("orçamento esgotado: fala em texto, não lança — o aviso crítico já abriu dentro do gate", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      aplicarOrcamentoMock.mockRejectedValue(new LlmBudgetExceededError());

      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });

      expect(r).toBeNull();
    });

    it("chave de enforcement vem de cfg.budgetEnforcement, não hardcoded", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      await resolverVozDoTurno({
        ...base,
        cfg: { budgetEnforcement: "avisar" },
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(aplicarOrcamentoMock).toHaveBeenCalledWith(
        expect.objectContaining({ chave: "avisar" }),
      );
    });

    it("o interruptor da tela de admin vence o env, como no chat", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      chaveDaTelaMock.mockReturnValue("off");
      await resolverVozDoTurno({
        ...base,
        cfg: { budgetEnforcement: "on" },
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(chaveDaTelaMock).toHaveBeenCalledWith("on");
      expect(aplicarOrcamentoMock).toHaveBeenCalledWith(expect.objectContaining({ chave: "off" }));
    });

    it("sem cfg.budgetEnforcement, usa 'on' — o kill switch só AFROUXA, nunca força desligado por omissão", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      await resolverVozDoTurno({
        ...base,
        cfg: {},
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(aplicarOrcamentoMock).toHaveBeenCalledWith(expect.objectContaining({ chave: "on" }));
    });

    it("erro de orçamento que NÃO é LlmBudgetExceededError ainda cai pra texto (defesa contra erro inesperado)", async () => {
      resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "sk" });
      aplicarOrcamentoMock.mockRejectedValue(new Error("boom"));
      const r = await resolverVozDoTurno({
        ...base,
        pool: pool(),
        vozEnabled: true,
        vozQuando: "sempre",
        inboundType: null,
      });
      expect(r).toBeNull();
    });
  });
});
