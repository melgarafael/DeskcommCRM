import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ARQUIVO DE OUTRA CONVERSA, PELA ROTA MCP DE VERDADE (#5034).
 *
 * `crm_send_whatsapp_message` aceita `media_storage_path`. Quem confere a posse é o
 * envio do Inbox, com a régua `isMediaPathOwnedBy` (organização E conversa). Aqui o
 * servidor MCP e a ferramenta são os reais; do envio, só a primeira coisa que ele faz
 * com o caminho (a régua real) — banco, Storage e canal ficam de fora. O cliente MCP
 * tem de receber a recusa como erro, nada pode sair, e a auditoria não guarda nem o
 * caminho nem o nome do arquivo.
 */
const auditSpy = vi.fn();
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: async () => {} }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));
const enviado = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/v1/messages/_handler", async () => {
  const { isMediaPathOwnedBy } = await import("@/lib/messaging/media/upload-validation");
  const { ApiError } = await import("@/lib/api/types");
  return {
    sendMessageHandler: vi.fn(async (_db: unknown, ctx: { organization_id: string }, input: { conversation_id: string; media_storage_path?: string }) => {
      if (input.media_storage_path && !isMediaPathOwnedBy(input.media_storage_path, ctx.organization_id, input.conversation_id)) {
        throw new ApiError(422, "invalid_media_path", undefined, "req-1", "media_storage_path fora da conversa.");
      }
      enviado(input);
      return { id: "m1", status: "sent", external_id: "x", sent_at: "2026-11-20T12:00:00.000Z" };
    }),
  };
});
vi.mock("@/lib/mcp/tools", async () => ({
  allTools: [(await import("@/lib/mcp/tools/messages")).crmSendWhatsappMessage],
}));

const { createMcpServer } = await import("@/lib/mcp/server");
const { registrarEnvioPorToken } = await import("@/lib/messaging/ritmo-do-envio-por-token");

const ORG = "00000000-0000-4000-8000-000000000001";
const CONV = "44444444-4444-4444-8444-444444444444";

async function chamar(path: string) {
  const server = createMcpServer(
    { organizationId: ORG, role: "admin", actor: { type: "user", id: "00000000-0000-4000-8000-000000000002" },
      apiTokenId: "tok", scopes: ["mcp:write"] },
    "req-1",
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const resultado = await client.callTool({
    name: "crm_send_whatsapp_message",
    arguments: { conversation_id: CONV, type: "document", media_storage_path: path, media_filename: "laudo-Maria.pdf" },
  });
  await client.close();
  return resultado;
}

beforeEach(() => {
  auditSpy.mockClear();
  enviado.mockClear();
  vi.mocked(registrarEnvioPorToken).mockClear();
});

describe("crm_send_whatsapp_message com arquivo do CRM, pela rota MCP (#5034)", () => {
  it("arquivo de outra conversa: o cliente recebe erro, nada sai, a auditoria não guarda caminho nem nome", async () => {
    const resultado = await chamar(`${ORG}/outra-conversa/out-1.pdf`);

    expect(resultado.isError).toBe(true);
    expect(JSON.stringify(resultado.content)).toMatch(/invalid_media_path|fora da conversa/);
    expect(enviado).not.toHaveBeenCalled();
    expect(registrarEnvioPorToken).not.toHaveBeenCalled();
    const auditoria = JSON.stringify(auditSpy.mock.calls);
    expect(auditoria).not.toContain("outra-conversa");
    expect(auditoria).not.toContain("Maria");
  });

  it("CONTROLE: arquivo desta conversa sai, com o caminho e o nome originais", async () => {
    const resultado = await chamar(`${ORG}/${CONV}/out-1.pdf`);

    expect(resultado.isError).toBeFalsy();
    expect(enviado).toHaveBeenCalledWith(
      expect.objectContaining({ media_storage_path: `${ORG}/${CONV}/out-1.pdf`, media_filename: "laudo-Maria.pdf" }),
    );
  });
});
