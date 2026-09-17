import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-byok-da-org",
}));

import {
  llmEdgeConfigFromEnv,
  resolveOrgLlmConfig,
  LlmNotConfiguredError,
  type LlmEdgeConfig,
} from "./credentials";

/** Pool falso: 1ª query devolve settings->'llm', 2ª devolve credenciais BYOK. */
function poolFake(settingsLlm: unknown, credenciais: unknown[], organization: Record<string, unknown> = {}) {
  let n = 0;
  return {
    query: async () => {
      n += 1;
      return n === 1 ? { rows: [{ llm: settingsLlm, ...organization }] } : { rows: credenciais };
    },
  } as never;
}

const SEM_BYOK: unknown[] = [];

describe("resolveOrgLlmConfig — chave de plataforma por provider", () => {
  it("herda modelo e execução do Advomax para empresa vinculada sem copiar a chave", async () => {
    const fetchAnterior = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      modelo: "deepseek-chat", ativo: true, apiKeyConfigurada: true,
    }), { status: 200 })) as typeof fetch;
    try {
      const out = await resolveOrgLlmConfig(
        poolFake({ provider: "anthropic" }, SEM_BYOK, { advomax_empresa_codigo: 7 }),
        { advomaxApiUrl: "https://gestao.local/", advomaxIntegrationKey: "ponte-secreta" },
        "org-1",
      );
      expect(out).toMatchObject({
        provider: "advomax",
        apiKey: "ponte-secreta",
        defaultModel: "deepseek-chat",
        enabledModels: ["deepseek-chat"],
        organizationId: "org-1",
        baseUrl: "https://gestao.local/integracoes/crm/ia",
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://gestao.local/integracoes/crm/ia/configuracao",
        expect.objectContaining({ headers: expect.objectContaining({ "X-CRM-Organization-Id": "org-1" }) }),
      );
    } finally {
      global.fetch = fetchAnterior;
    }
  });

  it("usa a chave OpenAI do ambiente quando a org não tem BYOK", async () => {
    // O defeito de origem: existia fallback de env só para a Anthropic. A
    // transcrição de áudio chama o Whisper (OpenAI), e numa org que usa
    // Anthropic no chat isso lançava LlmNotConfiguredError — ou, pior, o
    // chamador mandava a chave da Anthropic para a OpenAI e levava 401. A
    // OPENAI_API_KEY que o instalador coleta não chegava a lugar nenhum.
    const cfg: LlmEdgeConfig = { anthropicApiKey: "sk-ant-plataforma", openaiApiKey: "sk-proj-plataforma" };
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "anthropic", default_model: "claude-sonnet-4-6" }, SEM_BYOK),
      cfg,
      "org-1",
      { provider: "openai" },
    );
    expect(out.provider).toBe("openai");
    expect(out.apiKey).toBe("sk-proj-plataforma");
  });

  it("mantém a chave Anthropic do ambiente (comportamento que já existia)", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "anthropic", default_model: "claude-sonnet-4-6" }, SEM_BYOK),
      { anthropicApiKey: "sk-ant-plataforma" },
      "org-1",
    );
    expect(out.apiKey).toBe("sk-ant-plataforma");
  });

  it("a credencial BYOK da org vence a do ambiente", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openai", default_model: "gpt-4o" }, [
        { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" },
      ]),
      { openaiApiKey: "sk-proj-plataforma" },
      "org-1",
    );
    expect(out.apiKey).toBe("chave-byok-da-org");
  });

  it("sem BYOK e sem chave de plataforma, falha em vez de inventar", async () => {
    await expect(
      resolveOrgLlmConfig(poolFake({ provider: "openai" }, SEM_BYOK), {}, "org-1"),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});

/**
 * A ponte que faltava. Os testes acima provam que `resolveOrgLlmConfig` USA
 * `openaiApiKey` — e passavam. Só que nenhum caminho do agente PREENCHIA o campo:
 * `llmEdgeConfigFromEnv` montava apenas a chave da Anthropic, e o único lugar que
 * preenchia a da OpenAI era o worker de transcrição, na mão.
 *
 * Guardar a função de consumo não guarda o call site: a instalação tinha a chave
 * no `.env`, o teste do consumidor estava verde, e o agente OpenAI morria com
 * "org sem credencial LLM utilizável".
 */
describe("llmEdgeConfigFromEnv — o que sai do .env chega ao turno", () => {
  it("leva a chave da OpenAI, não só a da Anthropic", () => {
    const cfg = llmEdgeConfigFromEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-proj-y",
    });
    expect(cfg.anthropicApiKey).toBe("sk-ant-x");
    expect(cfg.openaiApiKey).toBe("sk-proj-y");
  });

  it("chave ausente continua ausente — string vazia não vira credencial", () => {
    const cfg = llmEdgeConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "" });
    expect(cfg).not.toHaveProperty("openaiApiKey");
  });

  it("só OpenAI configurada: a config sai utilizável mesmo sem a Anthropic", () => {
    const cfg = llmEdgeConfigFromEnv({ OPENAI_API_KEY: "sk-proj-y" });
    expect(cfg).not.toHaveProperty("anthropicApiKey");
    expect(cfg.openaiApiKey).toBe("sk-proj-y");
  });

  it("o caminho inteiro: chave do .env resolve um modelo OpenAI numa org sem BYOK", async () => {
    const cfg = llmEdgeConfigFromEnv({ OPENAI_API_KEY: "sk-proj-do-env" });
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openai", default_model: "gpt-5-mini" }, SEM_BYOK),
      cfg,
      "org1",
    );
    expect(out.apiKey).toBe("sk-proj-do-env");
  });
});
