import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/retomar — retomar um negócio perdido como NEGÓCIO
 * NOVO (issue #1538).
 *
 * É a porta que o 409 `reabertura_cria_novo` aponta: num funil
 * `settings.reabertura = "novo_negocio"`, mover um card encerrado para uma
 * etapa aberta não reabre o registro — devolve este código e a tela oferece
 * "Retomar como novo negócio", que chama cá.
 *
 * A criação é o `retomarLeadHandler` (o MESMO caminho que a tool MCP
 * `crm_retomar_lead` usa): o negócio novo nasce com `source = "retomada"` e
 * `retomado_de_lead_id` apontando para a origem, que NÃO é tocada — status,
 * motivo e linha do tempo dela ficam intactos. Como toda criação passa pelo
 * `createLeadHandler`, o `lead.created` é disparado igual a de um lead novo.
 *
 * 201, como `POST /api/v1/leads` e como o `/clone`: aqui se cria um recurso.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { retomarLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { retomarLeadSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only) — a MESMA régua do arrasto
  // que esta rota substitui quando a retomada é a saída.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const handlerCtx: HandlerCtx = {
    organization_id: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };

  try {
    const input = await validateRequest(retomarLeadSchema, req);

    // Sem `audit()` próprio aqui: a criação JÁ é auditada como `lead.created`
    // pelo `createLeadHandler`, com o ator do ctx. Uma segunda linha com a
    // mesma ação seria ruído (o repo separa `lead.imported` de `lead.created`
    // justamente para não contar pela terceira vez) — a marca de retomada é a
    // LINHA do lead novo: `source = "retomada"` e `retomado_de_lead_id`.
    const lead = await retomarLeadHandler(supabase, handlerCtx, leadId, {
      stage_id: input.stage_id,
    });

    return ok({ lead }, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
