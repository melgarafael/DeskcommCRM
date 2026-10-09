/**
 * O PINO GANHA RUA, BAIRRO E CIDADE APROXIMADOS — quando a organização tem a
 * chave de Mapas (migration 0504).
 *
 * Medido numa loja (28/09/2026): 10 de 10 pinos do mês chegaram só com
 * coordenadas, e o agente lia um link sem saber a cidade. As respostas do
 * Google abaixo têm a FORMA das reais (medidas em 28/09 numa instalação), com
 * lugares públicos no lugar dos pinos de clientes.
 *
 * O que este arquivo prende:
 * - a leitura da resposta: a cidade é o MUNICÍPIO, sem bairro nem número —
 *   medido contra 8 pedidos confirmados (município 8/8, bairro 1/8, número
 *   interpolado) —, e os erros que pedem ações diferentes de quem configura
 *   (API não habilitada × chave recusada);
 * - o corpo do pino — o que o agente lê — com "(aprox.)", e IDÊNTICO ao de
 *   antes quando não há endereço;
 * - o recebimento do pino: sem chave, nenhuma chamada ao Google; com chave, o
 *   endereço entra; Google fora do ar, o pino entra como antes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { completarLocalizacao } from "@/lib/channels/zernio/localizacao";
import { resolveZernioCreds } from "@/lib/channels/zernio/credentials";
import type { ZernioInboundMessage } from "@/lib/channels/zernio/webhook";
import {
  geocodificarReverso,
  idiomaDaConsulta,
  lerRespostaDoGoogle,
  textoDoEnderecoAproximado,
} from "@/lib/mapas/geocodificacao";
import { corpoDaLocalizacao, lerLocalizacao } from "@/lib/messaging/localizacao";

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  resolveZernioCreds: vi.fn(),
}));

const comp = (long_name: string, ...types: string[]) => ({ long_name, short_name: long_name, types });

/** O primeiro resultado já é a rua com número (e bairro, que não sai). */
const CURITIBA = {
  status: "OK",
  results: [
    {
      types: ["premise", "street_address"],
      address_components: [
        comp("1000", "street_number"),
        comp("Rua XV de Novembro", "route"),
        comp("Centro", "sublocality_level_1", "sublocality", "political"),
        comp("Curitiba", "locality", "political"),
        comp("Curitiba", "administrative_area_level_2", "political"),
        comp("Paraná", "administrative_area_level_1", "political"),
        comp("Brasil", "country", "political"),
      ],
    },
  ],
};

/** O primeiro resultado é um estabelecimento SEM bairro nem município; o segundo tem o bairro. */
const SAO_PAULO = {
  status: "OK",
  results: [
    {
      types: ["establishment", "point_of_interest"],
      address_components: [
        comp("100", "street_number"),
        comp("Praça da Sé", "route"),
        comp("São Paulo", "locality", "political"),
        comp("São Paulo", "administrative_area_level_1", "political"),
      ],
    },
    {
      types: ["neighborhood", "political"],
      address_components: [
        comp("Sé", "sublocality_level_1", "sublocality", "political"),
        comp("São Paulo", "locality", "political"),
      ],
    },
  ],
};

