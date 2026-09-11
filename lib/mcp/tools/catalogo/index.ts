/**
 * Agregador do catalogo de tools.
 *
 * Cada dominio declara suas capacidades no proprio arquivo desta pasta. O
 * agregador so junta. Isso existe por uma razao pratica: com varios times
 * entregando capacidades em paralelo, um unico array gigante garante conflito
 * de merge em todo hunk — e conflito resolvido no automatico e onde uma
 * capacidade some em silencio.
 *
 * PARA ADICIONAR UM DOMINIO NOVO: crie `<dominio>.ts` nesta pasta usando
 * `declararTools([...])` e acrescente UMA linha no import e UMA no spread
 * abaixo. Nao edite os arquivos dos outros dominios.
 *
 * Client-safe: zero import de zod, supabase ou next/headers.
 */
import { TOOLS_ACADEMIA } from "./academia";
import { TOOLS_AGENDAMENTO } from "./agendamento";
import { TOOLS_ATENDIMENTO } from "./atendimento";
import { TOOLS_COMERCIO } from "./comercio";
import { TOOLS_EVOLUCAO } from "./evolucao";
import { TOOLS_ESCALACAO } from "./escalacao";
import { TOOLS_FUNIL } from "./funil";
import { TOOLS_GOVERNANCA } from "./governanca";
import { TOOLS_OPERACAO } from "./operacao";
import { TOOLS_RETENCAO } from "./retencao";
import type { McpToolCatalogEntry } from "./tipos";

export type { McpToolCatalogEntry } from "./tipos";
export { declararTools } from "./tipos";

export const TOOL_CATALOG: ReadonlyArray<McpToolCatalogEntry> = [
  ...TOOLS_ACADEMIA,
  ...TOOLS_AGENDAMENTO,
  ...TOOLS_ATENDIMENTO,
  ...TOOLS_ESCALACAO,
  ...TOOLS_FUNIL,
  ...TOOLS_GOVERNANCA,
  ...TOOLS_EVOLUCAO,
  ...TOOLS_COMERCIO,
  ...TOOLS_OPERACAO,
  ...TOOLS_RETENCAO,
];

/**
 * Guarda de agregacao: dois dominios declarando o mesmo `name` e um acidente
 * provavel quando times trabalham em paralelo, e o sintoma seria uma tool
 * silenciosamente sombreando a outra. O gate de CI vive em
 * `tests/unit/catalogo-tools-leigo-friendly.test.ts`; isto aqui e so o
 * feedback rapido em dev.
 */
if (process.env.NODE_ENV !== "production") {
  const vistos = new Set<string>();
  for (const t of TOOL_CATALOG) {
    if (vistos.has(t.name)) {
      throw new Error(
        `mcp/catalogo: tool "${t.name}" declarada em mais de um dominio de lib/mcp/tools/catalogo/`,
      );
    }
    vistos.add(t.name);
  }
}

export const VALID_TOOL_IDS: ReadonlyArray<string> = TOOL_CATALOG.map((t) => t.name);

export function catalogEntry(name: string): McpToolCatalogEntry | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}
