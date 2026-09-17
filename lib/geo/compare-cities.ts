import { z } from "zod";
import municipalities from "./municipios.json";

const citySchema = z.object({
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().regex(/^[a-zA-Z]{2}$/).optional(),
});
export const compareCitiesShape = {
  origin: citySchema,
  destinations: z.array(citySchema).min(1).max(30),
};
const schema = z.object(compareCitiesShape);
type City = (typeof municipalities)[number];
const source = "kelvins/municipios-brasileiros@503e2f70bbf1b4b7ec0b1f68b09086ccc38fe861";
const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

function locate(input: z.infer<typeof citySchema>) {
  return municipalities.filter((c) => normalize(c.city) === normalize(input.city) && (!input.state || c.state === input.state.toUpperCase()));
}
function publicCity(c: City) {
  return { city: c.city, state: c.state, ibge: c.ibge };
}
/** Distância entre pontos de referência municipais, nunca rota nem endereço de loja. */
function distance(a: City, b: City) {
  const radians = (n: number) => n * Math.PI / 180;
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) *
    Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function compareCities(input: unknown) {
  const parsed = schema.parse(input);
  const origins = locate(parsed.origin);
  if (origins.length !== 1) return {
    status: origins.length ? "ambiguous_origin" : "origin_not_found",
    candidates: origins.map(publicCity),
    next_step: origins.length ? "Confirme o estado da cidade com o cliente." : "Confirme o nome da cidade e o estado. Não invente distância ou localização.",
  };
  const unresolved: Array<{ city: string; state?: string; candidates: ReturnType<typeof publicCity>[] }> = [];
  const destinations = new Map<string, City>();
  for (const requested of parsed.destinations) {
    const found = locate(requested);
    if (found.length !== 1) unresolved.push({ ...requested, candidates: found.map(publicCity) });
    else destinations.set(found[0]!.ibge, found[0]!);
  }
  // Um destino ausente pode ser o mais perto: não devolver um ranking parcial como completo.
  if (unresolved.length) return {
    status: "unresolved_destinations", unresolved,
    next_step: "Confira os nomes e estados das cidades de destino na base da empresa antes de comparar.",
  };
  const ranked = [...destinations.values()].map((c) => ({ ...publicCity(c), km: distance(origins[0]!, c) }))
    .sort((a, b) => a.km - b.km || a.ibge.localeCompare(b.ibge));
  return {
    status: "ok",
    origin: publicCity(origins[0]!),
    destinations: ranked.map(({ km, ...c }) => ({ ...c, distance_km: Math.round(km * 10) / 10 })),
    method: "straight_line_between_municipal_reference_points",
    source,
    limitations: "Compara apenas as cidades fornecidas. Não confirma existência de loja, cobertura de entrega, trajeto rodoviário, trânsito, tempo de viagem ou unidade mais próxima de um endereço. Confirme as cidades com lojas na base da empresa.",
  };
}
