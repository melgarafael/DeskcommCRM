import { describe, expect, it } from "vitest";

import { modelosQueOFluxoEnvia, type LinhaDeModeloDoCanal } from "./modelos-aprovados";

function linha(id: string, status: string, texto: string): LinhaDeModeloDoCanal {
  return {
    id,
    name: `modelo_${id}`,
    language: "es",
    status,
    parameter_format: "POSITIONAL",
    components: [
      { type: "BODY", text: texto },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sí" }] },
    ],
  };
}

describe("modelos que um passo de fluxo consegue mandar sozinho", () => {
  it("⭐ só aprovado e sem variável — o que o turno do fluxo depois pula não é oferecido", () => {
    const lista = modelosQueOFluxoEnvia([
      linha("a", "APPROVED", "Sale ₲125.000. ¿Te lo reservamos?"),
      linha("b", "PENDING", "ainda em análise"),
      linha("c", "APPROVED", "Hola {{1}}, ¿seguís interesado?"),
      linha("d", "REJECTED", "recusado"),
    ]);
    expect(lista.map((m) => m.id)).toEqual(["a"]);
  });

  it("devolve o texto que o cliente lê, para escolher pelo conteúdo", () => {
    const [m] = modelosQueOFluxoEnvia([linha("a", "APPROVED", "Sale ₲125.000.")]);
    expect(m).toEqual({ id: "a", name: "modelo_a", language: "es", texto: "Sale ₲125.000." });
  });
});
