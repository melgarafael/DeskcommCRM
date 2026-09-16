import { describe, expect, it } from "vitest";
import { deveIdentificarNoAdvomax, parseAdvomaxMatch } from "./contact-match";

describe("identificação automática Advomax", () => {
  it("consulta contatos nunca verificados e repete após 24 horas", () => {
    const now = Date.parse("2026-09-16T12:00:00Z");
    expect(deveIdentificarNoAdvomax(null, now)).toBe(true);
    expect(deveIdentificarNoAdvomax("2026-09-16T11:00:00Z", now)).toBe(false);
    expect(deveIdentificarNoAdvomax("2026-09-15T11:59:59Z", now)).toBe(true);
  });

  it("recusa classificação incoerente na fronteira da API", () => {
    expect(parseAdvomaxMatch({ status: "client", correspondencias: [] })).toBeNull();
    expect(
      parseAdvomaxMatch({ status: "client", correspondencias: [{ codigo: 7, cliente: false }] }),
    ).toBeNull();
    expect(
      parseAdvomaxMatch({ status: "ambiguous", correspondencias: [{ codigo: 7, cliente: true }] }),
    ).toBeNull();
    expect(
      parseAdvomaxMatch({ status: "client", correspondencias: [{ codigo: 7, cliente: true }] }),
    ).toEqual({ status: "client", correspondencias: [{ codigo: 7, cliente: true }] });
  });
});
