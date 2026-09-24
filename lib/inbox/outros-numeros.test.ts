import { describe, expect, it } from "vitest";

import {
  CHANNEL_PROVIDER_SOCIAL,
  DEFAULT_CHANNEL_PROVIDER,
  PROVIDERS_SEM_MENSAGEM,
} from "@/lib/channels/capabilities";

import { numeroForaDoArComSaida, outrosNumerosDoContato, type SessaoDeNumero } from "./outros-numeros";

const sessao = (id: string, over: Partial<SessaoDeNumero> = {}): SessaoDeNumero => ({
  id,
  provider: DEFAULT_CHANNEL_PROVIDER,
  status: "WORKING",
  phone_number: `55719999${id}`,
  display_name: null,
  ...over,
});

describe("outrosNumerosDoContato", () => {
  it("lista os outros números com telefone, marcando quem está conectado", () => {
    const r = outrosNumerosDoContato(
      [sessao("a"), sessao("b"), sessao("c", { status: "FAILED" })],
      "a",
    );
    expect(r.map((n) => [n.id, n.conectado])).toEqual([
      ["b", true],
      ["c", false],
    ]);
  });

  it("deixa de fora rede social (sem telefone) e linha de voz (sem mensagem)", () => {
    const r = outrosNumerosDoContato(
      [
        sessao("a"),
        sessao("social", { phone_number: null, provider: CHANNEL_PROVIDER_SOCIAL }),
        sessao("voz", { provider: PROVIDERS_SEM_MENSAGEM[0] }),
      ],
      "a",
    );
    expect(r).toEqual([]);
  });
});

describe("numeroForaDoArComSaida", () => {
  it("avisa quando o número da conversa caiu e há outro conectado", () => {
    expect(numeroForaDoArComSaida([sessao("a", { status: "FAILED" }), sessao("b")], "a")).toBe(true);
  });

  it("fica quieto com o número da conversa conectado", () => {
    expect(numeroForaDoArComSaida([sessao("a"), sessao("b")], "a")).toBe(false);
  });

  it("fica quieto quando não há outro número conectado para onde ir", () => {
    expect(
      numeroForaDoArComSaida([sessao("a", { status: "FAILED" }), sessao("b", { status: "STOPPED" })], "a"),
    ).toBe(false);
  });

  it("não afirma queda sem ter lido o status (lista ausente ou sessão fora dela)", () => {
    expect(numeroForaDoArComSaida(undefined, "a")).toBe(false);
    expect(numeroForaDoArComSaida([sessao("b")], "a")).toBe(false);
  });
});
