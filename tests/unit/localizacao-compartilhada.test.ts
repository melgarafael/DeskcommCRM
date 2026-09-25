/**
 * Localização compartilhada: o pino do cliente vira link do mapa no corpo (o
 * que o agente lê) e coordenadas no metadata (o que a tela desenha).
 *
 * O pino É o endereço para quem entrega — cliente sem número de casa, de
 * aluguel, ou que acha mais fácil mandar o pino. Coordenada inválida que vira
 * link manda o entregador para o lugar errado, e isso é pior que não ter pino.
 */
import { describe, expect, it, vi } from "vitest";

import {
  corpoDaLocalizacao,
  lerLocalizacao,
  linkDoMapa,
  localizacaoDaMensagem,
} from "@/lib/messaging/localizacao";
import { buscarLocalizacaoZernio, ehMarcadorDeLocalizacao } from "@/lib/channels/zernio/localizacao";

const CREDS = { accountId: "acc_1", apiKey: "k", baseUrl: "https://z.test/api", source: "session" as const };
const listagem = (mensagens: unknown[]) =>
  new Response(JSON.stringify({ status: "success", messages: mensagens }), { status: 200 });

describe("leitura das coordenadas", () => {
  it("aceita latitude/longitude e as formas curtas", () => {
    expect(lerLocalizacao({ latitude: -25.3, longitude: -57.5 })).toEqual({ latitude: -25.3, longitude: -57.5 });
    expect(lerLocalizacao({ lat: "-25.3", lng: "-57.5" })).toEqual({ latitude: -25.3, longitude: -57.5 });
  });

  it("leva nome e endereço quando o cliente escolheu um lugar com nome", () => {
    const loc = lerLocalizacao({ latitude: -25.3, longitude: -57.5, name: "Shopping del Sol", address: "Av. Aviadores del Chaco" });
    expect(corpoDaLocalizacao(loc!)).toBe(
      "📍 Shopping del Sol — Av. Aviadores del Chaco — https://maps.google.com/?q=-25.3,-57.5",
    );
  });

  it("recusa o que não é ponto na Terra: fora da faixa, (0,0) e lixo", () => {
    for (const bruto of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: 0 },
      { latitude: "abc", longitude: 1 },
      { latitude: -25.3 },
      null,
      "📍 Location",
    ]) {
      expect(lerLocalizacao(bruto)).toBeNull();
    }
  });

  it("a mensagem gravada só é pino quando o TIPO diz", () => {
    const metadata = { location: { latitude: -25.3, longitude: -57.5 } };
    expect(localizacaoDaMensagem({ type: "location", metadata })).not.toBeNull();
    expect(localizacaoDaMensagem({ type: "text", metadata })).toBeNull();
    expect(linkDoMapa({ latitude: -25.3, longitude: -57.5 })).toBe("https://maps.google.com/?q=-25.3,-57.5");
  });
});

describe("o marcador que o canal põe no lugar do pino", () => {
  it("reconhece o marcador e só ele", () => {
    expect(ehMarcadorDeLocalizacao("📍 Location")).toBe(true);
    expect(ehMarcadorDeLocalizacao(" 📍 location ")).toBe(true);
    expect(ehMarcadorDeLocalizacao("te mando la location mañana")).toBe(false);
    expect(ehMarcadorDeLocalizacao(null)).toBe(false);
  });
});

describe("busca das coordenadas na API do canal", () => {
  it("acha a mensagem pelo wamid e manda a chave no cabeçalho, nunca na URL", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      listagem([{ id: "wamid.X", metadata: { location: { latitude: -25.33, longitude: -57.54 } } }]),
    );
    expect(await buscarLocalizacaoZernio(CREDS, "conv", "wamid.X")).toEqual({ latitude: -25.33, longitude: -57.54 });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).not.toContain("k&");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
    f.mockRestore();
  });

  it("mensagem ainda não listada: tenta de novo uma vez e desiste sem lançar", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => listagem([]));
    const esperas: number[] = [];
    const r = await buscarLocalizacaoZernio(CREDS, "conv", "wamid.X", async (ms) => {
      esperas.push(ms);
    });
    expect(r).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    expect(esperas).toHaveLength(1);
    f.mockRestore();
  });

  it("aparece na segunda tentativa: é o webhook que chegou antes da listagem", async () => {
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(listagem([]))
      .mockResolvedValueOnce(listagem([{ id: "wamid.X", metadata: { location: { latitude: 1, longitude: 2 } } }]));
    expect(await buscarLocalizacaoZernio(CREDS, "conv", "wamid.X", async () => {})).toEqual({ latitude: 1, longitude: 2 });
    f.mockRestore();
  });

  it("HTTP de erro lança — quem chama decide (e a ingestão segue com o marcador)", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(buscarLocalizacaoZernio(CREDS, "conv", "wamid.X")).rejects.toThrow("zernio_401");
    f.mockRestore();
  });
});
