/**
 * Catalogo estatico de tools MCP — apenas metadados (id, label, categoria).
 *
 * Este modulo NAO importa handlers nem nada que dependa de `next/headers`,
 * `lib/supabase/server`, ou audit log. Pode ser importado com seguranca por
 * Client Components (ex: AgentForm via lib/ai/agents/validation.ts).
 *
 * Runtime de execucao (handlers reais) vive em `lib/mcp/tools/index.ts` e so
 * pode ser importado por Server Components / Route Handlers / server actions.
 *
 * DUAS AUDIENCIAS, DOIS TEXTOS (epico IA 360):
 *   - `description` fala com o MODELO. Tecnica; e por ela que a tool e escolhida.
 *   - `rotulo` / `explicacao` / `oQueToca` falam com o HUMANO que configura o
 *     agente — dono de clinica, de loja, de imobiliaria. Sem jargao. O gate
 *     mecanico vive em `tests/unit/catalogo-tools-leigo-friendly.test.ts`.
 *
 * `name` e CONTRATO DE WIRE: agentes ja publicados em VPS de clientes e clientes
 * MCP externos referenciam esta string. Nunca renomeie tool publicada — o nome
 * amigavel e camada de apresentacao, nao rename.
 *
 * AS ENTRADAS VIVEM EM `lib/mcp/tools/catalogo/<dominio>.ts`. Este arquivo e so
 * a porta de entrada estavel — varios modulos ja importam deste caminho.
 */
export type { McpToolCatalogEntry } from "./catalogo";
export {
  TOOL_CATALOG,
  VALID_TOOL_IDS,
  catalogEntry,
  declararTools,
  deModuloDesligado,
} from "./catalogo";
