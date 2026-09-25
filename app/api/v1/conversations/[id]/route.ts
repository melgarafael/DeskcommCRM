import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/conversations/[id] — single conversation (handler em ../_handler.ts)
 * PATCH /api/v1/conversations/[id] — update status e/ou tags (handler em ../_handler.ts)
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { patchConversationSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { comNomeDoAtendente } from "@/lib/users/com-nome-do-atendente";

import { getConversationHandler, patchConversationHandler } from "../_handler";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * O `[id]` da rota é INPUT EXTERNO — tanto quanto um body — e por isso passa por
 * Zod antes de virar consulta (doutrina: "Zod valida todo input externo").
 *
 * Sem isto, `/api/v1/conversations/undefined` chegava ao `.eq("id", …)` de uma
 * coluna `uuid`, o Postgres devolvia `22P02` (*invalid input syntax*), e o
 * handler traduzia QUALQUER erro de banco para **500**. Dois estragos:
 *
 *  - um 500 evitável no log do servidor, de um id que nunca teve chance;
 *  - a tela ficava MUDA. `InboxLayout` só acende "Conversa não encontrada ou
 *    fora do seu acesso" quando o erro é 404 (`isNotFound` é `status === 404`),
 *    então o usuário via uma conversa vazia — indistinguível de uma conversa
 *    sem mensagens. Issue #1367.
 *
 * **DEPOIS da autorização, nunca antes.** `rbac-matrix.test.ts` pegou a versão
 * anterior deste conserto: com a guarda no topo, um `viewer` mandando `PATCH`
 * com id malformado recebia 404 em vez de 403. Quem não pode escrever não pode
 * nem chegar à pergunta sobre o id — e o mesmo `agenda/agendamentos/[id]` que
 * serve de precedente aqui valida o uuid DEPOIS do `requireRole`.
 *
 * **404 e não 422**, e o precedente é da casa: `agenda/agendamentos/[id]`
 * responde `fail("not_found", …, 404)` para id malformado. Num GET por id, "não
 * é um uuid" e "não existe" são a mesma resposta para quem pergunta — e devolver
 * 422 aqui só trocaria o 500 por outro código que a tela também não trata.
 */
function idInvalido(id: string): boolean {
  return !z.uuid().safeParse(id).success;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
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
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }
  if (idInvalido(id)) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  try {
    const conv = await getConversationHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: authUser?.idioma,
      },
      id,
    );
    // Mesma razão da listagem: o nome entra na borda HTTP, não no handler que o
    // MCP compartilha. Aqui é UM lookup, não N.
    const [comNome] = await comNomeDoAtendente([conv]);
    return ok(comNome ?? conv, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;
  if (idInvalido(id)) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  let input;
  try {
    input = await validateRequest(patchConversationSchema, req);
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
    const conv = await patchConversationHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
        idioma: user.idioma,
      },
      id,
      input,
    );
    return ok(conv, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
