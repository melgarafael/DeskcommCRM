/**
 * O catálogo de vozes do provedor: mapeamento do `/v1/voices`, a chamada com a
 * chave, e — o caso que mais importa — a QUEDA para a lista de ids que a
 * validação da credencial já deixou no banco (#4260).
 */
import { describe, expect, it, vi } from "vitest";

import {
  lerVozesDaResposta,
  listarVozesDoProvedor,
  montarCatalogoDeVozes,
  URL_DAS_VOZES_DA_ELEVENLABS,
} from "./catalogo-do-provedor";

describe("lerVozesDaResposta", () => {
  it("traz nome e idioma quando o provedor declara", () => {
    const catalogo = lerVozesDaResposta({
      voices: [
        { voice_id: "abc12345", name: "Ana", labels: { language: "pt" } },
        {
          voice_id: "def67890",
          name: "Beto",
          labels: {},
          verified_languages: [{ language: "es" }],
        },
      ],
    });
    expect(catalogo).toEqual([
      { id: "abc12345", nome: "Ana", idioma: "pt" },
      { id: "def67890", nome: "Beto", idioma: "es" },
    ]);
  });

  it("sem idioma declarado, diz null em vez de inventar; sem nome, usa o id", () => {
    const catalogo = lerVozesDaResposta({
      voices: [{ voice_id: "abc12345", name: "  " }],
    });
    expect(catalogo).toEqual([{ id: "abc12345", nome: "abc12345", idioma: null }]);
  });

  it("descarta entrada sem id e duplicata, sem derrubar o resto", () => {
    const catalogo = lerVozesDaResposta({
      voices: [{ name: "sem id" }, { voice_id: "abc12345", name: "Ana" }, { voice_id: "abc12345", name: "Ana 2" }],
    });
    expect(catalogo).toHaveLength(1);
    expect(catalogo[0]?.id).toBe("abc12345");
  });

  it("resposta torta devolve lista vazia, não lança", () => {
    expect(lerVozesDaResposta(null)).toEqual([]);
    expect(lerVozesDaResposta({ voices: "nada" })).toEqual([]);
    expect(lerVozesDaResposta({})).toEqual([]);
  });
});

describe("listarVozesDoProvedor", () => {
  it("chama o endpoint da ElevenLabs com a chave da organização", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ voices: [{ voice_id: "abc12345", name: "Ana" }] }), {
        status: 200,
      }),
    );
    const catalogo = await listarVozesDoProvedor("sk-1", fetchImpl as unknown as typeof fetch);
    expect(catalogo).toEqual([{ id: "abc12345", nome: "Ana", idioma: null }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL_DAS_VOZES_DA_ELEVENLABS);
    expect((init as RequestInit).headers).toEqual({ "xi-api-key": "sk-1" });
  });

  it("HTTP de erro lança — quem decide a queda é o chamador", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(
      listarVozesDoProvedor("sk-1", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("voices_401");
  });
});

describe("montarCatalogoDeVozes — a lista de hoje como piso", () => {
  it("usa o catálogo do provedor quando ele responde", async () => {
    const montado = await montarCatalogoDeVozes({
      idsDaCredencial: ["velho12345"],
      buscar: async () => [{ id: "novo12345", nome: "Ana", idioma: "pt" }],
    });
    expect(montado).toEqual({
      catalogo: [{ id: "novo12345", nome: "Ana", idioma: "pt" }],
      veioDoProvedor: true,
    });
  });

  it("provedor falhando: cai na lista da credencial, com nome = id, sem erro fatal", async () => {
    const montado = await montarCatalogoDeVozes({
      idsDaCredencial: ["abc12345", "def67890"],
      buscar: async () => {
        throw new Error("voices_503");
      },
    });
    expect(montado).toEqual({
      catalogo: [
        { id: "abc12345", nome: "abc12345", idioma: null },
        { id: "def67890", nome: "def67890", idioma: null },
      ],
      veioDoProvedor: false,
    });
  });

  it("provedor devolve vazio: também cai na lista da credencial, sem duplicar", async () => {
    const montado = await montarCatalogoDeVozes({
      idsDaCredencial: ["abc12345", "abc12345", ""],
      buscar: async () => [],
    });
    expect(montado).toEqual({
      catalogo: [{ id: "abc12345", nome: "abc12345", idioma: null }],
      veioDoProvedor: false,
    });
  });
});
