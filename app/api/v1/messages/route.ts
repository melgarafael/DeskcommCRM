import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
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
import { conversaFicaComQuemAtendeu } from "@/lib/schemas/routing";
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
    // Uma resposta humana pelo inbox assume uma conversa livre — SÓ quando a
    // empresa ligou "a conversa fica com quem atendeu" (settings.routing,
    // desligado por padrão). A RPC faz o claim condicional e registra a troca
    // de dono na mesma transação; se outro atendente chegou primeiro, não
    // tomamos a conversa dele. O envio já pode ter sido aceito pelo canal,
    // portanto falha do claim nunca vira erro de envio (o operador poderia
    // reenviar e duplicar a mensagem).
    if (authz.via === "session" && actor.type === "user" && message.status !== "failed") {
      try {
        const { data: org, error: orgError } = await supabase
          .from("organizations")
          .select("settings")
          .eq("id", organizationId)
          .maybeSingle();
        if (orgError) throw orgError;
        if (conversaFicaComQuemAtendeu(org?.settings)) {
          const { data: claimed, error: claimError } = await supabase.rpc("fn_conversation_assign", {
            p_organization_id: organizationId,
            p_conversation_id: message.conversation_id,
            p_to_user_id: actor.id,
            p_reason: "claim",
            p_enforce_expected: true,
          });
          if (claimError) throw claimError;
          if (claimed?.[0]) {
            await audit({
              action: "conversation.claimed",
              actorUserId: actor.id,
              organizationId,
              resourceType: "conversation",
              resourceId: message.conversation_id,
              requestId,
            });
            // A mesma linha na linha do tempo que o botão Assumir deixa: sem ela,
            // a conversa mudaria de dono sem nenhum registro à vista de quem atende.
            await registrarTrocaDeComando({
              supabase,
              organizationId,
              conversationId: message.conversation_id,
              contactId: (claimed[0] as { contact_id: string | null }).contact_id,
              tipo: "conversation_claimed",
              actor,
              motivo: "Assumiu o atendimento desta conversa",
            });
            // O mesmo evento que o botão Assumir emite.
            const { error: emitErr } = await supabase.rpc("emit_event", {
              p_event_type: "conversation.claimed",
              p_entity_kind: "conversation",
              p_entity_id: message.conversation_id,
              p_payload: { assigned_to_user_id: actor.id },
              p_metadata: { request_id: requestId },
              p_organization_id: organizationId,
            });
            if (emitErr) console.error("[messages.send] emit_event failed", emitErr.message);
          }
        }
      } catch (claimError) {
        console.error("[messages.send] claim after reply failed", claimError);
      }
    }
    if (ritmo) await registrarEnvioPorToken(ritmo, organizationId, segurado, message.status);
    return ok(message, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      const retryAfter = (err.details as { retry_after_seconds?: number } | undefined)
        ?.retry_after_seconds;
      return fail(err.code, err.message, err.status, {
        requestId,
        ...(err.status === 429 && retryAfter
          ? {
              details: err.details as Record<string, unknown>,
              headers: { "Retry-After": String(retryAfter) },
            }
          : {}),
      });
    }
    throw err;
  }
}
