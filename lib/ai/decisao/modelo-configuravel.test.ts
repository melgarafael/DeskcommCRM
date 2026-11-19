/**
 * O MODELO DO DECISOR É CONFIGURÁVEL — e o Jev continua sendo o padrão.
 *
 * A issue #4710 pede que o Deskcomm pare de aceitar só o Jev. O que estes casos
 * protegem, na ordem em que um erro dói:
 *
 *  (a) quem nunca escolheu nada continua no Jev — nenhuma instalação muda de
 *      comportamento por causa desta entrega;
 *  (b) a configuração válida CHEGA à chamada: o id vai no corpo e o caminho é o
 *      dos modelos de decisão da OpenRouter (`/api/alpha/decisions`), não o do
 *      Jev (`/v1/systemone`);
 *  (c) um modelo que não declara `decisions` é RECUSADO na escrita, com a frase
 *      que diz o que falta — e não vira degradação silenciosa em produção;
 *  (d) o modelo escolhido fora do ar NÃO derruba o turno: a chamada cai no Jev,
 *      com a mesma credencial, e o resultado volta `ok`.
 *
 * Os dublês são os de `ponto.test.ts`: o banco responde `organizations.settings`
 * e a linha de credencial, e o `fetch` é injetado. A leitura da config é a de
 * verdade (`lerConfigDoJev`) — o caminho testado é o que roda em produção.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const banco = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  linha: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "not", "order", "limit"]) {
        chain[metodo] = () => chain;
      }
      chain.maybeSingle = async () =>
        tabela === "organizations"
          ? { data: banco.settings === null ? null : { settings: banco.settings }, error: null }
          : { data: banco.linha, error: null };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => v,
  decryptKey: (c: { ciphertext: unknown }) => `decifrada:${String(c.ciphertext)}`,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined },
}));

import { CACHE_DO_CATALOGO_MS, conferirModeloDaConfig, esquecerCatalogo, listarModelosDeDecisao } from "@/lib/ai/decisao/catalogo";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { caminhoDaChamada, ehModeloDoJev, fornecedorDoModelo, modeloDaChamada } from "@/lib/ai/decisao/modelo";
import { MODELO_DA_TYPESAFE, MODELO_NA_OPENROUTER } from "@/lib/ai/decisao/origem";
import { decidirNoPonto } from "@/lib/ai/decisao/ponto";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACEITE = { em: "2026-11-15T12:00:00.000Z", por: "22222222-2222-4222-8222-222222222222" };
const MODELO_DE_FORA = "perplexity/pplx-decider-v1.3:free";

/** A config de quem escolheu outro modelo — origem OpenRouter, aceite dado. */
function ligadoCom(modelo?: string): Record<string, unknown> {
  return {
    jev: {
      ligado: true,
      modo: "observacao",
      origem: "openrouter",
      ...(modelo === undefined ? {} : { modelo }),
      aceite: ACEITE,
    },
  };
}

const PERGUNTAS = {
  clima: { tipo: "score", instrucao: "Qual o clima?", criterios: ["ruim", "neutro", "bom"] },
} as const;

const CORPO_OK = {
  answers: { clima: { type: "score", score: 2, legend: {}, probabilities: { "2": 1 }, confidence: 0.9 } },
  usage: { input_tokens: 100, output_tokens: 0 },
};

