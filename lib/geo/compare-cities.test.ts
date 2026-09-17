import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compareCitiesShape, compareCities } from "./compare-cities";

const destinations = [
  { city: "Goiânia", state: "GO" }, { city: "Anápolis", state: "GO" },
  { city: "Brasília", state: "DF" }, { city: "Caldas Novas", state: "GO" },
];
describe("comparação geográfica de cidades", () => {
  it.each([
    ["Trindade", "GO", "Goiânia"], ["Goianira", "GO", "Goiânia"],
    ["Abadiânia", "GO", "Anápolis"], ["Rio Quente", "GO", "Caldas Novas"],
    ["Valparaíso de Goiás", "GO", "Brasília"], ["São Paulo", "SP", "Caldas Novas"],
  ])("consulta %s/%s sem regra especial e ordena por proximidade", (city, state, nearest) => {
    const result = compareCities({ origin: { city, state }, destinations });
    expect(result.status).toBe("ok");
    expect(result.destinations?.[0]?.city).toBe(nearest);
    expect(result.method).toBe("straight_line_between_municipal_reference_points");
    expect(result.destinations?.map((c) => c.distance_km)).toEqual(result.destinations?.map((c) => c.distance_km).sort((a,b) => a-b));
  });
  it("pede UF para homônimos, em vez de assumir GO", () => {
    const result = compareCities({ origin: { city: "Trindade" }, destinations });
    expect(result.status).toBe("ambiguous_origin");
    expect(result.candidates?.map((c) => c.state)).toEqual(expect.arrayContaining(["GO", "PE"]));
    expect(result.destinations).toBeUndefined();
  });
  it("normaliza acentos, espaços e caixa; distância zero na mesma cidade", () => {
    const r = compareCities({ origin: { city: "  GOIANIA ", state: "go" }, destinations: [...destinations, destinations[0]] });
    expect(r.destinations).toHaveLength(4);
    expect(r.destinations?.[0]?.distance_km).toBe(0);
  });
  it("não inventa origem desconhecida", () => {
    expect(compareCities({ origin: { city: "Cidade que não existe", state: "GO" }, destinations }).status).toBe("origin_not_found");
  });
  it("não declara mais próximo se um dos destinos não pôde ser consultado", () => {
    const r = compareCities({ origin: { city: "Goiânia" }, destinations: [...destinations, { city: "Sem cadastro", state: "GO" }] });
    expect(r.status).toBe("unresolved_destinations");
    expect(r.destinations).toBeUndefined();
  });
  it("limita volume e rejeita localização vazia", () => {
    expect(() => compareCities({ origin: { city: "" }, destinations })).toThrow();
    expect(() => compareCities({ origin: { city: "Goiânia" }, destinations: Array(31).fill(destinations[0]) })).toThrow();
  });
});

it("expõe schema no catálogo HTTP sem transforms incompatíveis", () => {
  expect(() => z.toJSONSchema(z.object(compareCitiesShape), { target: "openapi-3.0" })).not.toThrow();
});
