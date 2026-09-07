import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH/DELETE /api/v1/pipelines/[id]/stages/[stageId] — renomear, marcar
 * ganho/perda, reordenar e arquivar uma etapa.
 *
 * ⚠️ DELETE ARQUIVA, NÃO APAGA. `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT`:
 * etapa com negócio não pode ser apagada — e não deveria mesmo, porque o
 * histórico dos negócios aponta para ela. Por isso a operação é arquivar, e por
 * isso arquivar exige destino para os negócios (`?destino=<id>`).
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. As regras e a ORDEM das escritas (que é o que os
 * índices únicos imediatos cobram) vivem em `lib/leads/stage-operations.ts`,
 * compartilhadas com o agente de IA — BRIEFING §3, Decisão 4.
 *
 * Auth: sessão por cookie, papel manager+. `organization_id` sai do JWT — nunca
 * do body nem da URL.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { arquivarEtapa, atualizarEtapa } from "@/lib/leads/stage-operations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; stageId: string }>;
}

/**
 * `depois_de` é o vizinho da ESQUERDA (`null` = primeira coluna), não um número
 * de posição: quem arrasta a coluna sabe onde ela caiu, não qual fração de
 * `position` isso vira. Mandar o número da tela duplicaria a conta que
 * `posicaoEntre` já faz — e as duas divergiriam no primeiro ajuste.
 */
const bodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    is_won: z.boolean().optional(),
    is_lost: z.boolean().optional(),
    depois_de: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;

  const { id: pipelineId, stageId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Não entendi o que mudar nesta etapa.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  try {
    const { funil } = await atualizarEtapa(
      {
        supabase,
        organizationId: authz.org.orgId,
        actor: { type: "user", id: authz.user.id, role: authz.org.role },
        requestId,
      },
      { pipelineId, stageId, pedido: parsed.data },
    );
    return ok(funil, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;

  const { id: pipelineId, stageId } = await ctx.params;
  const destinoId = req.nextUrl.searchParams.get("destino");

  const supabase = await createClient();
  try {
    const { funil } = await arquivarEtapa(
      {
        supabase,
        organizationId: authz.org.orgId,
        actor: { type: "user", id: authz.user.id, role: authz.org.role },
        requestId,
      },
      { pipelineId, stageId, destinoId },
    );
    return ok(funil, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
