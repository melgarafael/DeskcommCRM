import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { aplicarMudancas, mudancaSchema, type EstadoDaProposta } from "@/lib/propostas/assistente";
import { resolverItensDaProposta } from "@/lib/propostas/itens";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { traduzir } from "@/lib/i18n/dicionario";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";
const bodySchema = z.object({
  revision: z.number().int().positive(),
  mudancas: z.array(mudancaSchema),
});
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "agent", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_assistente_aplicar", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  if (parsed.data.mudancas.length === 0) {
    return fail("validation_failed", t("Nenhuma mudança para aplicar."), 422, { requestId });
  }

  const supabase = authz.supabase;
  // Consolidado numa unica query (o texto original consultava crm_proposals
  // duas vezes) — ja traz lead_id/contact_id que so seriam usados depois.
  const { data: proposta } = await supabase
    .from("crm_proposals")
    .select("lead_id, contact_id, titulo, condicoes, valid_until, briefing_json, status, revision, moeda")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });
  if (proposta.status !== "rascunho" || proposta.revision !== parsed.data.revision) {
    return fail("proposal_context_stale", t("A proposta mudou. Gere as sugestões de novo."), 409, { requestId });
  }

  const { data: itens } = await supabase
    .from("crm_proposal_items")
    .select("id, product_id, descricao, quantidade, preco_unitario_cents, desconto_cents, position")
    .eq("organization_id", authz.organizationId)
    .eq("proposal_id", id)
    .order("position");

  const briefing =
    proposta.briefing_json && typeof proposta.briefing_json === "object" && !Array.isArray(proposta.briefing_json)
      ? (proposta.briefing_json as Record<string, unknown>)
      : {};

  const estadoAntes: EstadoDaProposta = {
    titulo: proposta.titulo,
    condicoes: proposta.condicoes,
    valid_until: proposta.valid_until,
    briefing,
    itens: itens ?? [],
  };
  const estadoDepois = aplicarMudancas(estadoAntes, parsed.data.mudancas);

  // C3 (revisão) — o assistente é mais um caminho que escreve item de
  // proposta, e o preço de item de catálogo nunca pode vir de fora do
  // servidor: sem isto, uma mudança "editar_item"/"preco_unitario_cents"
  // gravava o valor sugerido pela IA (ou mandado no corpo) direto num item
  // com product_id, furando a mesma regra que a criação/edição já cumprem.
  const resolvido = await resolverItensDaProposta(
    supabase,
    authz.organizationId,
    estadoDepois.itens,
    (proposta as { moeda: string }).moeda,
  );
  if (!resolvido.ok) {
    return fail("validation_failed", t(resolvido.motivo), 422, { requestId });
  }

  const { data: atualizada, error } = await supabase
    .from("crm_proposals")
    .update({
      titulo: estadoDepois.titulo,
      condicoes: estadoDepois.condicoes,
      valid_until: estadoDepois.valid_until,
      briefing_json: estadoDepois.briefing,
      total_cents: resolvido.totalCents,
      pricing_status: resolvido.pricingStatus,
      revision: parsed.data.revision + 1,
    })
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .eq("revision", parsed.data.revision)
    .select("id, revision")
    .maybeSingle();
  if (error || !atualizada) {
    return fail("proposal_context_stale", t("A proposta mudou. Gere as sugestões de novo."), 409, { requestId });
  }

  await supabase.from("crm_proposal_items").delete().eq("organization_id", authz.organizationId).eq("proposal_id", id);
  if (resolvido.itens.length > 0) {
    await supabase.from("crm_proposal_items").insert(
      resolvido.itens.map((it) => ({
        organization_id: authz.organizationId,
        proposal_id: id,
        product_id: it.product_id,
        descricao: it.descricao,
        quantidade: it.quantidade,
        preco_unitario_cents: it.preco_unitario_cents,
        desconto_cents: it.desconto_cents,
        position: it.position,
      })),
    );
  }

  // D10: proposta órfã (negócio apagado, `lead_id` nulo) segue editável pelo
  // assistente — só não há negócio para registrar atividade nele.
  if (proposta.lead_id) {
    await emitLeadActivity(supabase, {
      organizationId: authz.organizationId,
      leadId: proposta.lead_id,
      contactId: proposta.contact_id,
      type: "proposal_drafted",
      sourceModule: "proposals",
      sourceId: id,
      actor: authz.actor,
      reason: `Proposta ajustada pelo assistente (${parsed.data.mudancas.length} mudança(s))`,
    });
  }

  void audit({
    action: "proposal.assistant_applied",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: id,
    requestId,
    metadata: { quantidade_de_mudancas: parsed.data.mudancas.length },
  });

  return ok({ id, revision: atualizada.revision, total_cents: resolvido.totalCents }, { requestId });
}
