import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  transporteGoogle,
  lerResultadoDoUpload,
} from "@/lib/plataformas-de-anuncio/google/conversions";
import {
  enviarDataManager,
  consultarDataManager,
} from "@/lib/plataformas-de-anuncio/google/data-manager";
import { transporteMeta } from "@/lib/plataformas-de-anuncio/meta/conversions";
import { montarUrlDeConsentimento } from "@/lib/plataformas-de-anuncio/google/oauth";
import { emitirEstado, verificarEstado } from "@/lib/plataformas-de-anuncio/google/estado";
import type { ConversaoOffline, CredencialDeConversao } from "@/lib/plataformas-de-anuncio/types";

vi.mock("@/lib/plataformas-de-anuncio/google/config", () => ({
  configuracaoDoGoogleAds: () => ({
    clientId: "cid",
    clientSecret: "segredo-teste",
    developerToken: "dev-teste",
    redirectUri: "https://example.test/callback",
  }),
}));
vi.mock("@/lib/plataformas-de-anuncio/google/token", () => ({
  renovarToken: async () => ({ ok: true, token: { access_token: "token-teste" } }),
}));

const credencial: CredencialDeConversao = {
  datasetId: "1234567890",
  accessToken: "meta-teste",
  testEventCode: null,
  google: {
    api: "data_manager",
    refreshToken: "refresh-teste",
    customerId: "1234567890",
    loginCustomerId: "0987654321",
    conversionActionId: "42",
  },
};
const conversao: ConversaoOffline = {
  organizationId: "org",
  leadId: "lead",
  evento: "Purchase",
  eventoId: "lead:Purchase",
  ocorridoEm: new Date(),
  cliqueDeOrigem: "click-test",
  telefone: null,
  valorCentavos: 12990,
  moeda: "BRL",
};
const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });
const destino = { operatingAccount: { accountId: "1234567890" }, productDestinationId: "42" };
const status = (requestStatus: string) => ({
  requestStatusPerDestination: [{ requestStatus, destination: destino }],
});
afterEach(() => vi.restoreAllMocks());

describe("entrega de conversões", () => {
  it("envia ao Data Manager com valor e ID estável, sem developer-token e sem consentimento inventado", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(resposta({ requestId: "protocolo" }));
    expect(await transporteGoogle.enviar(credencial, conversao)).toMatchObject({
      tipo: "processando",
      protocolo: "protocolo",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://datamanager.googleapis.com/v1/events:ingest");
    const body = JSON.parse(String(init?.body));
    expect(body.destinations[0]).toMatchObject({
      operatingAccount: { accountId: "1234567890", accountType: "GOOGLE_ADS" },
      loginAccount: { accountId: "0987654321" },
      productDestinationId: "42",
    });
    expect(body.events[0]).toMatchObject({
      transactionId: "lead:Purchase",
      conversionValue: 129.9,
      eventSource: "MESSAGE",
      adIdentifiers: { gclid: "click-test" },
    });
    expect(body).not.toHaveProperty("consent");
    expect(init?.headers).not.toHaveProperty("developer-token");
  });
  it("HTTP 200 sem protocolo não é sucesso", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(resposta({}));
    expect(await enviarDataManager(credencial, conversao)).toMatchObject({ tipo: "transitorio" });
  });
  it.each([
    [429, "transitorio"],
    [503, "transitorio"],
    [403, "permanente"],
  ])("HTTP %s recebe classificação %s", async (http, tipo) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      resposta({ error: "dado que não deve vazar" }, Number(http)),
    );
    const resultado = await enviarDataManager(credencial, conversao);
    expect(resultado.tipo).toBe(tipo);
    expect(JSON.stringify(resultado)).not.toContain("dado que não deve vazar");
  });
  it("consulta o protocolo sem outro POST e só conclui após SUCCESS", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(resposta(status("PROCESSING")))
      .mockResolvedValueOnce(resposta(status("SUCCESS")));
    expect(await consultarDataManager(credencial, "p/1")).toMatchObject({ tipo: "processando" });
    expect(await consultarDataManager(credencial, "p/1")).toMatchObject({ tipo: "ok" });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(String(fetch.mock.calls[0]![0])).toContain("requestId=p%2F1");
  });
  it("rejeição assíncrona não vira sucesso e libera uma nova tentativa corrigida", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(resposta(status("FAILED")));
    expect(await consultarDataManager(credencial, "p")).toMatchObject({
      tipo: "permanente",
      rejeicaoConfirmada: true,
    });
  });
  it("não aceita diagnóstico de outra conta", async () => {
    const r = status("SUCCESS");
    r.requestStatusPerDestination[0]!.destination = {
      ...destino,
      operatingAccount: { accountId: "outra" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(resposta(r));
    expect(await consultarDataManager(credencial, "p")).toMatchObject({ tipo: "permanente" });
  });
  it("legado pede falha parcial e lê a rejeição mesmo com HTTP 200", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      resposta({
        partialFailureError: {
          code: 3,
          details: [{ errors: [{ errorCode: { conversionUploadError: "INVALID_GCLID" } }] }],
        },
        results: [{}],
      }),
    );
    const resultado = await transporteGoogle.enviar(
      { ...credencial, google: { ...credencial.google!, api: "google_ads" } },
      conversao,
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).partialFailure).toBe(true);
    expect(resultado).toMatchObject({ tipo: "permanente" });
    expect(JSON.stringify(resultado)).toContain("INVALID_GCLID");
  });
  it("só confirma upload legado com resultado explícito", () => {
    expect(lerResultadoDoUpload({}).tipo).toBe("transitorio");
    expect(
      lerResultadoDoUpload({
        results: [{ conversionAction: "customers/123/conversionActions/42" }],
      }).tipo,
    ).toBe("ok");
  });
  it("Meta exige o recibo de um evento, não apenas HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(resposta({}))
      .mockResolvedValueOnce(resposta({ events_received: 1 }));
    expect((await transporteMeta.enviar(credencial, conversao)).tipo).toBe("transitorio");
    expect((await transporteMeta.enviar(credencial, conversao)).tipo).toBe("ok");
  });
});

describe("consentimento para a API escolhida", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("pede o escopo Data Manager e mantém a escolha assinada no retorno", () => {
    const agora = new Date();
    const segredo = "segredo-local-longo-de-teste";
    const state = emitirEstado(
      { organizationId: "org", userId: "user", api: "data_manager" },
      { agora, segredo },
    );
    expect(verificarEstado(state, { agora, segredo })?.api).toBe("data_manager");
    const url = montarUrlDeConsentimento(
      { clientId: "cid", redirectUri: "https://example.test/cb" },
      { state, api: "data_manager" },
    );
    expect(new URL(url).searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/datamanager",
    );
  });
});
