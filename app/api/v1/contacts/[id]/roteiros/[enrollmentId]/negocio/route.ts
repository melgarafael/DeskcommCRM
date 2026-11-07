/**
 * POST /api/v1/contacts/:id/roteiros/:enrollmentId/negocio (manager+) — a
 * ESCOLHA do negócio desta execução do roteiro (#3363).
 *
 * Existe porque a decisão de produto veda o default: com mais de um card aberto,
 * a execução NÃO escolhe "o mais recente" — ela fica sem destino até alguém
 * dizer qual é. A escolha vale até o roteiro terminar (o vínculo é gravado na
 * trilha da execução, com chave fixa) e não pode ser trocada depois: trocar o
 * destino no meio é exatamente o redirecionamento que a decisão proíbe, e é por
 * isso que a rota devolve o vínculo EXISTENTE em vez de sobrescrevê-lo.
 *
 * Guardas, na ordem: módulo desligado ⇒ 404 (a porta não existe); enrollment de
 * outro contato/organização ⇒ 404; execução já encerrada ⇒ 409; card que não é
 * um negócio ABERTO deste contato ⇒ 422. A escrita passa pelo cliente de SESSÃO
 * (RLS: `followup_enrollment_events` só aceita insert de `manager`+), o mesmo
 * caminho que a policy da 0490 desenhou.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O mesmo tipo/chave do vínculo em `lib/followup/negocio-do-roteiro.ts`. */
const EVENTO_DO_VINCULO = "roteiro_negocio";
const CHAVE_DO_VINCULO = "roteiro_negocio";

type RouteCtx = { params: Promise<{ id: string; enrollmentId: string }> };

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  // Acompanhamento administrativo em modo leitura não escolhe o negócio: a
  // guarda de efeito vem antes de tudo, como nas demais rotas mutantes.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, enrollmentId } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(enrollmentId)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  // Sessão OU token de integração (Spec 33, R2): `mcp:write` e papel `manager`.
  // A organização sai da sessão ou da LINHA DO TOKEN.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "contacts", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  if (!(await moduloLigado(createAdminClient(), "fluxos_atendimento"))) {
    return fail("not_found", t("Recurso não encontrado."), 404, { requestId });
  }

  let corpo: { lead_id?: unknown };
  try {
    corpo = (await req.json()) as { lead_id?: unknown };
  } catch {
    return fail("invalid_request", "JSON inválido.", 400, { requestId });
  }
  const leadId = corpo.lead_id;
  if (typeof leadId !== "string" || !UUID_RX.test(leadId)) {
    return fail("invalid_request", t("Escolha o negócio."), 400, { requestId });
  }

  const supabase = authz.supabase;

  // 1. A execução precisa ser DESTE contato, desta organização e estar viva.
  const { data: enrollment, error: enrollmentErr } = await supabase
    .from("followup_enrollments")
    .select("id, status, contact_id")
    .eq("id", enrollmentId)
    .eq("organization_id", authz.organizationId)
    .eq("contact_id", id)
    .maybeSingle();
  if (enrollmentErr) return fail("internal_error", enrollmentErr.message, 500, { requestId });
  if (!enrollment) return fail("not_found", t("Roteiro não encontrado."), 404, { requestId });
  if (enrollment.status !== "coletando") {
    // Execução encerrada não escolhe nada: a próxima resolve de novo.
    return fail("not_live", t("Este roteiro já terminou."), 409, { requestId });
  }

  // 2. O card escolhido precisa ser um negócio ABERTO do mesmo contato.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, status, contact_id")
    .eq("id", leadId)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead || lead.contact_id !== id || lead.status !== "open") {
    return fail("invalid_lead", t("Negócio inválido para este contato."), 422, { requestId });
  }

  // 3. PRIMEIRO VENCE: se já há vínculo, ele é o que vale — a rota devolve o
  // existente em vez de trocar o destino no meio da execução.
  const { data: existente, error: vinculoErr } = await supabase
    .from("followup_enrollment_events")
    .select("payload")
    .eq("organization_id", authz.organizationId)
    .eq("enrollment_id", enrollmentId)
    .eq("event_type", EVENTO_DO_VINCULO)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (vinculoErr) return fail("internal_error", vinculoErr.message, 500, { requestId });
  const jaFixado = (existente?.payload as { lead_id?: unknown } | null | undefined)?.lead_id;
  if (typeof jaFixado === "string" && jaFixado !== "") {
    return ok({ lead_id: jaFixado }, { requestId });
  }

  const { error: insertErr } = await supabase.from("followup_enrollment_events").insert({
    organization_id: authz.organizationId,
    enrollment_id: enrollmentId,
    node_id: null,
    event_type: EVENTO_DO_VINCULO,
    payload: { lead_id: leadId },
    idempotency_key: CHAVE_DO_VINCULO,
  });
  if (insertErr) {
    // Corrida com outra pessoa clicando junto: o índice único de idempotência
    // recusa o segundo e o vínculo gravado é o primeiro. Devolver 23505 seria
    // dizer "falhou" para quem só perdeu a corrida por milissegundos.
    if (insertErr.code !== "23505") {
      return fail("internal_error", insertErr.message, 500, { requestId });
    }
    const { data: gravado } = await supabase
      .from("followup_enrollment_events")
      .select("payload")
      .eq("organization_id", authz.organizationId)
      .eq("enrollment_id", enrollmentId)
      .eq("event_type", EVENTO_DO_VINCULO)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const efetivo = (gravado?.payload as { lead_id?: unknown } | null | undefined)?.lead_id;
    return ok({ lead_id: typeof efetivo === "string" ? efetivo : leadId }, { requestId });
  }

  // A escolha é um ato de uma PESSOA: a trilha do roteiro não tem coluna de
  // autor, e a autoria de quem escolheu fica no log de auditoria — o mesmo lugar
  // das outras ações de `manager` sobre a execução.
  void audit({
    action: "followup_enrollment.negocio_escolhido",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "followup_enrollment",
    resourceId: enrollmentId,
    requestId,
    metadata: { lead_id: leadId, contact_id: id },
  });

  return ok({ lead_id: leadId }, { requestId });
}
