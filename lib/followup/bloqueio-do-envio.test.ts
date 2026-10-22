import { describe, expect, it } from "vitest";

import { motivoDeEncerramentoPorElegibilidade } from "./bloqueio-do-envio";

describe("motivoDeEncerramentoPorElegibilidade", () => {
  it("bloqueio do canal encerra com a frase que diz onde mexer", () => {
    expect(motivoDeEncerramentoPorElegibilidade("fora_da_lista_de_teste")).toMatch(/modo de teste/);
    expect(motivoDeEncerramentoPorElegibilidade("ai_opt_out")).toMatch(/pediu/);
  });

  it("pessoa no comando não encerra — vale a política de handoff", () => {
    expect(motivoDeEncerramentoPorElegibilidade("conversa_silenciada")).toBeNull();
    expect(motivoDeEncerramentoPorElegibilidade("conversa_de_humano")).toBeNull();
    expect(motivoDeEncerramentoPorElegibilidade("force_human")).toBeNull();
  });
});
