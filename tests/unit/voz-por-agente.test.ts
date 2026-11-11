import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * VOZ POR AGENTE (#4228), herdando a da organização.
 *
 * Até aqui, `resolverVozDoTurno` lia SEMPRE `organizations.settings->'voz'->>'voice_id'`:
 * oito agentes num mesmo número falavam com a mesma voz, e quem dava personas
 * diferentes (um "Leo" e uma "Helena") precisava renomear os agentes para caber
 * numa voz só.
 *
 * O contrato desta fatia: o agente PODE ter voz própria (`ai_agents.config.voz_voice_id`,
 * jsonb — mesmo lugar dos outros knobs por agente, sem coluna nova). Sem ela, a
 * resolução é a de hoje, byte a byte: mesma chave, mesmo valor, mesmo formato.
 * E a voz de um agente de OUTRA empresa nunca entra no turno deste.
 */

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

import { loadPublishedAgentConfigById } from "@/lib/agent-engine/agent/agent-config";
import { resolverVozDoTurno } from "@/lib/agent-engine/agent/voz-do-turno";

type Settings = Record<string, unknown> | null;

/** Um banco em que cada organização tem o SEU `settings` — como o de verdade. */
function poolPorOrg(settingsPorOrg: Record<string, Settings>) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: [{ settings: settingsPorOrg[String(params[0])] ?? null }],
  }));
  return { query } as never;
}

const base = {
  cfg: {},
  voiceNote: "server-convert" as const,
  vozEnabled: true,
  vozQuando: "sempre" as const,
  inboundType: null,
};

beforeEach(() => {
  resolveOrgLlmConfigMock.mockReset();
  resolveOrgLlmConfigMock.mockResolvedValue({ apiKey: "k-elevenlabs" });
  aplicarOrcamentoMock.mockReset();
  aplicarOrcamentoMock.mockResolvedValue(undefined);
  chaveDaTelaMock.mockReset();
  chaveDaTelaMock.mockImplementation((piso: string) => piso);
});

describe("voz por agente — herança da voz da organização", () => {
  it("agente SEM voz própria usa a da organização, byte a byte", async () => {
    const voiceIdDaOrg = "Voz-Da-Org_9X.y";
    const r = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: { voice_id: voiceIdDaOrg, model_id: "eleven_turbo_v2" } } }),
      tenantId: "org-a",
      vozVoiceId: null,
    });
    expect(r?.voiceId).toBe(voiceIdDaOrg);
    expect(r).toEqual({
      apiKey: "k-elevenlabs",
      voiceId: voiceIdDaOrg,
      modelId: "eleven_turbo_v2",
      formato: "mp3",
    });
  });

  it("retrocompatível: quem não passa `vozVoiceId` (chamador antigo) tem o MESMO resultado de antes", async () => {
    const semCampo = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: { voice_id: "voz-unica" } } }),
      tenantId: "org-a",
    });
    const comCampoNulo = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: { voice_id: "voz-unica" } } }),
      tenantId: "org-a",
      vozVoiceId: null,
    });
    expect(semCampo).toEqual(comCampoNulo);
    expect(semCampo?.voiceId).toBe("voz-unica");
  });

  it("voz própria do agente vence a da organização — sem tocar no model_id da organização", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: { voice_id: "voz-da-org", model_id: "eleven_turbo_v2" } } }),
      tenantId: "org-a",
      vozVoiceId: "voz-do-leo",
    });
    expect(r?.voiceId).toBe("voz-do-leo");
    expect(r?.modelId).toBe("eleven_turbo_v2");
  });

  it("voz própria em branco (só espaço) herda em vez de virar id inválido na ElevenLabs", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: { voice_id: "voz-da-org" } } }),
      tenantId: "org-a",
      vozVoiceId: "   ",
    });
    expect(r?.voiceId).toBe("voz-da-org");
  });

  it("agente com voz própria fala mesmo quando a ORGANIZAÇÃO nunca escolheu voz", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: {} } }),
      tenantId: "org-a",
      vozVoiceId: "voz-do-agente",
    });
    expect(r?.voiceId).toBe("voz-do-agente");
  });

  it("nem a organização nem o agente com voz: continua em texto (null), como antes", async () => {
    const r = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg({ "org-a": { voz: {} } }),
      tenantId: "org-a",
      vozVoiceId: null,
    });
    expect(r).toBeNull();
  });
});

