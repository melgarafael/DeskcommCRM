import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), renovar: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/google/config", () => ({
  configuracaoDoGoogleAds: mocks.config,
}));
vi.mock("@/lib/plataformas-de-anuncio/google/token", () => ({ renovarToken: mocks.renovar }));

const {
  classificarRecusa,
  conferirContaDeRelatorio,
  criarAcaoDeConversao,
  listarAcoesDeConversao,
  lerCampanhas,
  listarRecursosDeMensagem,
} = await import("@/lib/plataformas-de-anuncio/google/api-google-ads");

const conexao = { refreshToken: "r", customerId: "1234567890", loginCustomerId: "9998887776" };

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.config.mockReturnValue({
    clientId: "c",
    clientSecret: "s",
    developerToken: "dev",
    redirectUri: "https://x/cb",
  });
  mocks.renovar.mockResolvedValue({ ok: true, token: { access_token: "AT" } });
});

describe("recusas do Google em linguagem de quem opera", () => {
  it("indica o projeto Cloud quando falta acesso a anunciantes de produção", () => {
    expect(classificarRecusa(403, { error: { message: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } }).falha)
      .toBe("projeto_sem_acesso");
  });
  it("escopo insuficiente pede reconexão", () => {
    expect(
      classificarRecusa(403, {
        error: {
          status: "PERMISSION_DENIED",
          message: "Request had insufficient authentication scopes.",
        },
      }).falha,
    ).toBe("reconectar");
  });
  it("developer token não aprovado é dito como tal", () => {
    expect(
      classificarRecusa(403, {
        error: {
          details: [
            { errors: [{ errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } }] },
          ],
        },
      }).falha,
    ).toBe("sem_developer_token");
  });
  it("5xx e 429 são transitórios; permissão negada aponta para conta e MCC", () => {
    expect(classificarRecusa(503, null).falha).toBe("transitorio");
    expect(classificarRecusa(429, null).falha).toBe("transitorio");
    expect(classificarRecusa(403, { error: { message: "USER_PERMISSION_DENIED" } }).falha).toBe(
      "sem_permissao",
    );
  });
});

describe("ações de conversão", () => {
  it("sem developer token nem chama o Google", async () => {
    mocks.config.mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await listarAcoesDeConversao(conexao)).toMatchObject({
      ok: false,
      falha: "sem_developer_token",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("cria ação de importação de cliques com sufixo, categoria e headers de conta gerente", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [{ resourceName: "customers/1234567890/conversionActions/555" }],
          }),
          { status: 200 },
        ),
      );
    const r = await criarAcaoDeConversao(conexao, {
      nome: "Lead qualificado",
      categoria: "QUALIFIED_LEAD",
      incluirEmConversoes: false,
      sufixo: "ab12c",
    });
    expect(r).toEqual({ ok: true, dados: { id: "555", nome: "Lead qualificado #ab12c" } });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/customers\/1234567890\/conversionActions:mutate$/);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["developer-token"]).toBe("dev");
    expect(headers["login-customer-id"]).toBe("9998887776");
    expect(headers.authorization).toBe("Bearer AT");
    const corpo = JSON.parse(String((init as RequestInit).body));
    expect(corpo.operations[0].create).toMatchObject({
      name: "Lead qualificado #ab12c",
      type: "UPLOAD_CLICKS",
      category: "QUALIFIED_LEAD",
      primaryForGoal: false,
      status: "ENABLED",
    });
  });
  it("lista só o que o Google devolveu em forma válida", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              conversionAction: {
                id: "1",
                name: "Compra",
                category: "PURCHASE",
                type: "UPLOAD_CLICKS",
                status: "ENABLED",
                primaryForGoal: true,
              },
            },
            { lixo: true },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await listarAcoesDeConversao(conexao)).toEqual({
      ok: true,
      dados: [
        {
          id: "1",
          nome: "Compra",
          categoria: "PURCHASE",
          tipo: "UPLOAD_CLICKS",
          status: "ENABLED",
          primaria: true,
        },
      ],
    });
  });
});

describe("campanhas e recursos de mensagem", () => {
  it("consulta a conta com OAuth sem developer token e encaminha o MCC somente quando informado", async () => {
    mocks.config.mockReturnValue({ clientId: "c", clientSecret: "s", developerToken: "" });
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    expect(await lerCampanhas(conexao, { de: "2026-01-01", ate: "2026-01-02" })).toEqual({ ok: true, dados: [] });
    expect(mocks.config).toHaveBeenCalledWith("relatorio");
    expect(http.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json", authorization: "Bearer AT", "login-customer-id": conexao.loginCustomerId,
    });
    http.mockResolvedValueOnce(Response.json({ results: [{ customer: { id: conexao.customerId } }] }));
    expect(await conferirContaDeRelatorio("novo", conexao.customerId, null)).toMatchObject({ ok: true });
    const [url, init] = http.mock.calls[1]!;
    expect(String(url)).toContain("/customers/1234567890/googleAds:search");
    expect(init?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer novo" });
    expect(JSON.parse(String(init?.body)).query).toContain("FROM customer");
  });
  it.each([{ id: "1111111111" }, { id: "1234567890", manager: true }])(
    "recusa autorizar uma conta diferente ou gerenciadora", async (customer) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ results: [{ customer }] }));
      expect(await conferirContaDeRelatorio("novo", conexao.customerId, null)).toMatchObject({ ok: false, falha: "sem_permissao" });
    },
  );
  it("converte micros na moeda retornada pela conta e recusa período malformado sem chamar o Google", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              campaign: { id: "7", name: "Busca", status: "ENABLED" },
              customer: { currencyCode: "EUR", timeZone: "Europe/Madrid" },
              metrics: {
                impressions: "1000",
                clicks: "50",
                costMicros: "12345000",
                conversions: 3,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await lerCampanhas(conexao, { de: "2026-09-01", ate: "2026-09-27" })).toEqual({
      ok: true,
      dados: [
        {
          id: "7",
          nome: "Busca",
          status: "ENABLED",
          moeda: "EUR",
          fuso: "Europe/Madrid",
          impressoes: 1000,
          cliques: 50,
          custo: 12.345,
          conversoes: 3,
        },
      ],
    });
    fetchSpy.mockClear();
    expect(
      await lerCampanhas(conexao, { de: "2026-09-01' OR 1=1", ate: "2026-09-27" }),
    ).toMatchObject({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("recursos de mensagem sem mensagem inicial são descartados", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              asset: {
                id: "1",
                name: "Orçamento",
                businessMessageAsset: {
                  starterMessage: "Quero um orçamento",
                  whatsappInfo: { countryCode: "55", phoneNumber: "31972004739" },
                },
              },
            },
            { asset: { id: "2", businessMessageAsset: {} } },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await listarRecursosDeMensagem(conexao)).toEqual({
      ok: true,
      dados: [
        {
          id: "1",
          nome: "Orçamento",
          mensagemInicial: "Quero um orçamento",
          telefone: "5531972004739",
        },
      ],
    });
  });
});