describe("a resposta do Google vira endereço aproximado", () => {
  it("rua, cidade e estado — sem bairro nem número", () => {
    const r = lerRespostaDoGoogle(CURITIBA);
    expect(r).toEqual({ ok: true, endereco: { rua: "Rua XV de Novembro", cidade: "Curitiba", regiao: "Paraná" } });
    expect(r.ok && textoDoEnderecoAproximado(r.endereco)).toBe("Rua XV de Novembro, Curitiba, Paraná");
  });

  it("o estado igual à cidade não se repete, e sem município vale a localidade", () => {
    const r = lerRespostaDoGoogle(SAO_PAULO);
    expect(r.ok && textoDoEnderecoAproximado(r.endereco)).toBe("Praça da Sé, São Paulo");
  });

  it("⭐ zona rural: a cidade é o MUNICÍPIO, não o povoado que o Google chama de localidade", () => {
    // Medido num pedido confirmado (28/09/2026): a `locality` era o povoado, o
    // `administrative_area_level_2` era o município — e o cliente escreveu o município.
    const r = lerRespostaDoGoogle({
      status: "OK",
      results: [
        {
          address_components: [
            comp("Estrada Municipal", "route"),
            comp("Vila Rural", "neighborhood", "political"),
            comp("Povoado Boa Vista", "locality", "political"),
            comp("Município Exemplo", "administrative_area_level_2", "political"),
            comp("Minas Gerais", "administrative_area_level_1", "political"),
          ],
        },
      ],
    });
    expect(r.ok && textoDoEnderecoAproximado(r.endereco)).toBe("Estrada Municipal, Município Exemplo, Minas Gerais");
  });

  it("\"Unnamed Road\" não é rua, e \"Canelones Department\" é Canelones", () => {
    // As duas formas medidas em pinos reais de 28/09: a rua sem nome e o
    // departamento em inglês mesmo com `language=es`.
    const r = lerRespostaDoGoogle({
      status: "OK",
      results: [
        {
          address_components: [
            comp("Unnamed Road", "route"),
            comp("Pando", "administrative_area_level_2", "political"),
            comp("Canelones Department", "administrative_area_level_1", "political"),
          ],
        },
      ],
    });
    expect(r).toEqual({ ok: true, endereco: { cidade: "Pando", regiao: "Canelones" } });
  });

  it("⭐ API não habilitada e chave recusada são motivos DIFERENTES — pedem ações diferentes", () => {
    // Texto real de 28/09/2026, com a Geocoding API ainda desligada no projeto.
    expect(
      lerRespostaDoGoogle({ status: "REQUEST_DENIED", error_message: "This API is not activated on your API project." }),
    ).toMatchObject({ ok: false, motivo: "api_desativada" });
    expect(
      lerRespostaDoGoogle({ status: "REQUEST_DENIED", error_message: "The provided API key is invalid." }),
    ).toMatchObject({ ok: false, motivo: "chave_recusada" });
    expect(lerRespostaDoGoogle({ status: "ZERO_RESULTS", results: [] })).toMatchObject({ ok: false, motivo: "sem_resultado" });
    expect(lerRespostaDoGoogle({ status: "OVER_QUERY_LIMIT" })).toMatchObject({ ok: false, motivo: "cota" });
    expect(lerRespostaDoGoogle("lixo")).toMatchObject({ ok: false, motivo: "desconhecido" });
  });

  it("OK sem nenhum componente útil não inventa endereço", () => {
    expect(lerRespostaDoGoogle({ status: "OK", results: [{ address_components: [comp("Brasil", "country")] }] })).toEqual({
      ok: false,
      motivo: "sem_resultado",
    });
  });

  it("o idioma dos nomes segue o da organização, pelo registro de idiomas", () => {
    expect(idiomaDaConsulta("es")).toBe("es");
    expect(idiomaDaConsulta("es-MX")).toBe("es");
    expect(idiomaDaConsulta("pt-BR")).toBe("pt-BR");
    expect(idiomaDaConsulta(null)).toBe("pt-BR");
    // Um idioma que o produto não serve cai no padrão, como na tela.
    expect(idiomaDaConsulta("xx-YY")).toBe("pt-BR");
  });
});

describe("a chamada ao Google", () => {
  it("manda coordenadas, idioma e chave; não lança em rede fora nem em resposta sem JSON", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(CURITIBA), { status: 200 }));
    const r = await geocodificarReverso("CHAVE", { latitude: -25.4284, longitude: -49.2733 }, { idioma: "es", fetchImpl: f as never });
    expect(r.ok).toBe(true);
    const url = new URL(String((f.mock.calls[0] as unknown[])[0]));
    expect(url.host).toBe("maps.googleapis.com");
    expect(url.searchParams.get("latlng")).toBe("-25.4284,-49.2733");
    expect(url.searchParams.get("language")).toBe("es");
    expect(url.searchParams.get("key")).toBe("CHAVE");

    const fora = vi.fn(async () => {
      throw new DOMException("tempo", "TimeoutError");
    });
    expect(await geocodificarReverso("CHAVE", { latitude: 1, longitude: 2 }, { fetchImpl: fora as never })).toMatchObject({
      ok: false,
      motivo: "rede",
    });
    const html = vi.fn(async () => new Response("<html>", { status: 502 }));
    expect(await geocodificarReverso("CHAVE", { latitude: 1, longitude: 2 }, { fetchImpl: html as never })).toMatchObject({
      ok: false,
      motivo: "rede",
    });
  });
});

