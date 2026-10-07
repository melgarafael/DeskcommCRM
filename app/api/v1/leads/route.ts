import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads — create lead (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  AVISO_NEGOCIO_ABERTO_EXISTENTE,
  negocioAbertoExistente,
} from "@/lib/leads/negocio-aberto-duplicado";
import { createLeadSchema, validateRequest, type CreateLeadInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { createLeadHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createLeadSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();

  // ─── AVISO DE NEGÓCIO ABERTO DUPLICADO (issue #1751) ───────────────────────
  //
  // Antes do INSERT, porque o aviso descreve o mundo em que a pessoa pediu a
  // criação — consultado depois, o negócio NOVO entraria na própria contagem.
  //
  // A consulta nunca recusa: a migration 0256 decidiu que um cliente PODE ter
  // dois negócios abertos, então o segundo nasce e a resposta traz
  // `meta.avisos: ["negocio_aberto_existente"]` com o negócio que já existe,
  // para a tela mostrar o aviso com link. Sem contato não há o que perguntar —
  // lead órfão é caminho legítimo (#852).
  const negocioExistente = input.contact_id
    ? await negocioAbertoExistente(supabase, {
        organizationId: activeOrg.orgId,
        contactId: input.contact_id,
        pipelineId: input.pipeline_id,
      })
    : null;

  try {
    const lead = await createLeadHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: authUser.id },
        requestId,
        idioma: authUser.idioma,
      },
      input as CreateLeadInput,
    );
    return ok(lead, {
      requestId,
      status: 201,
      // `meta` só quando há aviso: uma resposta sem `meta` continua sem
      // `meta`, e o que muda é acrescentar, nunca esconder.
      ...(negocioExistente
        ? {
            meta: {
              avisos: [AVISO_NEGOCIO_ABERTO_EXISTENTE],
              negocio_aberto_existente: negocioExistente,
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
