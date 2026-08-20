import { describe, expect, it } from "vitest";

import { mcpConnectionInstructions, mcpEndpointFromOrigin, MCP_ENDPOINT_PATH } from "./connection";

describe("mcpEndpointFromOrigin", () => {
  it("monta o endpoint na origem HTTPS atual", () => {
    expect(mcpEndpointFromOrigin("https://crm.example.com")).toBe("https://crm.example.com/api/mcp");
  });

  it("remove path, query e barra da origem antes de montar o endpoint", () => {
    expect(mcpEndpointFromOrigin("https://crm.example.com/app/?tenant=1")).toBe(
      "https://crm.example.com/api/mcp",
    );
  });

  it("aceita HTTP apenas para ambientes locais", () => {
    expect(mcpEndpointFromOrigin("http://localhost:3000")).toBe("http://localhost:3000/api/mcp");
  });

  it("retorna caminho relativo para origem inválida ou protocolo desconhecido", () => {
    expect(mcpEndpointFromOrigin("not-a-url")).toBe(MCP_ENDPOINT_PATH);
    expect(mcpEndpointFromOrigin("javascript:alert(1)")).toBe(MCP_ENDPOINT_PATH);
  });
});

describe("mcpConnectionInstructions", () => {
  it("não inclui token plaintext e explica o transporte e o bearer", () => {
    const instructions = mcpConnectionInstructions("https://crm.example.com/api/mcp");

    expect(instructions).toContain("Endpoint: https://crm.example.com/api/mcp");
    expect(instructions).toContain("Transporte: Streamable HTTP");
    expect(instructions).toContain("Authorization: Bearer <token>");
    expect(instructions).not.toContain("dsk_");
  });
});
