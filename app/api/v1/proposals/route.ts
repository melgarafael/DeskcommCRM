/**
 * GET  /api/v1/proposals — lista as propostas da organização ativa.
 * POST /api/v1/proposals — cria um RASCUNHO. numero/ano nascem NULL (spec
 * §5.3): só são alocados no envio (Tarefa 14), para rascunho descartado não
 * queimar número.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { resolverItensDaProposta } from "@/lib/propostas/itens";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { resolverPadroesDaProposta } from "@/lib/propostas/padroes-da-organizacao";
import { propostaCreateSchema } from "@/lib/schemas/propostas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { fusoDaOrganizacao, somarDiasNoFuso } from "@/lib/propostas/data-no-fuso";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "viewer", scope: "mcp:read" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_colecao", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;

  const supabase = authz.supabase;
  const status = req.nextUrl.searchParams.get("status");
  const leadId = req.nextUrl.searchParams.get("lead_id");
  let q = supabase
    .from("crm_proposals")
    .select("id, lead_id, titulo, status, total_cents, moeda, numero, ano, versao, valid_until, created_at, drafted_by_agent_id")
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (status) q = q.eq("status", status);
  // D10: a tela de excluir negócio consulta este filtro para avisar quando
  // há proposta enviada antes de apagar (KanbanCardActions / BulkActionBar).
  if (leadId) q = q.eq("lead_id", leadId);

  const { data, error } = await q;
  if (error) return fail("internal_error", "Falha ao listar propostas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  // Guarda de EFEITO: um acompanhamento de suporte só-leitura (ou já
  // encerrado) não pode criar rascunho na organização do cliente. Mesmo
  // padrão de toda rota de mutação do repo (`app/api/v1/products/route.ts`,
  // `app/api/v1/pipelines/route.ts` e outras 180+).
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "crm_proposals", role: "agent", scope: "mcp:write" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "proposals_colecao", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const parsed = propostaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;
  const supabase = authz.supabase;

  // O lead_id do body nunca é confiado sozinho: confirma que pertence à
  // organização ativa ANTES de gravar qualquer coisa vinculada a ele
  // (CLAUDE.md — multi-tenancy é inegociável).
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", authz.organizationId)
    .eq("id", input.lead_id)
    .maybeSingle();
  if (!lead) return fail("not_found", t("Negócio não encontrado nesta organização."), 404, { requestId });

  // crm_proposals.contact_id é NOT NULL (baseline.sql), e crm_leads.contact_id
  // é opcional — um negócio sem contato vinculado quebraria o INSERT com um
  // 500 cru em vez de uma recusa legível.
  if (!lead.contact_id) {
    return fail(
      "validation_failed",
      t("Este negócio não tem um contato vinculado. Vincule um contato antes de criar a proposta."),
      422,
      { requestId },
    );
  }

  // §5.3 — um rascunho aberto por negócio. Pré-checagem para dar mensagem
  // clara; o índice único (migration 0402) é quem garante de verdade sob
  // corrida (capturado como 23505 logo abaixo).
  const { data: rascunhoExistente } = await supabase
    .from("crm_proposals")
    .select("id")
    .eq("organization_id", authz.organizationId)
    .eq("lead_id", input.lead_id)
    .eq("status", "rascunho")
    .maybeSingle();
  if (rascunhoExistente) {
    return fail(
      "validation_failed",
      t("Este negócio já tem um rascunho de proposta aberto. Abra-o e continue por lá."),
      409,
      { requestId, details: { rascunho_aberto_id: rascunhoExistente.id } },
    );
  }

  // D11 — a proposta nasce na moeda da organização; item de catálogo em
  // moeda diferente é recusado dentro do resolvedor, nunca convertido.
  const moeda = await moedaDaOrganizacao(supabase, authz.organizationId);
  const resolvido = await resolverItensDaProposta(supabase, authz.organizationId, input.itens, moeda);
  if (!resolvido.ok) {
    return fail("validation_failed", t(resolvido.motivo), 422, { requestId });
  }

  const { data: org } = await supabase.from("organizations").select("settings").eq("id", authz.organizationId).single();
  const padroes = resolverPadroesDaProposta((org as { settings?: unknown } | null)?.settings);

  let validUntil = input.valid_until;
  if (validUntil === undefined) {
    const fuso = await fusoDaOrganizacao(supabase, authz.organizationId);
    validUntil = somarDiasNoFuso(new Date(), padroes.defaultValidDays, fuso);
  }
  const condicoes = input.condicoes ?? padroes.defaultConditions;

  const { data: proposta, error: propErr } = await supabase
    .from("crm_proposals")
    .insert({
      organization_id: authz.organizationId,
      lead_id: input.lead_id,
      contact_id: lead.contact_id,
      titulo: input.titulo,
      condicoes,
      valid_until: validUntil ?? null,
      total_cents: resolvido.totalCents,
      pricing_status: resolvido.pricingStatus,
      moeda,
      status: "rascunho",
    })
    .select("id")
    .single();
  if (propErr) {
    // 23505 = a corrida que a pré-checagem acima não pegou (dois cliques
    // quase simultâneos) — o índice único do banco é quem decide de verdade.
    if ((propErr as { code?: string }).code === "23505") {
      return fail("validation_failed", t("Este negócio já tem um rascunho de proposta aberto."), 409, { requestId });
    }
    return fail("internal_error", t("Falha ao criar a proposta."), 500, { requestId });
  }
  if (!proposta) return fail("internal_error", t("Falha ao criar a proposta."), 500, { requestId });

  if (resolvido.itens.length > 0) {
    const { error: itensErr } = await supabase.from("crm_proposal_items").insert(
      resolvido.itens.map((it) => ({
        proposal_id: proposta.id,
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
      // Sem isto, a proposta ficava um rascunho VAZIO — e, depois da C3, um
      // rascunho vazio ainda ocupa a trava de "um rascunho por negócio"
      // (§5.3), bloqueando toda tentativa nova para o mesmo lead atrás de um
      // erro que nem sequer apareceu na tela.
      // Pelo servidor, e não pela sessão: a RLS não deixa `agent` apagar
      // proposta (descartar é de `manager`, e enviada ninguém apaga — 0464).
      // Seguro com service role porque o alvo é a linha que ESTA requisição
      // acabou de criar, na organização da sessão.
      await createAdminClient().from("crm_proposals").delete().eq("organization_id", authz.organizationId).eq("id", proposta.id);
      return fail("internal_error", t("Falha ao gravar os itens."), 500, { requestId });
    }
  }

  // Vocabulário fechado da timeline (lib/leads/activity-vocabulary.ts) e
  // escritor canônico (lib/leads/activity-emitter.ts) — mesmo caminho que o
  // resto do CRM usa para gravar em crm_lead_activities, nunca um insert cru.
  await emitLeadActivity(supabase, {
    organizationId: authz.organizationId,
    leadId: input.lead_id,
    contactId: lead.contact_id,
    type: "proposal_drafted",
    sourceModule: "proposals",
    sourceId: proposta.id,
    actor: authz.actor,
    reason: `Rascunho de proposta criado: ${input.titulo}`,
  });

  void audit({
    action: "proposal.drafted",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "crm_proposals",
    resourceId: proposta.id,
    requestId,
  });

  return ok({ id: proposta.id }, { requestId, status: 201 });
}
