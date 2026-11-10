import { describe, expect, it } from "vitest";

import { idsDaLinhaDoCanal, uuidDoAudioSocketDeEntrada } from "./canal-de-entrada";

const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidDoAudioSocketDeEntrada", () => {
  it("é UUID válido para o AudioSocket, a partir do id nativo do Asterisk", () => {
    expect(uuidDoAudioSocketDeEntrada("1789081888.0")).toMatch(FORMATO_UUID);
  });

  it("o mesmo canal dá sempre o mesmo UUID — é o que permite voltar do evento para a linha", () => {
    expect(uuidDoAudioSocketDeEntrada("1789081888.0")).toBe(
      uuidDoAudioSocketDeEntrada("1789081888.0"),
    );
  });

  it("canais diferentes dão UUIDs diferentes", () => {
    expect(uuidDoAudioSocketDeEntrada("1789081888.0")).not.toBe(
      uuidDoAudioSocketDeEntrada("1789081888.1"),
    );
  });
});

describe("idsDaLinhaDoCanal", () => {
  it("cobre a feita (o próprio id) e a recebida (o derivado)", () => {
    expect(idsDaLinhaDoCanal("1789081888.0")).toEqual([
      "1789081888.0",
      uuidDoAudioSocketDeEntrada("1789081888.0"),
    ]);
  });
});
