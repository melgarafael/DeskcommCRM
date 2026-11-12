/**
 * POST   /api/v1/leads/[id]/classificacao-comercial  — classifica como NÃO comercial
 * DELETE /api/v1/leads/[id]/classificacao-comercial  — devolve ao comercial
 *
 * A ação explícita na ficha do negócio (#4191). O corpo do POST leva o MOTIVO
 * declarado pela equipe; o DELETE não leva corpo — reverter é apagar as três
 * colunas, e o motivo anterior vai para a timeline antes de sumir.
 *
 * ─── Por que uma rota, e não `PATCH /leads/[id]` ────────────────────────────
 *
 * A classificação não é edição de campo: ela muda a elegibilidade do negócio
 * em Radar e métricas e NÃO muda o desfecho. Um `PATCH` genérico deixaria a
 * decisão entrar por qualquer cliente que editasse `crm_leads`, sem motivo
 * obrigatório, sem audit próprio e sem a trava de conflito. Aqui a operação tem
 * nome, corpo validado e idempotência.
 *
 * ─── Autorização ───────────────────────────────────────────────────────────
 *
 * Piso `agent` (mesmo do move e do next-action): `viewer` lê o quadro, não
 * decide sobre o negócio. A organização vem do cookie (`authz.org`), nunca do
 * corpo, e a linha é lida sob a RLS do caller — quem não vê o negócio recebe
 * 404, não 403 com a existência dele.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  classificaNegocioComoNaoComercial,
  reverteClassificacaoNaoComercial,
} from "@/lib/leads/classificacao-comercial";
import { MAX_MOTIVO_NAO_COMERCIAL } from "@/lib/leads/elegibilidade-comercial";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * O teto do Zod é o MESMO da régua pura: o corpo não pode ser recusado pelo
 * schema com uma frase diferente da que a tela mostra.
 */
const Body = z.object({
  motivo: z.string().max(MAX_MOTIVO_NAO_COMERCIAL * 5),
});

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Corpo inválido."), 422, {
      requestId,
      details: { issues: parsed.error.issues },
    });
  }

  const supabase = await createClient();
  const resultado = await classificaNegocioComoNaoComercial(supabase, {
    organizationId: authz.org.orgId,
    leadId,
    motivo: parsed.data.motivo,
    actorUserId: authz.user.id,
    requestId,
  });

  if (!resultado.ok) {
    return fail(resultado.codigo, t(resultado.mensagem), resultado.httpStatus, { requestId });
  }

  return ok(
    {
      lead_id: leadId,
      classificacao: "nao_comercial",
      ja_estava: resultado.jaEstava,
      lead: resultado.lead,
    },
    { requestId },
  );
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  // Reverter também é decisão sobre o negócio: o mesmo piso do classificar.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const resultado = await reverteClassificacaoNaoComercial(supabase, {
    organizationId: authz.org.orgId,
    leadId,
    actorUserId: authz.user.id,
    requestId,
  });

  if (!resultado.ok) {
    const t = (texto: string) => traduzir(texto, authz.user.idioma);
    return fail(resultado.codigo, t(resultado.mensagem), resultado.httpStatus, { requestId });
  }

  return ok(
    {
      lead_id: leadId,
      classificacao: "comercial",
      ja_estava: resultado.jaEstava,
      lead: resultado.lead,
    },
    { requestId },
  );
}
