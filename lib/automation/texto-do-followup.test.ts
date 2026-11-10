import { describe, expect, it } from "vitest";

import { renderizarTextoDeFollowup } from "./texto-do-followup";

describe("renderizarTextoDeFollowup: texto de reserva", () => {
  it('sem o dado, a reserva entra no lugar (e o espaço não some)', () => {
    expect(renderizarTextoDeFollowup('Oi {{primeiro_nome|"aluno"}}, tudo bem?', { contact: { name: null } })).toBe(
      "Oi aluno, tudo bem?",
    );
  });

  it("com o dado, vale o dado", () => {
    expect(renderizarTextoDeFollowup('Oi {{primeiro_nome|"aluno"}}!', { contact: { name: "Ana Souza" } })).toBe(
      "Oi Ana!",
    );
  });

  it("regressão: sem reserva, a marcação vazia some com o espaço vizinho", () => {
    expect(renderizarTextoDeFollowup("Oi {{primeiro_nome}}!", { contact: { name: null } })).toBe("Oi!");
  });
});
