/**
 * GET /api/v1/conversations/[id]/messages — histórico de mensagens (handler
 * em /app/api/v1/messages/_handler.ts → listMessagesHandler).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { extractBearer } from "@/lib/mcp/auth";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { listMessagesQuerySchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { comNomeDeQuemEnviou } from "@/lib/users/nome-de-quem-enviou";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;

  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "conversations",
      role: "viewer",
      scope: "mcp:read",
      tokenRole: "agent",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "conversations", requestId);
    if (teto) return teto;
    return responderMensagens(
      authz.supabase,
      authz.organizationId,
      conversationId,
      req,
      requestId,
      authz.actor,
      authz.idioma,
    );
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  return responderMensagens(
    supabase,
    activeOrg.orgId,
    conversationId,
    req,
    requestId,
    { type: "user", id: user.id },
    authUser?.idioma,
  );
}

async function responderMensagens(
  supabase: SupabaseClient,
  organizationId: string,
  conversationId: string,
  req: NextRequest,
  requestId: string,
  actor: Actor,
  idioma: Idioma | undefined,
): Promise<Response> {
  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");

  const url = new URL(req.url);
  const qsParsed = listMessagesQuerySchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!qsParsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const { messages, cursor, has_more } = await listMessagesHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      conversationId,
      qsParsed.data,
    );
    // #4031 — O NOME DE QUEM DA EQUIPE ENVIOU, no payload.
    //
    // O balão não faz consulta e a página é paginada por cursor, então o nome
    // entra AQUI: uma leitura por PÁGINA (ids distintos, deduplicados por
    // `nomesDosAtendentes`), e não uma por mensagem. Fica na rota, e não em
    // `listMessagesHandler`, porque o handler é o mesmo caminho das tools MCP,
    // que leem com o admin client e resolveriam o nome duas vezes.
    //
    // Só os ids de mensagens que o leitor JÁ recebeu alimentam o lookup — a RLS
    // de `messages` decidiu o que está na página antes de qualquer nome ser
    // resolvido, e o que sai é apenas `full_name` (mesmo mínimo do export em
    // PDF e de `team/assignable`). E só para quem é membro da org ativa: o
    // helper confere `user_organizations` antes de ler o nome.
    const mensagensComNome = await comNomeDeQuemEnviou(messages, organizationId);
    return ok(mensagensComNome, { requestId, meta: { cursor, has_more } });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
