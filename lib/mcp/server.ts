/**
 * Core do MCP server (Spec 11 §5.3).
 *
 * `createMcpServer(authResult, requestId)` retorna instancia `McpServer` com
 * todas as tools desta wave registradas. Cada tool e exposta com:
 *   - Zod raw shape como inputSchema (registerTool aceita ZodRawShape).
 *   - Handler async que (a) checa role + scope, (b) chama o handler da
 *     wave 2, (c) audita em api_audit_log, (d) retorna content[] padrao
 *     MCP. Erros viram `{ isError: true, content: [...] }` (e o codigo
 *     MCP fica no metadata, nao no JSON-RPC error envelope).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { auditMcpToolCall } from "./audit";
import { ensureRole, ensureScope, type McpAuthResult } from "./auth";
import { allTools } from "./tools";
import { higienizarUuidsDeAterro } from "./uuid-de-aterro";
import type { McpContext } from "./types";

const SERVER_NAME = "deskcomm-crm";
const SERVER_VERSION = "0.1.0";

function summarizeResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.contacts)) return `${r.contacts.length} contacts`;
  if (Array.isArray(r.conversations)) return `${r.conversations.length} conversations`;
  if (Array.isArray(r.messages)) return `${r.messages.length} messages`;
  if (typeof r.id === "string") return `id=${r.id}`;
  return undefined;
}

export function createMcpServer(auth: McpAuthResult, requestId: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const supabase = createAdminClient();

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (rawArgs) => {
        const startedAt = Date.now();
        // A MESMA higiene do outro ingresso (`lib/ai/runtime/tools.ts`), pela
        // mesma razão: um uuid de aterro em campo opcional vira filtro por um
        // id que não existe, e o resultado vazio é lido como "não há". Aqui é o
        // caminho do MCP externo; lá é o do agente. Os dois entram no mesmo
        // handler, então os dois higienizam — deixar um de fora seria fechar a
        // porta e esquecer a janela. Ver `lib/mcp/uuid-de-aterro.ts`.
        const higiene = higienizarUuidsDeAterro(
          tool.inputSchema as Record<string, z.ZodTypeAny>,
          (rawArgs ?? {}) as Record<string, unknown>,
        );
        const args = higiene.limpos;
        const argsAudit = tool.redigirParaAuditoria ? tool.redigirParaAuditoria(args) : args;
        const ctx: McpContext = {
          organizationId: auth.organizationId,
          role: auth.role,
          actor: auth.actor,
          apiTokenId: auth.apiTokenId,
          requestId,
          supabase,
        };

        try {
          ensureScope(auth.scopes, tool.requiresScope);
          ensureRole(auth.role, tool.requiresRole);

          const result = await tool.handler(args as never, ctx);
          const durationMs = Date.now() - startedAt;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args: argsAudit,
            durationMs,
            success: true,
            resultSummary: summarizeResult(result),
          });

          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown_error";
          const durationMs = Date.now() - startedAt;

          await auditMcpToolCall({
            ctx,
            toolName: tool.name,
            args: argsAudit,
            durationMs,
            success: false,
            errorMessage: message,
          });

          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }

  return server;
}
