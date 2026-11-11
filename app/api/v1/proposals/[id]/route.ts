import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolverItensDaProposta } from "@/lib/propostas/itens";
import { propostaItemSchema } from "@/lib/schemas/propostas";
import { resolverAvisoDeRevisaoSeProntaOuEncerrada } from "@/lib/propostas/aviso-de-revisao";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });
const patchSchema = z.object({
  revision: z.number().int().positive(),
  titulo: z.string().trim().min(1).max(200).optional(),
  condicoes: z.string().max(4000).nullable().optional(),
  valid_until: z.string().date().nullable().optional(),
  prazo_dias_uteis: z.number().int().min(1).max(365).nullable().optional(),
  pagamento: z.string().trim().max(500).nullable().optional(),
  itens: z.array(propostaItemSchema),
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "viewer", scope: "mcp:read" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_detalhe", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: params.error.flatten() });
  }
  const { id } = params.data;
  const supabase = authz.supabase;
  const { data: proposta, error: propostaError } = await supabase
    .from("crm_proposals")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();

  if (propostaError) return fail("internal_error", t("Falha ao carregar a proposta."), 500, { requestId });
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });

  const { data: itens, error: itensError } = await supabase
    .from("crm_proposal_items")
    .select("*")
    .eq("organization_id", authz.organizationId)
    .eq("proposal_id", id)
    .order("position", { ascending: true });

  if (itensError) return fail("internal_error", t("Falha ao carregar os itens."), 500, { requestId });

  // N4 — preço ATUAL do catálogo junto do item, para o editor detectar drift.
  // Uma consulta em lote (não N): item manual (product_id nulo) nunca participa;
  // produto apagado desde então contribui com null, sem quebrar.
  const idsDeProduto = [...new Set((itens ?? []).map((it) => it.product_id).filter((pid): pid is string => pid !== null))];
  const precoAtualPorProduto = new Map<string, number>();
  if (idsDeProduto.length > 0) {
    const { data: produtos } = await supabase
      .from("catalog_products")
      .select("id, preco_cents")
      .eq("organization_id", authz.organizationId)
      .in("id", idsDeProduto);
    for (const p of (produtos ?? []) as Array<{ id: string; preco_cents: number }>) {
      precoAtualPorProduto.set(p.id, p.preco_cents);
    }
  }
  const itensComDrift = (itens ?? []).map((it) => ({
    ...it,
    preco_catalogo_atual_cents: it.product_id ? (precoAtualPorProduto.get(it.product_id) ?? null) : null,
  }));

  return ok({ ...proposta, itens: itensComDrift }, { requestId });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "agent", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_editar", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: params.error.flatten() });
  }
  const { id } = params.data;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;
  const supabase = authz.supabase;
  // D11 — a edição não muda a moeda da proposta (fora de escopo); os itens
  // são resolvidos contra a moeda JÁ GRAVADA. A leitura que falta devolve o
  // MESMO 409 ambíguo do UPDATE abaixo (convenção desta rota: nunca vazar a
  // existência para outra organização — ver teste "não altera proposta de
  // outra organização"), não o 404 do plano, de propósito.
  const { data: propostaAtual } = await supabase
    .from("crm_proposals")
    .select("moeda")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!propostaAtual) {
    return fail(
      "proposal_context_stale",
      t("A proposta mudou (ou não está mais em rascunho). Recarregue antes de editar."),
      409,
      { requestId },
    );
  }
  const resolvido = await resolverItensDaProposta(supabase, authz.organizationId, input.itens, (propostaAtual as { moeda: string }).moeda);
  if (!resolvido.ok) {
    return fail("validation_failed", t(resolvido.motivo), 422, { requestId });
  }
  const { data: proposta, error } = await supabase
    .from("crm_proposals")
    .update({
      ...(input.titulo !== undefined ? { titulo: input.titulo } : {}),
      ...(input.condicoes !== undefined ? { condicoes: input.condicoes } : {}),
      ...(input.valid_until !== undefined ? { valid_until: input.valid_until } : {}),
      ...(input.prazo_dias_uteis !== undefined ? { prazo_dias_uteis: input.prazo_dias_uteis } : {}),
      ...(input.pagamento !== undefined ? { pagamento: input.pagamento === "" ? null : input.pagamento } : {}),
      total_cents: resolvido.totalCents,
      pricing_status: resolvido.pricingStatus,
      revision: input.revision + 1,
    })
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .eq("revision", input.revision)
    .eq("status", "rascunho")
    .select("id, revision")
    .maybeSingle();

  if (error) return fail("internal_error", t("Falha ao editar a proposta."), 500, { requestId });
  if (!proposta) {
    return fail(
      "proposal_context_stale",
      t("A proposta mudou (ou não está mais em rascunho). Recarregue antes de editar."),
      409,
      { requestId },
    );
  }

  const { error: deleteError } = await supabase
    .from("crm_proposal_items")
    .delete()
    .eq("organization_id", authz.organizationId)
    .eq("proposal_id", id);
  if (deleteError) return fail("internal_error", t("Falha ao remover os itens anteriores."), 500, { requestId });

  if (input.itens.length > 0) {
    const { error: insertError } = await supabase.from("crm_proposal_items").insert(
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
    if (insertError) return fail("internal_error", t("Falha ao gravar os itens."), 500, { requestId });
  }

  void resolverAvisoDeRevisaoSeProntaOuEncerrada(supabase, authz.organizationId, id);

  void audit({
    action: "proposal.edited",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: id,
    requestId,
  });

  return ok({ id, revision: proposta.revision, total_cents: resolvido.totalCents }, { requestId });
}

/**
 * D4, item 3 da spec ("descartar a v2 em rascunho não toca na v1") — achado
 * Importante da revisão C4: não existia rota nenhuma para desistir de um
 * rascunho. Sem ela, "Revisar" por engano (ou desistência do gerente) criava
 * a v2 e ela ficava como "o" rascunho aberto do negócio para sempre (§5.3),
 * bloqueando qualquer proposta nova até alguém enviá-la — mesmo sem querer.
 * Nunca apaga: vira `cancelada` (a v1, se houver, não é tocada — ela só sai
 * de `enviada` quando uma v2 é EFETIVAMENTE enviada, send/route.ts).
 */
export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "manager", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_descartar", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: params.error.flatten() });
  }
  const { id } = params.data;
  const supabase = authz.supabase;
  const { data: proposta, error } = await supabase
    .from("crm_proposals")
    .update({ status: "cancelada" })
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .eq("status", "rascunho")
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", t("Falha ao descartar a proposta."), 500, { requestId });
  if (!proposta) {
    return fail(
      "proposal_context_stale",
      t("Só é possível descartar uma proposta em rascunho."),
      409,
      { requestId },
    );
  }

  void resolverAvisoDeRevisaoSeProntaOuEncerrada(supabase, authz.organizationId, id, { forcar: true });

  void audit({
    action: "proposal.discarded",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: id,
    requestId,
  });

  return ok({ id, status: "cancelada" }, { requestId });
}
