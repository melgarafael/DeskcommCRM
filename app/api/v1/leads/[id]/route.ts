import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/leads/[id] — update lead (handler em ../_handler.ts).
 *
 * Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
 * mesma dualidade de `/api/v1/messages`: a integração de monitoramento
 * processual (n8n consultando Escavador/Jusbrasil/Codilo/Judit) atualiza o
 * campo personalizado "Andamento atual" por aqui, sem navegador. A org nunca
 * vem do corpo — no ramo do token ela sai da linha do token
 * (`lib/api/auth-dual.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { updateLeadSchema, validateRequest } from "@/lib/schemas";

import { updateLeadHandler } from "../_handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/leads/[id] — o negócio, como o banco o tem AGORA (#4151).
 *
 * ─── Por que esta rota nasceu com a página inteira ─────────────────────────
 *
 * A gaveta lê o lead do cache do quadro: qualquer escrita passa pelo quadro e o
 * cache acompanha. A PÁGINA do negócio não carrega o funil inteiro (é a leitura
 * cara que a aba Lista existe para não pagar; `useBoard` diz o porquê), então
 * ela não tem cache de onde tirar o `updated_at` de agora.
 *
 * E o `updated_at` não é detalhe: `.../move` é OCC (P-08) e recusa com 409
 * quando a régua enviada não é a vigente. Editar um campo e depois mudar a
 * etapa no mesmo minuto mandaria a régua de antes da edição — "modificado por
 * outro usuário" para a própria pessoa que acabou de editar. Esta leitura é a
 * que o `mover` da página faz antes de escrever, e é por isso que ela devolve a
 * LINHA INTEIRA (todas as colunas do lead), não um resumo.
 *
 * `viewer` é o piso, como na lista do funil: ler um negócio é a mesma permissão
 * de abrir o quadro. Escrever continua sendo `agent`+ nas rotas de escrita.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_leads")
    .select("*")
    // O mesmo filtro de organização da página do lead: a RLS enxerga todas as
    // organizações do usuário, e sem ele um id de outra org leria uma linha que
    // a tela ativa não deveria mostrar.
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("resource_not_found", "Negócio não encontrado.", 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_leads",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const { supabase, organizationId, actor, idioma } = authz;

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "leads", requestId);
  if (tetoEstourado) return tetoEstourado;

  let input;
  try {
    input = await validateRequest(updateLeadSchema, req);
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
    const updated = await updateLeadHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      leadId,
      input,
    );
    return ok(updated, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
