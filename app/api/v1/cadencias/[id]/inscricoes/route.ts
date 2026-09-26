/**
 * GET  /api/v1/cadencias/:id/inscricoes — quem está (ou passou) por esta
 *      cadência, para a aba "Atividade".
 * POST /api/v1/cadencias/:id/inscricoes — põe UM lead na cadência. Inscrever
 *      é `agent`+ (é o vendedor quem decide "este lead entra"), diferente de
 *      montar a cadência (`manager`+) — mesma separação que a doutrina do
 *      construtor descreve.
 *
 * Esta rota NÃO envia e-mail: só cria a linha em `email_cadence_enrollments`
 * com `proximo_em = now()`. Quem lê essa fila e dispara o primeiro passo é o
 * worker do cron — ainda não escrito (ver MANIFEST da migration 0428).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { inscreverLeadSchema } from "@/lib/cadencias/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 50, 1), 200);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("email_cadence_enrollments")
    .select(
      "id, lead_id, contact_id, status, motivo_parada, origem, passo_atual_id, proximo_em, " +
        "emails_enviados, aberturas, cliques, concluida_em, parada_em, created_at",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("cadence_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id: cadenceId } = await ctx.params;

  const parsed = inscreverLeadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }
  const { lead_id } = parsed.data;

  const supabase = createAdminClient();

  const { data: cadencia } = await supabase
    .from("email_cadences")
    .select("id, status")
    .eq("organization_id", org.orgId)
    .eq("id", cadenceId)
    .maybeSingle();
  if (!cadencia) return fail("cadencia_nao_encontrada", t("Cadência não encontrada."), 404, { requestId });
  if ((cadencia as { status: string }).status !== "ativa") {
    return fail("cadencia_estado_invalido", t("Só uma cadência ativa aceita novas inscrições."), 409, { requestId });
  }

  // Confere o lead CONTRA A ORGANIZAÇÃO (mesmo motivo do `channel_sessions` em
  // `campaigns/route.ts`) e traz o e-mail do contato — sem ele não há para
  // onde mandar, e a inscrição nunca deveria nascer para nunca sair do lugar.
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id, contact_id, contacts:contact_id(id, email, is_anonymized)")
    .eq("organization_id", org.orgId)
    .eq("id", lead_id)
    .maybeSingle();
  const contato = (lead as { contacts?: { id: string; email: string | null; is_anonymized: boolean } | null } | null)
    ?.contacts;
  if (!lead || !contato) {
    return fail("cadencia_lead_indisponivel", t("Lead não encontrado nesta organização."), 409, { requestId });
  }
  if (!contato.email || contato.is_anonymized) {
    return fail("cadencia_lead_indisponivel", t("Este lead não tem e-mail para receber a cadência."), 409, {
      requestId,
    });
  }

  const { data, error } = await supabase
    .from("email_cadence_enrollments")
    .insert({
      organization_id: org.orgId,
      cadence_id: cadenceId,
      lead_id,
      contact_id: contato.id,
      status: "ativa",
      origem: "manual",
      inscrito_por: user.id,
    })
    .select("id, lead_id, contact_id, status, origem, proximo_em, created_at")
    .single();
  if (error) {
    // `email_cadence_enrollments_unica`: o mesmo lead já está nesta cadência.
    if ((error as { code?: string }).code === "23505") {
      return fail("cadencia_inscricao_existente", t("Este lead já está nesta cadência."), 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const inscricao = data as unknown as { id: string };
  await supabase.from("email_cadence_events").insert({
    organization_id: org.orgId,
    cadence_id: cadenceId,
    enrollment_id: inscricao.id,
    lead_id,
    tipo: "inscrito",
    ator_user_id: user.id,
  });

  void audit({
    action: "cadencia.lead_inscrito",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "email_cadence_enrollment",
    resourceId: inscricao.id,
    requestId,
    metadata: { cadence_id: cadenceId, lead_id },
  });

  return ok(data, { requestId, status: 201 });
}
