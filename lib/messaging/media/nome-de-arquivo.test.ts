/**
 * O nome que o anexo ENVIADO leva para o WhatsApp (#4457).
 *
 * O caminho no bucket é `out-<uuid>.<ext>`: nasce aleatório de propósito (dois
 * arquivos com o mesmo nome não podem se sobrescrever). Era esse basename que
 * virava `filename` do documento, e o cliente via `out-3f9a2b.pdf`. O nome que
 * a pessoa escolheu é o que tem de viajar; o basename fica só como último
 * recurso de quem chama a API sem nome.
 */
import { describe, expect, it } from "vitest";

import { nomeDoAnexoParaEnviar } from "./nome-de-arquivo";

const CAMINHO = "org/conv/out-3f9a2b1c-1111-4222-8333-444455556666.pdf";

describe("nomeDoAnexoParaEnviar (#4457)", () => {
  it("o nome original vence o basename aleatório do bucket", () => {
    expect(
      nomeDoAnexoParaEnviar(
        "Dom Travel - Voucher LOC 123456 - Nome do Passageiro - Maceió.pdf",
        CAMINHO,
      ),
    ).toBe("Dom Travel - Voucher LOC 123456 - Nome do Passageiro - Maceió.pdf");
  });

  it("sem nome original, o basename continua sendo o último recurso", () => {
    expect(nomeDoAnexoParaEnviar(undefined, CAMINHO)).toBe(
      "out-3f9a2b1c-1111-4222-8333-444455556666.pdf",
    );
    expect(nomeDoAnexoParaEnviar(null, CAMINHO)).toBe(
      "out-3f9a2b1c-1111-4222-8333-444455556666.pdf",
    );
  });

  it("nome que só tem invisíveis não vira nome do documento", () => {
    expect(nomeDoAnexoParaEnviar("\u200e\u200f", CAMINHO)).toBe(
      "out-3f9a2b1c-1111-4222-8333-444455556666.pdf",
    );
  });
});
