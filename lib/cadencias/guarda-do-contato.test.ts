import { describe, expect, it } from "vitest";
import { contatoRestringido } from "./guarda-do-contato";
describe("vetos canônicos também valem no módulo de e-mail", () => {
  it.each([{ is_blocked: true }, { is_personal: true }, { is_anonymized: true }, { consent: { marketing: { declined_at: "2026-10-26T12:00:00Z" } } }])("recusa %j", (contato) => { expect(contatoRestringido(contato)).toBe(true); });
  it("ausência de grant não é a recusa registrada", () => {
    expect(contatoRestringido({ consent: { marketing: { granted_at: null } } })).toBe(false);
  });
});
