import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/cold-call/resultado — o que aconteceu na ligação.
 *
 * Move ou encerra o lead pelos MESMOS caminhos do quadro (`moveLeadHandler`, `encerraDemanda`),
 * e deixa uma linha na timeline: é dela que saem as tentativas da fila.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  comMotivosDoColdCall,
  configDoFunil,
  motivoParaNaoLigar,
  RESULTADOS,
  resultadoSchema,
} from "@/lib/cold-call/regras";
import { seColdCallDesligado } from "@/lib/cold-call/modulo";
import { traduzir } from "@/lib/i18n/dicionario";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Funil criado antes de nascer com os motivos do Cold Call recusava todo encerramento com 422
 * `lost_reason_invalid` (#3941). Aqui eles entram antes de encerrar, uma vez só. Admin client
 * porque quem liga é `agent` e a RLS de `crm_pipelines` só deixa `manager` escrever; o alcance é
 * este funil desta organização, conferido de novo como cold call, e só a lista fixa do módulo.
 * Devolve se acrescentou; erro de banco sobe.
 */
async function garanteMotivosDoColdCall(orgId: string, pipelineId: string, lidos: unknown): Promise<boolean> {
  if (!comMotivosDoColdCall(lidos)) return false;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("crm_pipelines")
    .select("settings")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const settings = (data as { settings?: unknown } | null)?.settings;
  const novos = configDoFunil(settings) ? comMotivosDoColdCall(settings) : null;
  if (!novos) return false;
  // ponytail: ler e regravar `settings`; um salvar de Configurações no mesmo instante pode ser
  // sobrescrito. Merge atômico por RPC se isso aparecer.
  const { error: erroGravar } = await admin
    .from("crm_pipelines")
    .update({ settings: novos })
    .eq("id", pipelineId)
    .eq("organization_id", orgId);
  if (erroGravar) throw new Error(erroGravar.message);
  return true;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const desligado = await seColdCallDesligado(requestId);
  if (desligado) return desligado;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const lido = resultadoSchema.safeParse(await req.json().catch(() => null));
  if (!lido.success) return fail("unprocessable_entity", t("Escolha o resultado da ligação."), 422, { requestId });
  const { lead_id: leadId, resultado, nota } = lido.data;
  const regra = RESULTADOS[resultado];

  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id, stage_id, contact_id, crm_pipelines(settings)")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });

  const funil = lead.crm_pipelines as unknown as { settings: unknown } | null;
  if (!configDoFunil(funil?.settings)) {
    return fail("unprocessable_entity", t("Este lead não está no funil de cold call."), 422, { requestId });
  }

  // Quem pediu para não ser incomodado não recebe ligação — a regra da rota de voz
  // (app/api/v1/voice/calls/route.ts), com os mesmos códigos. Se não houve ligação, não há
  // resultado de ligação para gravar. "Tirado da fila" passa: é o gesto certo para esse contato.
  if (resultado !== "removido" && lead.contact_id) {
    const { data: contato, error: erroContato } = await supabase
      .from("contacts")
      .select("is_blocked, is_personal, is_anonymized")
      .eq("id", lead.contact_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (erroContato) return fail("internal_error", erroContato.message, 500, { requestId });
    const motivo = motivoParaNaoLigar(contato);
    if (motivo === "bloqueado") return fail("forbidden", t("Contato bloqueou o atendimento."), 403, { requestId });
    if (motivo === "pessoal") return fail("forbidden", t("Contato marcado como pessoal."), 403, { requestId });
    if (motivo === "anonimizado") {
      return fail("contact_anonymized", t("Contato anonimizado não pode ser chamado."), 422, { requestId });
    }
  }

  const ctx = { organization_id: orgId, actor: { type: "user" as const, id: authz.user.id }, requestId };
  const actor = ctx.actor;
  let motivosAcrescentados = false;

  try {
    if ("etapa" in regra) {
      const { data: etapa, error: erroEtapa } = await supabase
        .from("crm_stages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("pipeline_id", lead.pipeline_id)
        .eq("slug", regra.etapa)
        .maybeSingle();
      if (erroEtapa) return fail("internal_error", erroEtapa.message, 500, { requestId });
      if (!etapa) {
        return fail("unprocessable_entity", `${t("Falta a etapa no funil:")} ${t(regra.rotulo)}`, 422, { requestId });
      }
      if (etapa.id !== lead.stage_id) await moveLeadHandler(supabase, ctx, leadId, { to_stage_id: etapa.id });
    } else {
      motivosAcrescentados = await garanteMotivosDoColdCall(orgId, lead.pipeline_id, funil?.settings);
      await encerraDemanda(supabase, ctx, { leadId, desfecho: "lost", motivo: regra.rotulo });
    }
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  const gravada = await emitLeadActivity(supabase, {
    organizationId: orgId,
    leadId,
    contactId: lead.contact_id,
    type: "cold_call_result",
    sourceModule: "cold_call",
    actor,
    reason: nota ? `${regra.rotulo}: ${nota}` : regra.rotulo,
    payload: { resultado },
  });

  void audit({
    action: "cold_call.result",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_leads",
    resourceId: leadId,
    requestId,
    metadata: { resultado, historico_gravado: gravada.ok, motivos_acrescentados_ao_funil: motivosAcrescentados },
  });
  return ok({ resultado, historico_gravado: gravada.ok }, { requestId });
}
