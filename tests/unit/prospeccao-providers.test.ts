import { afterEach, describe, expect, it, vi } from "vitest";

import { MapsBrowserProvider } from "@/lib/prospeccao/providers/browser";
import { GooglePlacesProvider } from "@/lib/prospeccao/providers/google-places";
import { OSMOverpassProvider, seletoresPara } from "@/lib/prospeccao/providers/osm";
import { criarProvider, METADADOS_PROVIDERS } from "@/lib/prospeccao/providers/registro";

/**
 * OS PROVIDERS — cerca do plano §§1–3.
 * Rede sempre mockada: teste que chama o Google de verdade é incidente de
 * faturamento, não teste.
 */
function mockFetchOnce(corpo: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(corpo),
      text: () => Promise.resolve(JSON.stringify(corpo)),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GooglePlacesProvider", () => {
  it("recusa nascer sem chave (falha nomeando a config)", () => {
    expect(() => new GooglePlacesProvider("")).toThrowError("sem_chave");
  });

  it("search mapeia places e conta requisições", async () => {
    mockFetchOnce({
      places: [
        {
          id: "place-1",
          displayName: { text: "Oficina São José" },
          formattedAddress: "Rua A, 100, Canoinhas - SC",
          internationalPhoneNumber: "+55 47 99999-9999",
          websiteUri: "https://www.oficina.com.br/",
          rating: 4.5,
          userRatingCount: 120,
          types: ["car_repair", "store"],
          location: { latitude: -26.17, longitude: -50.32 },
        },
      ],
    });
    const p = new GooglePlacesProvider("chave");
    const r = await p.search({ categoria: "Oficina mecânica", latitude: -26.17, longitude: -50.32, raioMetros: 5000, limite: 20 });
    expect(r.negocios).toHaveLength(1);
    expect(r.negocios[0]).toMatchObject({
      idExterno: "place-1",
      telefone: "+55 47 99999-9999",
      totalAvaliacoes: 120,
    });
    expect(r.requisicoes).toBe(1);
    expect(r.detalhes).toBe(0);
  });

  it("429 tenta de novo (backoff), depois desiste nomeando", async () => {
    let chamadas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        chamadas++;
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("quota"),
        });
      }),
    );
    const p = new GooglePlacesProvider("chave", { tentativas: 2 });
    await expect(
      p.search({ categoria: "X", latitude: 0, longitude: 0, raioMetros: 1000, limite: 5 }),
    ).rejects.toThrowError("google_429");
    expect(chamadas).toBe(2);
  });

  it("getDetails devolve null quando o lugar sumiu", async () => {
    mockFetchOnce({});
    const p = new GooglePlacesProvider("chave");
    expect(await p.getDetails("fantasma")).toBeNull();
  });
});

describe("MapsBrowserProvider", () => {
  it("desligado por padrão, e recusar é erro nomeado", async () => {
    const p = new MapsBrowserProvider();
    await expect(p.search({ categoria: "x", latitude: 0, longitude: 0, raioMetros: 1, limite: 1 })).rejects.toThrowError(
      "nao_implementado",
    );
  });
});

describe("criarProvider", () => {
  it("resolve pelos nomes conhecidos e recusa o resto", () => {
    expect(criarProvider("google_places", { chaveGoogle: "k" }).nome).toBe("google_places");
    expect(criarProvider("osm_overpass").nome).toBe("osm_overpass");
    expect(criarProvider("maps_browser").nome).toBe("maps_browser");
    expect(() => criarProvider("bing")).toThrowError("provider_desconhecido");
  });

  it("metadados sem CAMPO de segredo para a tela", () => {
    // A forma, não a prosa: "requer chave" no texto é instrução; campo
    // `apiKey`/`secret` seria vazamento. Só nome/rotulo/descricao viajam.
    for (const m of METADADOS_PROVIDERS) {
      expect(Object.keys(m).sort()).toEqual(["descricao", "nome", "rotulo"]);
    }
    expect(METADADOS_PROVIDERS.map((m) => m.nome).sort()).toEqual([
      "google_places",
      "maps_browser",
      "osm_overpass",
    ]);
  });
});

describe("OSMOverpassProvider", () => {
  it("mapeia categoria comercial para tags OSM", () => {
    expect(seletoresPara("Oficina mecânica").seletores).toContain('["shop"="car_repair"]');
    expect(seletoresPara("Farmácia").seletores).toContain('["amenity"="pharmacy"]');
    expect(seletoresPara("coisa que não existe").aproximado).toBe(true);
  });

  it("mapeia elementos em negócios e conta 1 requisição", async () => {
    mockFetchOnce({
      elements: [
        {
          type: "node",
          id: 1,
          lat: -26.17,
          lon: -50.32,
          tags: {
            name: "Oficina Teste",
            "contact:phone": "(47) 99999-9999",
            "contact:website": "oficina.com.br",
            "addr:city": "Canoinhas",
            "addr:state": "SC",
          },
        },
        { type: "node", id: 2, lat: 0, lon: 0, tags: {} },
      ],
    });
    const p = new OSMOverpassProvider();
    const r = await p.search({ categoria: "Oficina mecânica", latitude: -26.17, longitude: -50.32, raioMetros: 5000, limite: 20 });
    // Sem nome não entra (não há o que deduplicar nem mostrar).
    expect(r.negocios).toHaveLength(1);
    expect(r.negocios[0]).toMatchObject({
      idExterno: "osm:node/1",
      telefone: "(47) 99999-9999",
      cidade: "Canoinhas",
    });
    expect(r.requisicoes).toBe(1);
    expect(r.detalhes).toBe(0);
  });

  it("getDetails não existe aqui (tudo vem na busca)", async () => {
    const p = new OSMOverpassProvider();
    expect(await p.getDetails("osm:node/1")).toBeNull();
  });
});
