/**
 * Quais ferramentas do turno são LEITURA de um servidor MCP externo (#2147).
 *
 * A prévia (teste do agente e rascunho do modo assistido, `preview.ts`) só
 * reconhece o catálogo compilado; a remota chega com o nome que o servidor
 * anuncia. Decidir pelo NOME — ou só pela marca `mcp_externo:leitura:<nome>`
 * do `tool_ids` — deixaria passar uma remota que o servidor não declarou
 * `readOnlyHint`, ou uma ferramenta nativa com o mesmo nome. Por isso a marca
 * vai no OBJETO que `pickToolsFromMcp` montou, e só quando a definição saiu com
 * `category: "read"` (as duas metades de `lib/mcp/tools/externo.ts`).
 */
const leituras = new WeakSet<object>();

export function marcarLeituraRemota<T extends object>(ferramenta: T): T {
  leituras.add(ferramenta);
  return ferramenta;
}

export function ehLeituraRemota(ferramenta: unknown): boolean {
  return typeof ferramenta === "object" && ferramenta !== null && leituras.has(ferramenta);
}
