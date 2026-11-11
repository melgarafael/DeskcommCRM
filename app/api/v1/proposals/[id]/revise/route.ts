/**
 * POST /api/v1/proposals/[id]/revise — D4. Cria a v2 em RASCUNHO a partir de
 * uma proposta ENVIADA: copia titulo/condicoes/valid_until/itens, herda
 * numero/ano, aponta substitui_id para a v1. A v1 CONTINUA `enviada` — só
 * vira `substituida` quando a v2 for efetivamente enviada
 * (app/api/v1/proposals/[id]/send/route.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolverItensDaProposta } from "@/lib/propostas/itens";
import { decidirRevisao } from "@/lib/propostas/versao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ motivo: z.string().max(1000).optional() });

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "manager", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_revisar", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;
  const parsedBody = bodySchema.safeParse(await req.json().catch(() => ({})));
  const motivo = parsedBody.success ? (parsedBody.data.motivo ?? null) : null;
  const admin = createAdminClient();

  const { data: proposta } = await admin
    .from("crm_proposals")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });

  let decisao;
  try {
    decisao = decidirRevisao(proposta as never);
  } catch {
    return fail("proposal_context_stale", t("Esta proposta não pode ser revisada neste estado."), 409, { requestId });
  }

  const { data: itensDaV1 } = await admin
    .from("crm_proposal_items")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .eq("proposal_id", id)
    .order("position");

  // Achado Importante da revisão C4: copiar `preco_unitario_cents` da v1 sem
  // passar pelo resolvedor único (C3, D5) reintroduzia a mesma classe de bug
  // que a C3 fechou — preço congelado do momento da v1, em vez do preço
  // ATUAL do catálogo. Resolve de novo aqui, igual a toda outra escrita de
  // itens de proposta (criação, PATCH, ferramenta da IA).
  const resolvido = await resolverItensDaProposta(
    admin,
    authz.organizationId,
    (itensDaV1 ?? []).map((it) => ({
      product_id: it.product_id,
      descricao: it.descricao,
      quantidade: it.quantidade,
      preco_unitario_cents: it.preco_unitario_cents,
      desconto_cents: it.desconto_cents,
      position: it.position,
    })),
    // D11 — a v2 herda a moeda da v1 (já gravada no INSERT abaixo); item
    // cujo produto mudou de moeda no catálogo desde a v1 é recusado aqui.
    proposta.moeda,
  );
  if (!resolvido.ok) {
    return fail("validation_failed", t(resolvido.motivo), 422, { requestId });
  }

  // §5.3 — a v2 conta como "o" rascunho aberto do negócio. Se por algum
  // motivo já houver outro rascunho aberto (de uma cadeia diferente), o
  // índice único do banco recusa — capturado abaixo como 23505.
  const { data: nova, error: novaErr } = await admin
    .from("crm_proposals")
    .insert({
      organization_id: authz.organizationId,
      lead_id: proposta.lead_id,
      contact_id: proposta.contact_id,
      conversation_id: proposta.conversation_id,
      titulo: proposta.titulo,
      condicoes: proposta.condicoes,
      valid_until: proposta.valid_until,
      total_cents: resolvido.totalCents,
      pricing_status: resolvido.pricingStatus,
      moeda: proposta.moeda,
      status: "rascunho",
      numero: decisao.herdaNumero,
      ano: decisao.herdaAno,
      versao: decisao.novaVersao,
      substitui_id: decisao.substituiId,
      template_slug: proposta.template_slug,
      template_version: proposta.template_version,
      template_snapshot: proposta.template_snapshot,
      briefing_json: proposta.briefing_json,
      secoes_editadas: proposta.secoes_editadas,
      version_reason: motivo,
    })
    .select("id")
    .single();
  if (novaErr) {
    if ((novaErr as { code?: string }).code === "23505") {
      return fail("validation_failed", t("Este negócio já tem um rascunho de proposta aberto."), 409, { requestId });
    }
    return fail("internal_error", t("Falha ao criar a revisão."), 500, { requestId });
  }
  if (!nova) return fail("internal_error", t("Falha ao criar a revisão."), 500, { requestId });

  if (resolvido.itens.length > 0) {
    const { error: itensErr } = await admin.from("crm_proposal_items").insert(
      resolvido.itens.map((it) => ({
        proposal_id: nova.id,
        organization_id: authz.organizationId,
        product_id: it.product_id,
        descricao: it.descricao,
        quantidade: it.quantidade,
        preco_unitario_cents: it.preco_unitario_cents,
        desconto_cents: it.desconto_cents,
        position: it.position,
      })),
    );
    if (itensErr) {
      // A v2 nasceu mas sem itens — descarta-a; a v1 continua `enviada` (D3,
      // mesmo raciocínio de "não substitui uma cadeia por uma v2 vazia").
      await admin.from("crm_proposals").delete().eq("organization_id", authz.organizationId).eq("id", nova.id);
      return fail("internal_error", t("Falha ao copiar os itens da revisão."), 500, { requestId });
    }
  }

  void audit({
    action: "proposal.revised",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: nova.id,
    requestId,
    metadata: { substitui_id: decisao.substituiId },
  });

  return ok({ id: nova.id }, { requestId, status: 201 });
}
