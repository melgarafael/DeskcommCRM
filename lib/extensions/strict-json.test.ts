import { describe, expect, it, vi } from "vitest";

import { ExtensionError } from "./errors";
import { parseStrictJson, type StrictJsonLimits } from "./strict-json";

const limits: StrictJsonLimits = {
  maxBytes: 1_024,
  maxDepth: 4,
  maxNodes: 20,
  maxPropertiesPerObject: 3,
};

const bytes = (value: string) => new TextEncoder().encode(value);

function expectCode(run: () => unknown, code: ExtensionError["code"]) {
  try {
    run();
    throw new Error("Esperava ExtensionError");
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionError);
    expect((error as ExtensionError).code).toBe(code);
  }
}

describe("parseStrictJson", () => {
  it("aceita JSON estrito dentro dos limites", () => {
    expect(parseStrictJson(bytes('{"items":[1,true,null]}'), limits)).toEqual({
      items: [1, true, null],
    });
  });

  it.each([
    ['{"a":1,"a":2}', "chave duplicada"],
    ['{"__proto__":{}}', "__proto__"],
    ['{"nested":{"constructor":1}}', "constructor"],
    ['{"prototype":null}', "prototype"],
    ['{"a":1,}', "vírgula final"],
    ['{/* comentário */"a":1}', "comentário"],
    ['{"a":NaN}', "valor não JSON"],
    [`]${"[".repeat(20)}0${"]".repeat(20)}`, "fechamento não mascara profundidade"],
  ])("recusa %s (%s)", (source) => {
    expectCode(() => parseStrictJson(bytes(source), limits), "extension_invalid_package");
  });

  it("recusa bytes acima do teto antes de decodificar", () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");

    expectCode(
      () => parseStrictJson(new Uint8Array(limits.maxBytes + 1), limits),
      "extension_payload_too_large",
    );
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it("recusa UTF-8 inválido", () => {
    expectCode(
      () => parseStrictJson(Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]), limits),
      "extension_invalid_package",
    );
  });

  it("recusa BOM para preservar a identidade entre bytes e JSON persistido", () => {
    expectCode(
      () => parseStrictJson(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes('{"a":1}')]), limits),
      "extension_invalid_package",
    );
  });

  it.each([
    ['{"value":"\\u0000"}', "NUL em valor"],
    ['{"\\u0000":1}', "NUL em chave"],
    ['{"value":"\\ud800"}', "surrogate alto isolado"],
    ['{"value":"\\udc00"}', "surrogate baixo isolado"],
  ])("recusa string incompatível com JSONB (%s: %s)", (source) => {
    expectCode(() => parseStrictJson(bytes(source), limits), "extension_invalid_package");
  });

  it("preserva par surrogate válido", () => {
    expect(parseStrictJson(bytes('{"value":"\\ud83d\\ude00"}'), limits)).toEqual({
      value: "😀",
    });
  });

  it("aplica profundidade no scanner antes do parser recursivo", () => {
    const hostil = `${"[".repeat(5_000)}0${"]".repeat(5_000)}`;

    expectCode(
      () => parseStrictJson(bytes(hostil), { ...limits, maxBytes: 20_000 }),
      "extension_payload_too_large",
    );
  });

  it("limita nós e propriedades por objeto", () => {
    expectCode(
      () =>
        parseStrictJson(bytes("[1,2,3,4,5]"), {
          ...limits,
          maxNodes: 5,
        }),
      "extension_payload_too_large",
    );
    expectCode(
      () => parseStrictJson(bytes('{"a":1,"b":2,"c":3,"d":4}'), limits),
      "extension_payload_too_large",
    );
  });
});
