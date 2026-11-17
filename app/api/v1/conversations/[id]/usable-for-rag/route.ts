import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/usable-for-rag
 *
 * Agent-toggle for the RAG opt-in flag (LGPD L-08). When enabled, the
 * conversation becomes eligible for the daily kb-conversations-batch cron,
 * which anonymizes + chunks + embeds the dialogue into the agent's KB.
 *
 * Desmarcar (enabled=false) também tira de `ai_chunks` os trechos que a
 * ingestão já gravou desta conversa (#3042, migration 0688): só zerar a flag
 * impede as ingestões futuras, e o retriever continuaria trazendo o que já foi
 * aprendido. Desmarcar e marcar de novo não reingere na hora: a conversa volta
 * ao acervo no próximo lote.
 *
 * Auth: cookie session, role >= agent.
 * Audit: action `conversation.usable_for_rag_toggled` with prev/next values
 * (and `trechos_removidos` when disabling).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import { validateRequest } from "@/lib/schemas/_validate";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ enabled: z.boolean() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authHeader = req.headers.get("authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader.trim())) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "conversations",
      role: "agent",
      scope: "mcp:write",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
    const { organizationId } = authz;
    const supabase = authz.supabase;
    const actorId = authz.actor.type === "user" ? authz.actor.id : null;
    const actorApiTokenId = authz.apiTokenId ?? null;
    return responderRag(supabase, organizationId, id, req, requestId, t, actorId, actorApiTokenId);
  }

  // Caminho de sessão: byte a byte igual.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;
  const supabase = await createClient();
  return responderRag(supabase, activeOrg.orgId, id, req, requestId, t, authUser.id, null);
}

async function responderRag(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  req: NextRequest,
  requestId: string,
  t: (texto: string) => string,
  actorId: string | null,
  actorApiTokenId: string | null,
): Promise<Response> {
  let input;
  try {
    input = await validateRequest(bodySchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Read prev value first to put it in the audit payload (best-effort).
  const { data: prevRow } = await supabase
    .from("conversations")
    .select("usable_for_rag")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  const prev = (prevRow as { usable_for_rag: boolean } | null)?.usable_for_rag ?? null;

  const nowIso = new Date().toISOString();
  const update = input.enabled
    ? {
        usable_for_rag: true,
        usable_for_rag_marked_at: nowIso,
        usable_for_rag_marked_by: actorId,
        rag_review_status: null,
      }
    : {
        usable_for_rag: false,
        usable_for_rag_marked_at: null,
        usable_for_rag_marked_by: null,
        rag_review_status: null,
      };

  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select("id, usable_for_rag")
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  // O org vem da sessão/token, nunca do corpo; a função confere que a
  // conversa é dele antes de apagar.
  let trechosRemovidos: number | undefined;
  if (!input.enabled) {
    const { data: removidos, error: trechosErro } = await createAdminClient().rpc(
      "fn_conversa_remove_trechos_do_rag",
      { p_org: organizationId, p_conversation: conversationId },
    );
    if (trechosErro) {
      return fail("internal_error", trechosErro.message, 500, { requestId });
    }
    trechosRemovidos = (removidos as number | null) ?? 0;
  }

  await audit({
    action: "conversation.usable_for_rag_toggled",
    actorUserId: actorId,
    actorApiTokenId,
    organizationId,
    resourceType: "conversation",
    resourceId: conversationId,
    metadata: {
      conversation_id: conversationId,
      enabled: input.enabled,
      prev,
      ...(trechosRemovidos === undefined ? {} : { trechos_removidos: trechosRemovidos }),
    },
    requestId,
  });

  return ok(
    trechosRemovidos === undefined ? data : { ...data, trechos_removidos: trechosRemovidos },
    { requestId },
  );
}
