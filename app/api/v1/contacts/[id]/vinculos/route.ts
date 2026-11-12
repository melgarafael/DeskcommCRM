/**
 * GET /api/v1/contacts/[id]/vinculos — o que a exclusão VAI encontrar, sem
 * apagar nada (issue #1925).
 *
 * POR QUE EXISTE: a recusa já era nomeada só DEPOIS do clique (409 com
 * `error.details`), e o diálogo "Excluir contato?" dizia que a ação não pode ser
 * desfeita sem avisar que a agenda vai barrar. O diálogo consulta esta rota ao
 * abrir e mostra a frase — antes de a pessoa tentar.
 *
 * Sem lista própria: o handler devolve a MESMA contagem do DELETE, filtrada pela
 * organização do chamador, então outra organização não enxerga vínculo alheio e
 * a tela não pode discordar do servidor sobre o que barra. Só-sessão, como o
 * restante de `contacts` — `requireRole("viewer")` (ler é o menor privilégio).
 *
 * Sessão OU token de integração (Spec 33, R2): `mcp:read` e papel `viewer`. A
 * organização sai da sessão ou da LINHA DO TOKEN, e o handler filtra por ela as
 * duas leituras (a ficha e a contagem).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";

import { vinculosDoContatoHandler } from "../../_handler";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;

  try {
    const result = await vinculosDoContatoHandler(
      authz.supabase,
      {
        organization_id: authz.organizationId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
      },
      id,
    );
    return ok(result, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