describe("o corpo do pino — o que o agente lê", () => {
  it("⭐ com endereço aproximado: marcado (aprox.), antes do link", () => {
    const loc = { latitude: -25.4284, longitude: -49.2733, aproximado: { rua: "Rua XV de Novembro", cidade: "Curitiba", regiao: "Paraná" } };
    expect(corpoDaLocalizacao(loc)).toBe("📍 Rua XV de Novembro, Curitiba, Paraná (aprox.) — https://maps.google.com/?q=-25.4284,-49.2733");
  });

  it("controle: sem endereço aproximado, o corpo é o mesmo de antes", () => {
    expect(corpoDaLocalizacao({ latitude: -23.55, longitude: -46.63 })).toBe("📍 https://maps.google.com/?q=-23.55,-46.63");
  });

  it("o endereço gravado no metadata volta na leitura (a tela o mostra), e lixo nele é ignorado", () => {
    const lida = lerLocalizacao({ latitude: -23.55, longitude: -46.63, aproximado: { cidade: "Osasco", bairro: 7, x: "y" } });
    expect(lida?.aproximado).toEqual({ cidade: "Osasco" });
    expect(lerLocalizacao({ latitude: -23.55, longitude: -46.63, aproximado: {} })?.aproximado).toBeUndefined();
  });
});

// ─── o recebimento do pino (Zernio), de ponta a ponta com rede de mentira ─────

const ORG = "11111111-1111-1111-1111-111111111111";

const PINO = {
  direction: "inbound",
  kind: "message",
  conversationId: "conv",
  externalId: "wamid.X",
  accountId: "acc_1",
  text: "📍 Location",
  attachments: [],
  sentAt: null,
  identity: {},
} as unknown as ZernioInboundMessage;

function adminFalso(opcoes: { temChave: boolean }) {
  const rpc = vi.fn(async (nome: string) => ({ data: nome === "fn_decrypt_oauth" ? "CHAVE_DE_MAPAS" : null, error: null }));
  return {
    rpc,
    from(tabela: string) {
      const linhas: Record<string, unknown> = {
        map_provider_credentials: opcoes.temChave ? { api_key_encrypted: "\\xabc" } : null,
        organizations: { locale: "es" },
      };
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      };
      return q;
    },
  };
}

function redeFalsa(google: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("maps.googleapis.com")) return google();
    return new Response(
      JSON.stringify({ status: "success", messages: [{ id: "wamid.X", metadata: { location: { latitude: -25.4284, longitude: -49.2733 } } }] }),
      { status: 200 },
    );
  });
}

describe("o pino que chega pelo canal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("⭐ com a chave de Mapas: o pino entra com rua, cidade e estado", async () => {
    vi.mocked(resolveZernioCreds).mockResolvedValue({ accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session" });
    const f = redeFalsa(() => new Response(JSON.stringify(CURITIBA), { status: 200 }));
    const msg = await completarLocalizacao(adminFalso({ temChave: true }) as never, ORG, PINO);
    expect(msg.location?.aproximado).toEqual({ rua: "Rua XV de Novembro", cidade: "Curitiba", regiao: "Paraná" });
    expect(corpoDaLocalizacao(msg.location!)).toContain("Rua XV de Novembro, Curitiba, Paraná (aprox.)");
    const google = f.mock.calls.find(([u]) => String(u).includes("maps.googleapis.com"));
    expect(new URL(String(google![0])).searchParams.get("language")).toBe("es");
  });

  it("⭐ sem chave: nenhuma chamada ao Google, e o pino é o de antes", async () => {
    vi.mocked(resolveZernioCreds).mockResolvedValue({ accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session" });
    const f = redeFalsa(() => new Response("{}", { status: 200 }));
    const msg = await completarLocalizacao(adminFalso({ temChave: false }) as never, ORG, PINO);
    expect(msg.location).toEqual({ latitude: -25.4284, longitude: -49.2733 });
    expect(f.mock.calls.some(([u]) => String(u).includes("maps.googleapis.com"))).toBe(false);
  });

  it("Google recusando ou fora do ar: o pino entra com as coordenadas, sem endereço", async () => {
    vi.mocked(resolveZernioCreds).mockResolvedValue({ accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session" });
    redeFalsa(() => new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "This API is not activated on your API project." }), { status: 200 }));
    const recusado = await completarLocalizacao(adminFalso({ temChave: true }) as never, ORG, PINO);
    expect(recusado.location).toEqual({ latitude: -25.4284, longitude: -49.2733 });

    vi.restoreAllMocks();
    vi.mocked(resolveZernioCreds).mockResolvedValue({ accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("maps.googleapis.com")) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ status: "success", messages: [{ id: "wamid.X", metadata: { location: { latitude: -25.4284, longitude: -49.2733 } } }] }),
        { status: 200 },
      );
    });
    const foraDoAr = await completarLocalizacao(adminFalso({ temChave: true }) as never, ORG, PINO);
    expect(foraDoAr.location).toEqual({ latitude: -25.4284, longitude: -49.2733 });
  });
});
