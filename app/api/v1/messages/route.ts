import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { JANELA_SEGUNDOS, TETO_DE_ESCRITA, TETO_POR_ORGANIZACAO } from "@/lib/mcp/rate-limit";
import {
  depsDoRitmo,
  registrarEnvioPorToken,
  segurarEnvioPorToken,
  type EnvioSegurado,
} from "@/lib/messaging/ritmo-do-envio-por-token";
import { sendMessageSchema, validateRequest, type SendMessageInput } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  //
  // Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
  // porque esta rota é a porta de envio de quem não tem navegador: o gateway do
  // CRM que está sendo absorvido, e qualquer integração server-to-server. A org
  // nunca vem do corpo; no ramo do token ela sai da linha do token.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "messages",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  // Por token, esta rota é a mesma porta de escrita do MCP — e leva o mesmo
  // teto por token e agregado por organização (`lib/mcp/rate-limit.ts`, #1491).
  // Pela sessão do navegador não há teto: quem digita é uma pessoa.
  if (authz.via === "token") {
    const tokenId = actor.type === "ai_agent" ? (actor.api_token_id ?? actor.id) : actor.id;
    const teto = await checkRateLimit(`messages:tok:${tokenId}`, TETO_DE_ESCRITA, JANELA_SEGUNDOS);
    if (!teto.allowed) {
      return fail("rate_limited", "Too many requests.", 429, {
        requestId,
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }

    const tetoOrg = await checkRateLimit(
      `messages:org:${organizationId}`,
      TETO_POR_ORGANIZACAO,
      JANELA_SEGUNDOS,
    );
    if (!tetoOrg.allowed) {
      return fail("rate_limited", "Too many requests for organization.", 429, {
        requestId,
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }
  }

  let input;
  try {
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    // Freio anti-ban do número (espaçamento + teto diário), só para token:
    // ver o cabeçalho de `lib/messaging/ritmo-do-envio-por-token.ts`.
    const ritmo = authz.via === "token" ? await depsDoRitmo(createAdminClient()) : null;
    const segurado: EnvioSegurado = ritmo
      ? await segurarEnvioPorToken(ritmo, {
          organizationId,
          conversationId: (input as SendMessageInput).conversation_id,
          requestId,
        })
      : null;

    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      input as SendMessageInput,
    );
    if (ritmo) await registrarEnvioPorToken(ritmo, organizationId, segurado, message.status);
    return ok(message, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const retryAfter = (err.details as { retry_after_seconds?: number } | undefined)
        ?.retry_after_seconds;
      return fail(err.code, err.message, err.status, {
        requestId,
        ...(err.status === 429 && retryAfter
          ? { details: err.details as Record<string, unknown>, headers: { "Retry-After": String(retryAfter) } }
          : {}),
      });
    }
    throw err;
  }
}
