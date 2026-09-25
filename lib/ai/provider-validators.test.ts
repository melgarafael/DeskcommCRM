import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A base do OpenRouter é lida de `env` — este mock é quem decide se a variável
 * existe em cada caso. Sem ele o `.env` de quem roda o teste mandaria no
 * resultado, e o caso "sem a variável" mentiria numa máquina com
 * `OPENROUTER_BASE_URL` definida.
 */
const envMock: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

import { validateOpenRouterKey, validateProviderKey, validateTypeSafeKey } from "@/lib/ai/provider-validators";

/**
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * O validador da OpenRouter chamava `/api/v1/models`, que é PÚBLICO: ele
 * responde 200 sem header nenhum. Qualquer string era gravada como credencial
 * validada, e a falha só aparecia no primeiro turno do agente — como
 * `runtime_error: User not found.`, mensagem que não fala de credencial.
 *
 * O caso decisivo é o último do primeiro bloco: ele prende o ENDEREÇO da
 * primeira chamada. Sem ele, alguém "simplifica" o validador de volta para uma
 * requisição só, o catálogo responde 200 para chave falsa, e os dois primeiros
 * casos aqui continuariam verdes — a família do teste que concorda com o próprio
 * defeito.
 *
 * O segundo bloco prende o MESMO endereço onde a instalação o configurou: a
 * tela de Credenciais era o último caminho que ainda batia em `openrouter.ai`
 * fixo depois de `OPENROUTER_BASE_URL` valer para o agente, para o turno do
 * worker e para a prova de crédito. Num gateway compatível, a tela dizia
 * "chave inválida" com a credencial que o agente estava usando.
 */

const chamadas: string[] = [];

function fetchFalso(respostas: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (url: string) => {
    chamadas.push(url);
    const chave = Object.keys(respostas).find((k) => url.includes(k));
    const r = chave ? respostas[chave]! : { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as unknown as Response;
  });
}

beforeEach(() => {
  // Quem define a variável é o caso; nenhum caso herda a do anterior.
  delete envMock.OPENROUTER_BASE_URL;
  delete envMock.JEV_API_BASE_URL;
});

afterEach(() => {
  chamadas.length = 0;
  vi.unstubAllGlobals();
});

describe("validateOpenRouterKey", () => {
  it("recusa a chave que a OpenRouter não reconhece", async () => {
    // Era ESTE o caso que passava: /api/v1/models devolve 200 para qualquer um.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/api/v1/key": { status: 401 }, "/api/v1/models": { status: 200 } }),
    );
    const r = await validateOpenRouterKey("sk-or-...iste");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("auth_failed_401");
  });

  it("aceita a chave boa e devolve o catálogo", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({
        "/api/v1/key": { status: 200, body: { data: { label: "x" } } },
        "/api/v1/models": { status: 200, body: { data: [{ id: "minimax/minimax-m3:free" }] } },
      }),
    );
    const r = await validateOpenRouterKey("sk-or-v1-boa");
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.models).toEqual(["minimax/minimax-m3:free"]);
  });

  it("catálogo fora do ar não recusa chave que já provou ser válida", async () => {
    // Trocar erro de credencial por erro de disponibilidade faria o operador
    // caçar defeito na chave certa.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/api/v1/key": { status: 200 }, "/api/v1/models": { status: 503 } }),
    );
    const r = await validateOpenRouterKey("sk-or-v1-boa");
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.models).toEqual([]);
  });

  it("a PROVA é o endpoint autenticado, e é o primeiro a ser chamado", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/api/v1/key": { status: 200 }, "/api/v1/models": { status: 200 } }),
    );
    await validateOpenRouterKey("sk-or-v1-boa");
    expect(chamadas[0]).toContain("/api/v1/key");
  });
});

describe("a base do OpenRouter vem de OPENROUTER_BASE_URL", () => {
  const raiz = "https://gateway.interno.exemplo";
  const comApiV1 = `${raiz}/api/v1`;

  it("a URL chamada muda com a variável e volta ao default sem ela", async () => {
    // O defeito do #1238: sem a variável, as duas chamadas eram idênticas às de
    // baixo — a instalação apontada para um gateway batia na openrouter.ai.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/key": { status: 200 }, "/models": { status: 200, body: { data: [] } } }),
    );

    envMock.OPENROUTER_BASE_URL = comApiV1;
    const comGateway = await validateOpenRouterKey("sk-or-v1-boa");
    expect(comGateway.ok).toBe(true);

    delete envMock.OPENROUTER_BASE_URL;
    const semGateway = await validateOpenRouterKey("sk-or-v1-boa");
    expect(semGateway.ok).toBe(true);

    expect(chamadas).toEqual([
      `${comApiV1}/key`,
      `${comApiV1}/models`,
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models",
    ]);
  });

  it("sem a variável, o endereço é o da OpenRouter", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/key": { status: 200 }, "/models": { status: 200, body: { data: [] } } }),
    );
    await validateOpenRouterKey("sk-or-v1-boa");
    expect(chamadas).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models",
    ]);
  });

  it("variável vazia (é o que o .env.example entrega) não monta endereço relativo", async () => {
    // `OPENROUTER_BASE_URL=` sem valor no .env: `"" + "/key"` seria `/key`, uma
    // URL relativa que o fetch resolve contra a origem do app.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/key": { status: 200 }, "/models": { status: 200, body: { data: [] } } }),
    );
    envMock.OPENROUTER_BASE_URL = "";
    await validateOpenRouterKey("sk-or-v1-boa");
    expect(chamadas).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models",
    ]);
  });

  it("a variável pode ser a raiz: nenhum /api/v1 é acrescentado", async () => {
    // Quem aponta para a raiz de um gateway que serve /chat/completions na raiz
    // tem o mesmo direito aqui, como na prova de crédito da instalação.
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/key": { status: 200 }, "/models": { status: 200, body: { data: [] } } }),
    );
    envMock.OPENROUTER_BASE_URL = raiz;
    await validateOpenRouterKey("sk-or-v1-boa");
    expect(chamadas).toEqual([`${raiz}/key`, `${raiz}/models`]);
  });

  it("barra final na variável não produz barra dupla na junção", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({ "/key": { status: 200 }, "/models": { status: 200, body: { data: [] } } }),
    );
    envMock.OPENROUTER_BASE_URL = `${comApiV1}/`;
    await validateOpenRouterKey("sk-or-v1-boa");
    expect(chamadas).toEqual([`${comApiV1}/key`, `${comApiV1}/models`]);
  });
});

