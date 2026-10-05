import { describe, expect, it } from "vitest";

import { deveRecusarChamada, END_REASON_CONTACT_BLOCKED } from "./recusa-bloqueado";

/**
 * A decisão pura "bloqueado na ligação é recusado".
 *
 * SABOTAGEM (prova no CI, sem rodar nada local):
 * - remover a checagem (`return false` sempre) = caso 1 vermelho (1 caso cai);
 * - forçar recusa sempre (`return true`) = casos 2 e 3 vermelhos (2 casos caem).
 */
describe("deveRecusarChamada", () => {
  it("caso 1 — bloqueado (true) recusa", () => {
    expect(deveRecusarChamada(true)).toBe(true);
  });

  it("caso 2 — não bloqueado (false) segue igual a hoje", () => {
    expect(deveRecusarChamada(false)).toBe(false);
  });

  it("caso 3 — falha de leitura (null/undefined) segue + fail-open", () => {
    expect(deveRecusarChamada(null)).toBe(false);
    expect(deveRecusarChamada(undefined)).toBe(false);
  });

  it("o motivo gravado é contact_blocked (campo sem CHECK, sem migration)", () => {
    expect(END_REASON_CONTACT_BLOCKED).toBe("contact_blocked");
  });
});
