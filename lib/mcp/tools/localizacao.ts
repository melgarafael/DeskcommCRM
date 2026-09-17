import { compareCities, compareCitiesShape } from "@/lib/geo/compare-cities";
import type { McpToolDefinition } from "../types";

export const crmCompareCityDistances: McpToolDefinition<typeof compareCitiesShape> = {
  name: "crm_compare_city_distances",
  description: "Consulta municípios brasileiros e ordena cidades de destino pela distância em linha reta da cidade do cliente. " +
    "Antes, consulte na base da empresa TODAS as cidades com lojas pertinentes e use-as como destinations; esta consulta não verifica lojas. " +
    "Informe city sem UF no nome, e state como sigla de duas letras quando conhecida. Não deduza UF pelo DDD. " +
    "Se o nome for ambíguo, peça o estado. Se não encontrado, confirme o nome, sem inventar coordenadas. " +
    "Não exige bairro/endereço. Não calcula rota, tempo de viagem nem escolhe unidade dentro da cidade. Não transfere atendimento.",
  inputSchema: compareCitiesShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input) => compareCities(input),
};
