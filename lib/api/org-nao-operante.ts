import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import type { ActiveOrg } from "@/lib/auth/types";
import { ehOperante } from "@/lib/organizacao/operante";

/**
 * Guarda única de ROTA /api/v1 para ORGANIZAÇÃO NÃO OPERANTE.
 *
 * `resolveActiveOrg` redireciona (`redirect("/account-suspended")`) quando a
 * empresa não opera — comportamento certo para página (leva o operador ao hub
 * para pagar ou pedir LGPD), errado para API: o redirect vira um **307 para
 * HTML**, e o cliente (`lib/api/client.ts`) não leva ninguém a lugar nenhum; o
 * bloqueio acontece, a resposta é que vem no formato errado (issue #2001).
 *
 * Rotas de API resolvem a org por `orgAtivaSemPortao` (o corpo de `resolveActiveOrg`
 * SEM o portão do redirect) e passam o resultado por esta guarda, que responde
 * **403 `org_suspended` em JSON** — o mesmo código que `requireRole` já devolve
 * e que a tela reconhece para mandar o usuário ao hub.
 *
 * Uso: após resolver a org,
 *   const suspende = respostaDeOrgSuspensa(activeOrg, requestId);
 *   if (suspende) return suspende;
 */
export function respostaDeOrgSuspensa(
  org: Partial<ActiveOrg> | null | undefined,
  requestId?: string,
  mensagem = "A conta desta empresa está suspensa.",
): NextResponse<ApiError> | null {
  if (org && !ehOperante(org.org_status)) {
    return fail("org_suspended", mensagem, 403, { requestId });
  }
  return null;
}