function ok(corpo: unknown, modelo?: string): Response {
  return new Response(JSON.stringify(modelo === undefined ? corpo : { ...(corpo as object), model: modelo }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function catalogoCom(ids: Array<{ id: string; output_modalities?: string[] }>): Response {
  return ok({ data: ids });
}

beforeEach(() => {
  banco.settings = ligadoCom();
  banco.linha = { api_key_encrypted: "or-1", api_key_iv: "", api_key_tag: "" };
  esquecerCatalogo();
});

describe("(a) sem configuração, o modelo é o Jev", () => {
  it("a config vazia resolve para o Jev, e não para um modelo de fora", () => {
    const padrao = lerConfigDoJev({});
    expect(padrao.modelo).toBeUndefined();
    expect(modeloDaChamada(padrao)).toBe(MODELO_DA_TYPESAFE);
    expect(ehModeloDoJev(modeloDaChamada(padrao))).toBe(true);
  });

  it("a chamada sem modelo gravado manda o Jev da origem, no caminho do Jev", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(CORPO_OK, MODELO_NA_OPENROUTER));

    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: ORG, estado: "adorei!", perguntas: PERGUNTAS },
      { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    );

    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(JSON.parse(String(init.body)).model).toBe(MODELO_NA_OPENROUTER);
  });

  it("modelo gravado com a origem TypeSafe é ignorado — a chave da TypeSafe não serve para ele", () => {
    const config = lerConfigDoJev({
      jev: { ligado: true, origem: "typesafe", modelo: MODELO_DE_FORA, aceite: ACEITE },
    });
    expect(config.modelo).toBe(MODELO_DE_FORA);
    expect(modeloDaChamada(config)).toBe(MODELO_DA_TYPESAFE);
  });
});

describe("(b) configuração válida é usada na chamada", () => {
  it("o modelo escolhido vai no corpo e no caminho dos modelos de decisão", async () => {
    banco.settings = ligadoCom(MODELO_DE_FORA);
    const fetchImpl = vi.fn().mockResolvedValue(ok(CORPO_OK, MODELO_DE_FORA));

    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: ORG, estado: "adorei!", perguntas: PERGUNTAS },
      { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    );

    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe(MODELO_DE_FORA);
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(caminhoDaChamada(MODELO_DE_FORA)).toBe("/alpha/decisions");
    expect(caminhoDaChamada(MODELO_NA_OPENROUTER)).toBe("/v1/systemone");
  });

  it("a config gravada chega inteira à resolução do modelo", () => {
    const config = lerConfigDoJev(ligadoCom(MODELO_DE_FORA));
    expect(config.modelo).toBe(MODELO_DE_FORA);
    expect(modeloDaChamada(config)).toBe(MODELO_DE_FORA);
  });
});

