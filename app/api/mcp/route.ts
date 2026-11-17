/**
 * MCP server endpoint (Spec 11 §2 + §5.4).
 *
 * Streamable HTTP transport via `WebStandardStreamableHTTPServerTransport`
 * (Next.js App Router recebe Web `Request`). Stateless: cada request abre
 * um transport+server fresh. Auth via Bearer (`api_tokens`): colado à mão
 * (`dsk_…` da tela de API Tokens) ou emitido pelo OAuth do MCP
 * (`app/api/mcp/oauth/*`, migration 9390) — que emite o MESMO `dsk_`.
 *
 * NUNCA logamos plaintext do bearer. Em erro retornamos JSON-RPC 2.0
 * envelope com `error.code` MCP (-32001/-32002/etc).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createMcpServer } from "@/lib/mcp/server";
import { extractBearer, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { enderecosOAuth } from "@/lib/mcp/oauth/config";
import { desafioBearer } from "@/lib/mcp/oauth/metadados";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { chaveDaRequisicao } from "@/lib/api/idempotency";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function jsonRpcError(
  code: number,
  message: string,
  status: number,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      // #4107: o MESMO id que a rota põe na resposta de sucesso e no log.
      headers: { "content-type": "application/json", "X-Request-Id": requestId, ...extra },
    },
  );
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let auth;
  try {
    // Empresa suspensa entra marcada: o servidor só deixa a privacidade
    // responder (LGPD nunca é bloqueada — decisão do dono, 30/09).
    // `portaDoMcp`: aqui vale também o token da conexão OAuth (`aud:mcp`).
    auth = await validateBearerToken(req.headers.get("authorization"), { permiteOrgSuspensa: true, portaDoMcp: true });
  } catch (err) {
    if (err instanceof McpAuthError) {
      // O 401 diz ONDE conseguir um token (RFC 9728 §5.1): é por este
      // cabeçalho que o ChatGPT descobre o OAuth do CRM (migration 9390). O
      // `dsk_` colado à mão segue funcionando exatamente como antes.
      const desafio =
        err.httpStatus === 401
          ? { "WWW-Authenticate": desafioBearer(enderecosOAuth(), extractBearer(req.headers.get("authorization")) !== null) }
          : undefined;
      return jsonRpcError(err.mcpCode, err.message, err.httpStatus, requestId, desafio);
    }
    const msg = err instanceof Error ? err.message : "auth_failed";
    return jsonRpcError(-32603, msg, 500, requestId);
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
