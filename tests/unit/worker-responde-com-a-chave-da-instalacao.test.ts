/**
 * A CHAVE DA INSTALAÇÃO ATENDE O WORKER — inclusive quando só há `OPENAI_API_KEY`.
 *
 * O `install.sh` oferece OpenAI como provedor e a chave vai para
 * `OPENAI_API_KEY`; o catálogo (`ai_models`, migration 0104) serve o id do
 * modelo BARE (`gpt-5.6-terra`, o `is_default_for_provider` da OpenAI), sem
 * prefixo de rota; e o turno real monta o provedor pelo par (provider da
 * organização, chave do ambiente) em `buildModel`. É por isso que o ensaio do
 * agente e o "Sugerir resposta" respondem numa instalação assim.
 *
 * O worker de resposta automática não respondia. Ele resolvia o modelo por
 * `resolveLanguageModel`, que roteia pelo PREFIXO do id canônico
 * (`openai/gpt-5.6-terra`): id sem prefixo não acha provedor nenhum, o resolver
 * devolvia `null` e a mensagem do cliente era pulada com
 * `reason: "ai_gateway_key_missing"` — com a chave certa no `.env` (issue
 * #1181).
 *
 * O que este teste prende: com só `OPENAI_API_KEY`, o id do catálogo resolve no
 * provedor que a ORGANIZAÇÃO escolheu; o id que chega ao SDK é o do catálogo,
 * sem a rota (o prefixo é rota, não nome de modelo); sem chave nenhuma o
 * desfecho continua o mesmo; e id de outro provedor não passa a ser atendido
 * pela chave da OpenAI.
 *
 * E os DOIS CAMINHOS da escada de chave, medidos separadamente: quando a conta
 * TEM credencial utilizável quem responde é ela (`credencial_da_organizacao`);
 * quando a conta NÃO tem, quem responde é a chave da plataforma
 * (`padrao`) — inclusive quando o provedor que a organização registrou não tem
 * chave no ambiente, caso em que quem decide de quem é o id BARE é o catálogo
 * `ai_models` e não uma tentativa com qualquer chave que exista.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

const estado = vi.hoisted(() => ({
  binding: null as Record<string, unknown> | null,
  credencial: null as Record<string, unknown> | null,
  settings: null as unknown,
  /** Linha do catálogo `ai_models` para o id BARE que o teste usa. */
  catalogo: null as Record<string, unknown> | null,
  leiturasDeOrganizacao: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "organizations") estado.leiturasDeOrganizacao += 1;
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            tabela === "ai_purpose_bindings"
              ? estado.binding
              : tabela === "organizations"
                ? { settings: estado.settings }
                : tabela === "ai_models"
                  ? estado.catalogo
                  : estado.credencial,
        }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");

const ORG = "33333333-3333-4333-8333-333333333333";
const MODELO_PADRAO_DA_OPENAI = "gpt-5.6-terra";

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  estado.binding = null;
  estado.credencial = null;
  estado.settings = { llm: { provider: "openai" } };
  estado.catalogo = { provider: "openai" };
  estado.leiturasDeOrganizacao = 0;
});

describe("o worker responde com a chave da instalação", () => {
  it("só com OPENAI_API_KEY, o id do catálogo resolve o ponto", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.modelId).toBe(MODELO_PADRAO_DA_OPENAI);
    expect(resolvido?.origem).toBe("padrao");
  });

  it("o id que chega ao provedor é o do catálogo, sem a rota", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);
    const instanciado = resolvido?.model as { modelId?: string } | undefined;

    expect(typeof resolvido?.model).toBe("object");
    expect(instanciado?.modelId).toBe(MODELO_PADRAO_DA_OPENAI);
  });

  it("binding sem credencial utilizável também cai na chave da instalação", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";
    estado.binding = {
      provider: "openai",
      credential_id: null,
      model_id: MODELO_PADRAO_DA_OPENAI,
      base_url: null,
    };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("padrao");
  });

  it("sem chave nenhuma no ambiente o desfecho continua o mesmo", async () => {
    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).toBeNull();
  });

  it("id de outro provedor não vira chamada com a chave da OpenAI", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";

    const resolvido = await resolverModeloDoPonto(
      "bot_respond",
      ORG,
      "anthropic/claude-haiku-4-5",
    );

    expect(resolvido).toBeNull();
  });

  it("id canônico prefixado segue resolvendo — não-regressão do degrau antigo", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, "openai/gpt-5.6-terra");

    expect(resolvido).not.toBeNull();
    expect(resolvido?.modelId).toBe("openai/gpt-5.6-terra");
  });

  it("id prefixado não paga a leitura do provedor da organização", async () => {
    // O caminho da instalação padrão (chave Anthropic, sem credencial
    // cadastrada) roda a cada evento do worker de sentimento. A única leitura
    // de `organizations` que lhe cabe é a da procura por credencial; a do
    // provedor só serve a id BARE e seria descartada aqui.
    envMock.ANTHROPIC_API_KEY = "sk-ant";

    const resolvido = await resolverModeloDoPonto(
      "sentiment_classify",
      ORG,
      "anthropic/claude-haiku-4-5",
    );

    expect(resolvido).not.toBeNull();
    expect(estado.leiturasDeOrganizacao).toBe(1);
  });

  it("caminho 1 — a chave da CONTA responde, sem chave nenhuma no ambiente", async () => {
    // Sem `OPENAI_API_KEY` de propósito: quem paga é a credencial que a
    // organização cadastrou e validou em IA › Credenciais.
    estado.settings = { llm: { provider: "openai" } };
    estado.credencial = { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("credencial_da_organizacao");
  });

  it("caminho 2 — sem chave na conta, quem responde é a chave da PLATAFORMA", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";
    estado.settings = { llm: { provider: "openai" } };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("padrao");
  });

  it("conta no provedor SEM chave no ambiente: o degrau é o do MODELO no catálogo", async () => {
    // O caso que a issue #1181 descreve e que a main ainda não respondia: o
    // gatilho semeia `anthropic` na organização, o instalador coletou só
    // `OPENAI_API_KEY`, e o id BARE do catálogo é da OpenAI. A rota do provedor
    // da conta não acha chave nenhuma, o ponto pedia silêncio com
    // `ai_gateway_key_missing` — e a chave da instalação estava lá o tempo todo.
    envMock.OPENAI_API_KEY = "sk-openai";
    estado.settings = { llm: { provider: "anthropic" } };
    estado.catalogo = { provider: "openai" };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, MODELO_PADRAO_DA_OPENAI);

    expect(resolvido).not.toBeNull();
    expect(resolvido?.origem).toBe("padrao");
  });

  it("o catálogo não vira passe livre: id de outro provedor continua sem resposta", async () => {
    // Controle negativo do degrau novo: a instalação tem só a chave da OpenAI,
    // mas o id é da Anthropic — mandá-lo para o endpoint da OpenAI seria
    // adivinhar provedor, que é exatamente o freio do PR #151.
    envMock.OPENAI_API_KEY = "sk-openai";
    estado.settings = { llm: { provider: "anthropic" } };
    estado.catalogo = { provider: "anthropic" };

    const resolvido = await resolverModeloDoPonto("bot_respond", ORG, "claude-haiku-4-5");

    expect(resolvido).toBeNull();
  });
});
