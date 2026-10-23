/**
 * A falha de envio pelo número oficial chega em três formatos, e os três têm de
 * dar o MESMO código — é por ele que a campanha decide se segue para a próxima
 * pessoa ou se para inteira (modelo pausado, número restringido, pagamento).
 */
import { describe, expect, it } from "vitest";

import { codigoDaPlataforma, falhaDoEnvioInteiro, fraseDaFalha } from "./erro-da-plataforma";

describe("codigoDaPlataforma", () => {
  it("oficial direto: o número vem em error_code", () => {
    expect(codigoDaPlataforma("131050", "Unable to deliver")).toBe("131050");
  });

  it("parceiro, pelo webhook: o rótulo do adapter em error_code e o número no começo do texto", () => {
    expect(codigoDaPlataforma("zernio_error", "131049 — Healthy ecosystem — …")).toBe("131049");
  });

  it("recusa síncrona: o marcador ganha do status HTTP que abre o texto", () => {
    expect(
      codigoDaPlataforma("zernio_error", "zernio_template_failed: 400 platform_api_error: x [plataforma:132015]"),
    ).toBe("132015");
    // Sem marcador, o 400 do envelope NÃO é lido como código.
    expect(codigoDaPlataforma("zernio_error", "zernio_template_failed: 400 INVALID_TEMPLATE_PARAMS: faltam")).toBe(
      "INVALID_TEMPLATE_PARAMS",
    );
  });

  it("recusa do pré-voo deste sistema", () => {
    expect(codigoDaPlataforma("zernio_error", 'template_not_approved: "x" (es) está PAUSED')).toBe("template_not_approved");
  });

  it("sem código nenhum: null", () => {
    expect(codigoDaPlataforma("send_failed", "timeout")).toBeNull();
    expect(codigoDaPlataforma(null, null)).toBeNull();
  });
});

describe("falhaDoEnvioInteiro", () => {
  it("modelo pausado, número restringido e pagamento param a campanha", () => {
    for (const c of ["132015", "132016", "131048", "131042", "368", "message_allowance_exceeded", "template_not_approved"]) {
      expect(falhaDoEnvioInteiro(c), c).toBe(true);
    }
  });

  it("o que é da PESSOA não para: ela desligou o marketing, não tem WhatsApp, passou do limite de promoções", () => {
    for (const c of ["131050", "131026", "131049", "130472", null]) {
      expect(falhaDoEnvioInteiro(c), String(c)).toBe(false);
    }
  });
});

describe("fraseDaFalha", () => {
  it("código conhecido vira frase; desconhecido devolve o texto cru da plataforma", () => {
    expect(fraseDaFalha("131050", "x")).toMatch(/desligou as mensagens de marketing/);
    expect(fraseDaFalha("999999", "Algo raro")).toBe("Algo raro");
    expect(fraseDaFalha(null, "  ")).toBeNull();
  });
});
