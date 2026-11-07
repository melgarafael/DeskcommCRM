import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { cancelaRetornoNoCrm } from "@/lib/followup/retorno-crm";
import { logger } from "@/lib/logger";
import { traduzir } from "@/lib/i18n/dicionario";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";
const bodySchema = z.object({
  decisao: z.enum(["aceita", "recusada"]),
  motivo: z.string().max(1000).optional(),
});
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "agent", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_decidir", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const supabase = authz.supabase;
  const { data: proposta, error } = await supabase
    .from("crm_proposals")
    .update({
      status: parsed.data.decisao,
      decided_at: new Date().toISOString(),
      decided_by_user_id: authz.actor.type === "user" ? authz.actor.id : null,
      decision_reason: parsed.data.motivo ?? null,
    })
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .eq("status", "enviada")
    .select("id, lead_id, contact_id, retorno_id")
    .maybeSingle();
  if (error) return fail("internal_error", t("Falha ao registrar a decisão."), 500, { requestId });
  if (!proposta) {
    return fail("proposal_context_stale", t("Só é possível decidir sobre uma proposta enviada."), 409, { requestId });
  }

  // value_cents do lead NÃO muda aqui (spec §16.2 — negócio perdido guarda
  // quanto valia; zerar apagaria o histórico de quanto se deixou na mesa).
  // D10: proposta órfã (negócio apagado, `lead_id` nulo) decide normalmente —
  // só não há negócio para registrar atividade nele.
  if (proposta.lead_id) {
    await emitLeadActivity(supabase, {
      organizationId: authz.organizationId,
      leadId: proposta.lead_id,
      contactId: proposta.contact_id,
      type: parsed.data.decisao === "aceita" ? "proposal_accepted" : "proposal_declined",
      sourceModule: "proposals",
      sourceId: id,
      actor: authz.actor,
      reason:
        parsed.data.decisao === "aceita"
          ? "Proposta aceita pelo cliente"
          : `Proposta recusada${parsed.data.motivo ? `: ${parsed.data.motivo}` : ""}`,
    });
  }

  // N2 — a decisão resolve a proposta: o retorno automático agendado no envio
  // não é mais necessário. Best-effort de verdade (achado Importante da
  // revisão final da C3b+E1): a decisão JÁ foi gravada no UPDATE acima — um erro
  // de banco aqui (instabilidade ao cancelar) não pode virar 500 nem comer a
  // auditoria abaixo, senão a tela mostra erro para uma decisão que já vale,
  // e um retry recebe 409 (status já não é mais 'enviada').
  if ((proposta as { retorno_id: string | null }).retorno_id) {
    try {
      await cancelaRetornoNoCrm(
        { admin: supabase, orgId: authz.organizationId, actor: authz.actor },
        (proposta as { retorno_id: string }).retorno_id,
        { motivo: `Proposta ${parsed.data.decisao} — retorno automático não é mais necessário` },
      );
    } catch (erro) {
      logger.warn("proposal.decide: cancelamento do retorno automático falhou sem bloquear a decisão", {
        propostaId: id,
        organizationId: authz.organizationId,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  void audit({
    action: parsed.data.decisao === "aceita" ? "proposal.aceita" : "proposal.recusada",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: id,
    requestId,
  });

  return ok({ id, status: parsed.data.decisao }, { requestId });
}
