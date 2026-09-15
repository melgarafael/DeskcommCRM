import { describe, expect, it } from "vitest";

import { anonymize, detectResidualPii } from "./index";

describe("anonymize — NIF angolano (BI)", () => {
  it("redige NIF no formato do BI (9 dígitos + 2 letras + 3 dígitos)", () => {
    // Buraco real: antes desta guarda, nenhum padrão capturava letra no meio
    // do número, então esse NIF seguia intacto para o LLM.
    const { anonymized, hits } = anonymize("Meu NIF é 003862011LA042, pode confirmar?");
    expect(anonymized).toBe("Meu NIF é [NIF], pode confirmar?");
    expect(hits).toEqual([{ type: "nif", original: "003862011LA042", replacement: "[NIF]" }]);
  });

  it("continua redigindo CPF brasileiro (não é substituição, é adição)", () => {
    const { anonymized, hits } = anonymize("Meu CPF é 123.456.789-09 aqui");
    expect(anonymized).toBe("Meu CPF é [CPF] aqui");
    expect(hits[0]).toMatchObject({ type: "cpf" });
  });

  it("detectResidualPii pega NIF que sobrou sem passar pelo anonymize", () => {
    expect(detectResidualPii("número 003862011LA042 solto no texto")).toBe("nif");
  });
});
