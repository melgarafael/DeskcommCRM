export const MCP_ENDPOINT_PATH = "/api/mcp";

/**
 * Monta a URL pública do endpoint MCP sem aceitar caminhos ou protocolos
 * fornecidos pelo conteúdo da página. A origem vem do navegador; entradas
 * inválidas retornam o caminho relativo seguro para uso local.
 */
export function mcpEndpointFromOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return MCP_ENDPOINT_PATH;
    }
    return new URL(MCP_ENDPOINT_PATH, url.origin).toString();
  } catch {
    return MCP_ENDPOINT_PATH;
  }
}

export function mcpConnectionInstructions(endpoint: string): string {
  return [
    `Endpoint: ${endpoint}`,
    "Transporte: Streamable HTTP",
    "Autenticação: Authorization: Bearer <token>",
  ].join("\n");
}