describe("voz por agente — isolamento entre empresas", () => {
  const settings = {
    "org-a": { voz: { voice_id: "voz-da-org-a" } },
    "org-b": { voz: { voice_id: "voz-da-org-b" } },
  };

  it("a voz do agente de outra empresa não entra no turno desta", async () => {
    const daOrgA = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg(settings),
      tenantId: "org-a",
      vozVoiceId: null,
    });
    const daOrgB = await resolverVozDoTurno({
      ...base,
      pool: poolPorOrg(settings),
      tenantId: "org-b",
      vozVoiceId: "voz-do-leo-da-b",
    });
    expect(daOrgA?.voiceId).toBe("voz-da-org-a");
    expect(daOrgB?.voiceId).toBe("voz-do-leo-da-b");
    expect(daOrgA?.voiceId).not.toBe(daOrgB?.voiceId);
  });

  it("a leitura da config do agente é escopada por organização: id de outra empresa devolve null", async () => {
    const select = linhaDoBanco({ config: { voz_voice_id: "voz-do-leo-da-b" } });
    const db = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        // Emula o banco de verdade: `where a.organization_id = $1 and a.id = $2`.
        const [, agentId] = params as string[];
        const pertence = agentId === "agente-b" && params[0] === "org-b";
        return { rows: pertence ? [select] : [] };
      }),
    } as never;

    expect(await loadPublishedAgentConfigById(db, "org-a", "agente-b")).toBeNull();
    const daPropria = await loadPublishedAgentConfigById(db, "org-b", "agente-b");
    expect(daPropria?.vozVoiceId).toBe("voz-do-leo-da-b");
  });
});

describe("voz por agente — leitura da config publicada", () => {
  it("lê `config.voz_voice_id` do agente", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [linhaDoBanco({ config: { voz_voice_id: "voz-do-leo" } })] })),
    } as never;
    const cfg = await loadPublishedAgentConfigById(db, "org-a", "agente-a");
    expect(cfg?.vozVoiceId).toBe("voz-do-leo");
  });

  it("agente que nunca escolheu (chave ausente) devolve null — herda, não quebra", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [linhaDoBanco({ config: { rag_top_k: 7 } })] })),
    } as never;
    const cfg = await loadPublishedAgentConfigById(db, "org-a", "agente-a");
    expect(cfg?.vozVoiceId).toBeNull();
  });
});

/** Uma linha de `ai_agent_versions` + `ai_agents` como o SELECT do loader devolve. */
function linhaDoBanco(over: { config?: Record<string, unknown> | null } = {}) {
  return {
    operation_mode: "automatic",
    paused_at: null,
    operation_revision: "1",
    agent_id: "agente-a",
    version_id: "versao-1",
    agent_name: "Leo",
    system_prompt: "Você é o Leo, atendente da loja. Responda em pt-BR.",
    provider: "openai",
    model: "gpt-4o-mini",
    credential_id: null,
    max_steps: 10,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    handoff_legal_enabled: true,
    proposal_ai_draft_enabled: true,
    split_messages: false,
    split_max_chars: 600,
    inbound_debounce_ms: null,
    reply_min_interval_ms: null,
    multimodal_input: true,
    image_vision_enabled: true,
    cases_enabled: false,
    followup: null,
    tool_ids: [],
    active_kb_version_id: null,
    config: over.config === undefined ? null : over.config,
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    knowledge_source_ids: [],
    skill_names: null,
    trigger_config: null,
    version_created_by: null,
    agent_created_by: null,
    voz_enabled: true,
    voz_quando: "sempre",
  };
}
