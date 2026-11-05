/**
 * MCP server endpoint (Spec 11 §2 + §5.4).
 *
 * Streamable HTTP transport via `WebStandardStreamableHTTPServerTransport`
 * (Next.js App Router recebe Web `Request`). Stateless: cada request abre
 * um transport+server fresh. Auth via Bearer (`api_tokens`).
 *
 * NUNCA logamos plaintext do bearer. Em erro retornamos JSON-RPC 2.0
 * envelope com `error.code` MCP (-32001/-32002/etc).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { MENSAGEM_DA_RECUSA_DO_MODULO, MODULO_NAO_ENTRA_AQUI } from "@/lib/auth/modulo-autorizado";
import { createMcpServer } from "@/lib/mcp/server";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function jsonRpcError(code: number, message: string, status: number, requestId: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      // #4107: o MESMO id que a rota põe na resposta de sucesso e no log.
      headers: { "content-type": "application/json", "X-Request-Id": requestId },
    },
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let auth;
  try {
    // Empresa suspensa entra marcada: o servidor só deixa a privacidade
    // responder (LGPD nunca é bloqueada — decisão do dono, 30/09).
    auth = await validateBearerToken(req.headers.get("authorization"), { permiteOrgSuspensa: true });
  } catch (err) {
    if (err instanceof McpAuthError) {
      return jsonRpcError(err.mcpCode, err.message, err.httpStatus, requestId);
    }
    const msg = err instanceof Error ? err.message : "auth_failed";
    return jsonRpcError(-32603, msg, 500, requestId);
  }

  // Token de MÓDULO não entra no servidor MCP (spec 33, F3): ele lê pelos escopos do token e não
  // passa pela área consentida. Recusa antes de qualquer ferramenta.
  if (auth.actor.type === "module") {
    return jsonRpcError(-32002, MENSAGEM_DA_RECUSA_DO_MODULO[MODULO_NAO_ENTRA_AQUI], 403);
  }

  const idempotencyKey = chaveDaRequisicao(req);
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return jsonRpcError(-32602, "Idempotency-Key deve ser UUID", 400, requestId);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({});
  const admin = createAdminClient();
  const server = createMcpServer(
    auth,
    requestId,
    await modulosLigados(admin),
    await capacidadesDaOrganizacao(admin, auth.organizationId),
    idempotencyKey ?? undefined,
  );

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req as unknown as Request);
    response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "transport_error";
    return jsonRpcError(-32603, msg, 500, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}