describe("(c) modelo sem `decisions` é recusado com a mensagem do que falta", () => {
  it("aceita o modelo que declara decisions no catálogo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalogoCom([{ id: MODELO_DE_FORA, output_modalities: ["decisions"] }]));
    const conferido = await conferirModeloDaConfig({
      modelo: MODELO_DE_FORA,
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });
    expect(conferido).toEqual({ ok: true, modelo: MODELO_DE_FORA });
  });

  it("recusa o modelo que o catálogo diz ser de texto, e a frase diz o que falta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalogoCom([{ id: "openai/gpt-6-luna", output_modalities: ["text"] }]));
    const conferido = await conferirModeloDaConfig({
      modelo: "openai/gpt-6-luna",
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });

    expect(conferido.ok).toBe(false);
    if (conferido.ok) return;
    expect(conferido.motivo).toBe("jev_modelo_sem_decisoes");
    expect(conferido.mensagem).toContain("decisions");
    expect(conferido.mensagem).toContain("typesafe/jev-1.13");
  });

  it("recusa o id que não está no catálogo", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalogoCom([{ id: MODELO_DE_FORA, output_modalities: ["decisions"] }]));
    const conferido = await conferirModeloDaConfig({
      modelo: "nao/existe",
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });
    expect(conferido.ok).toBe(false);
    if (conferido.ok) return;
    expect(conferido.motivo).toBe("jev_modelo_sem_decisoes");
  });

  it("recusa modelo de fora com a origem TypeSafe, apontando a troca de origem", async () => {
    const fetchImpl = vi.fn();
    const conferido = await conferirModeloDaConfig({
      modelo: MODELO_DE_FORA,
      origem: "typesafe",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });
    expect(conferido.ok).toBe(false);
    if (conferido.ok) return;
    expect(conferido.motivo).toBe("jev_modelo_exige_openrouter");
    expect(conferido.mensagem).toContain("OpenRouter");
    // Sem rede: a recusa é de desenho, não de catálogo.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("o Jev é aceito sem consultar o catálogo — o padrão não depende de rede", async () => {
    const fetchImpl = vi.fn();
    const conferido = await conferirModeloDaConfig({
      modelo: MODELO_NA_OPENROUTER,
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });
    // Gravado como o PADRÃO (ausência do campo), e não como texto: doc 369.
    expect(conferido).toEqual({ ok: true, modelo: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("o nome do Jev no formato da TypeSafe também vira o padrão — nunca sai pela OpenRouter", async () => {
    const fetchImpl = vi.fn();
    const conferido = await conferirModeloDaConfig({
      modelo: MODELO_DA_TYPESAFE,
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });
    expect(conferido).toEqual({ ok: true, modelo: null });
    // E um nome do Jev que já estivesse gravado resolve para o da origem.
    expect(modeloDaChamada({ origem: "openrouter", modelo: MODELO_DA_TYPESAFE })).toBe(MODELO_NA_OPENROUTER);
  });

  it("o fornecedor nomeado no aceite é o prefixo do id; o Jev é da TypeSafe AI", () => {
    expect(fornecedorDoModelo("perplexity/decisor:free")).toBe("perplexity");
    expect(fornecedorDoModelo(MODELO_NA_OPENROUTER)).toBe("TypeSafe AI");
    expect(fornecedorDoModelo(MODELO_DA_TYPESAFE)).toBe("TypeSafe AI");
  });

  it("`null` volta ao padrão sem rede", async () => {
    const fetchImpl = vi.fn();
    const conferido = await conferirModeloDaConfig({
      modelo: null,
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });
    expect(conferido).toEqual({ ok: true, modelo: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("(d) provedor fora do ar cai no padrão e o turno continua", () => {
  it("modelo escolhido indisponível: o Jev responde e o resultado volta ok", async () => {
    banco.settings = ligadoCom(MODELO_DE_FORA);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/alpha/decisions")) return new Response("upstream fora", { status: 502 });
      return ok(CORPO_OK, MODELO_NA_OPENROUTER);
    });

    const r = await decidirNoPonto(
      { ponto: "sentiment_classify", organizationId: ORG, estado: "adorei!", perguntas: PERGUNTAS },
      { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: "https://openrouter.ai/api" },
    );

    // O turno continua: nada lança, e a resposta do Jev vale.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelo).toBe(MODELO_NA_OPENROUTER);
    const urls = fetchImpl.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual([
      "https://openrouter.ai/api/alpha/decisions",
      "https://openrouter.ai/api/v1/systemone",
    ]);
  });

  it("catálogo fora do ar na escrita: recusa com a frase do conserto, e nada muda", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const conferido = await conferirModeloDaConfig({
      modelo: MODELO_DE_FORA,
      origem: "openrouter",
      deps: { fetchImpl, baseUrl: "https://openrouter.ai/api" },
    });

    expect(conferido.ok).toBe(false);
    if (conferido.ok) return;
    expect(conferido.motivo).toBe("jev_catalogo_fora");
    expect(conferido.mensagem).toContain("Jev continua como padrão");
  });

  it("o catálogo fica em cache curto: dois pedidos, um GET", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(catalogoCom([{ id: MODELO_DE_FORA, output_modalities: ["decisions"] }]));
    const base = "https://openrouter.ai/api";
    const agora = 1_000_000;
    await listarModelosDeDecisao({ fetchImpl, baseUrl: base, agora });
    await listarModelosDeDecisao({ fetchImpl, baseUrl: base, agora: agora + CACHE_DO_CATALOGO_MS - 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Vencido o cache, a lista é buscada de novo.
    await listarModelosDeDecisao({ fetchImpl, baseUrl: base, agora: agora + CACHE_DO_CATALOGO_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