describe("gateway customizado via OPENROUTER_BASE_URL sem /key (#1376)", () => {
  const customBase = "https://custom-gateway.internal/v1";

  it("quando /key dá 404 em gateway customizado, valida pelo catálogo /models", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({
        "/key": { status: 404 },
        "/models": { status: 200, body: { data: [{ id: "custom/llama-3.3-70b" }] } },
      }),
    );
    envMock.OPENROUTER_BASE_URL = customBase;
    const r = await validateOpenRouterKey("sk-custom-key");
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.models).toEqual(["custom/llama-3.3-70b"]);
    expect(chamadas).toEqual([`${customBase}/key`, `${customBase}/models`]);
  });

  it("quando /key dá 404 e /models recusa a credencial com 401, retorna auth_failed_401", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({
        "/key": { status: 404 },
        "/models": { status: 401 },
      }),
    );
    envMock.OPENROUTER_BASE_URL = customBase;
    const r = await validateOpenRouterKey("sk-invalid-key");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("auth_failed_401");
  });

  it("quando /key dá 404 no OpenRouter oficial (sem OPENROUTER_BASE_URL), mantém provider_status_404", async () => {
    vi.stubGlobal(
      "fetch",
      fetchFalso({
        "/key": { status: 404 },
        "/models": { status: 200, body: { data: [] } },
      }),
    );
    delete envMock.OPENROUTER_BASE_URL;
    const r = await validateOpenRouterKey("sk-or-v1-any");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("provider_status_404");
  });
});


/**
 * O JEV (TypeSafe AI) prova a chave por `GET /v1/models`, que EXIGE credencial
 * e não gasta token. Medido contra a API real: 401 com chave falsa, 403 sem
 * chave, 200 com a real no formato `{ models: [{ name, ... }] }` — diferente do
 * `{ data: [{ id }] }` dos outros, e é por isso que o nome do campo está preso.
 */
describe("validateTypeSafeKey", () => {
  // O catálogo real (medido em 2026-09-23 com a chave paga) lista só os
  // APELIDOS — a versão fixada `jev-1.13.0` não aparece aqui, embora o POST a
  // aceite. `models_available` não serve para conferir a versão fixada.
  const CATALOGO = {
    models: [
      { name: "jev-latest", description: "x", release_date: "2026-09-01" },
      { name: "jev-preview", description: "x", release_date: "2026-09-01" },
    ],
  };

  it("chave boa: bate no endpoint AUTENTICADO, com Bearer, e devolve os nomes", async () => {
    const fetchFalsoJev = vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer apikey_boa");
      return { ok: true, status: 200, json: async () => CATALOGO } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchFalsoJev);
    const r = await validateTypeSafeKey("apikey_boa");
    expect(r).toEqual({ ok: true, models: ["jev-latest", "jev-preview"] });
    expect(chamadas).toEqual(["https://api.typesafe.ai/v1/models"]);
  });

  it.each([401, 403])("HTTP %i é chave recusada, no vocabulário da tela", async (status) => {
    vi.stubGlobal("fetch", fetchFalso({ "/v1/models": { status } }));
    const r = await validateTypeSafeKey("apikey_ruim");
    expect(r).toEqual({ ok: false, error: "auth_failed_401" });
  });

  it("outra falha do fornecedor não é confundida com chave ruim", async () => {
    vi.stubGlobal("fetch", fetchFalso({ "/v1/models": { status: 503 } }));
    expect(await validateTypeSafeKey("apikey_x")).toEqual({ ok: false, error: "provider_status_503" });
  });

  it("o endereço segue a instalação (o dublê do e2e valida pelo mesmo caminho)", async () => {
    envMock.JEV_API_BASE_URL = "http://127.0.0.1:4010/";
    vi.stubGlobal("fetch", fetchFalso({ "/v1/models": { status: 200, body: CATALOGO } }));
    await validateTypeSafeKey("apikey_x");
    expect(chamadas).toEqual(["http://127.0.0.1:4010/v1/models"]);
  });

  it("o despacho por provedor chega nele (não cai em unknown_provider)", async () => {
    vi.stubGlobal("fetch", fetchFalso({ "/v1/models": { status: 401 } }));
    const r = await validateProviderKey("typesafe", "apikey_x");
    expect(r).toEqual({ ok: false, error: "auth_failed_401" });
    expect(chamadas).toEqual(["https://api.typesafe.ai/v1/models"]);
  });
});
