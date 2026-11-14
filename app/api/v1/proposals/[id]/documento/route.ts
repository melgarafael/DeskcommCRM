// app/api/v1/proposals/[id]/documento/route.ts
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolverAvisoDeRevisaoSeProntaOuEncerrada } from "@/lib/propostas/aviso-de-revisao";
import { definirCaminho } from "@/lib/propostas/briefing-caminho";
import { lerSecoesEditadas, montarDocumentoDaProposta } from "@/lib/propostas/documento/documento-da-proposta";
import type { ContatoParaDocumento } from "@/lib/propostas/documento/montar-dados";
import { ondePreencher } from "@/lib/propostas/documento/rotulos-das-variaveis";
import { extrairVariaveis } from "@/lib/propostas/documento/variaveis";
import { montarEntradaDeProntidao } from "@/lib/propostas/prontidao-da-proposta";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SEGMENTOS_PROIBIDOS = new Set(["__proto__", "constructor", "prototype"]);

const secaoSchema = z.object({
  secaoId: z.string().trim().min(1).max(100),
  // null = voltar ao texto do modelo. Texto vazio não é aceito: esvaziar uma
  // seção obrigatória sem dizer nada é pior que o [a definir] que ela tinha.
  texto: z.string().trim().min(1).max(20000).nullable(),
});
const campoSchema = z.object({
  campo: z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/)
    .refine((c) => !c.split(".").some((s) => SEGMENTOS_PROIBIDOS.has(s))),
  valor: z.string().trim().min(1).max(4000),
});
const patchSchema = z.union([secaoSchema, campoSchema]);

type Ctx = { params: Promise<{ id: string }> };
type Admin = ReturnType<typeof createAdminClient>;

interface LinhaDaProposta {
  id: string;
  organization_id: string;
  status: string;
  /** O negócio da proposta (#4533): a rota faz `select("*")`, o campo já vem. */
  lead_id: string | null;
  template_slug: string | null;
  template_slug_sugerido: string | null;
  briefing_json: unknown;
  secoes_editadas: unknown;
  pricing_status: "missing" | "catalog" | "manual" | "custom" | "approved";
  contact_id: string | null;
  titulo: string | null;
  prazo_dias_uteis: number | null;
  pagamento: string | null;
  valid_until: string | null;
  total_cents: number;
  moeda: string;
  created_at: string;
}

async function buscarProposta(admin: Admin, orgId: string, id: string): Promise<LinhaDaProposta | null> {
  const { data } = await admin
    .from("crm_proposals")
    .select("*")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return (data as LinhaDaProposta | null) ?? null;
}

async function buscarContato(admin: Admin, orgId: string, contactId: string | null): Promise<ContatoParaDocumento | null> {
  if (!contactId) return null;
  const { data } = await admin
    .from("contacts")
    .select("name, display_name")
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .maybeSingle();
  return (data as ContatoParaDocumento | null) ?? null;
}

function comoObjeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Record<string, unknown>) : {};
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_proposals" });
  if (!authz.ok) return authz.response;
  const desligada = await sePropostasDesligadas(authz.org.orgId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  const admin = createAdminClient();

  const proposta = await buscarProposta(admin, authz.org.orgId, id);
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });

  const base = {
    status: proposta.status,
    modeloSlug: proposta.template_slug,
    modeloSlugSugerido: proposta.template_slug_sugerido,
    secoes: [] as unknown[],
    variaveisFaltando: [] as string[],
    camposFaltando: [] as unknown[],
    temSecaoEditada: Object.keys(lerSecoesEditadas(proposta.secoes_editadas)).length > 0,
    prontidao: null as unknown,
    resumoComercial: null,
  };
  if (!proposta.template_slug) return ok(base, { requestId });

  const contato = await buscarContato(admin, authz.org.orgId, proposta.contact_id);
  const documento = await montarDocumentoDaProposta(admin, authz.org.orgId, proposta, contato);
  if (!documento) return ok(base, { requestId });

  const { data: itens } = await admin
    .from("crm_proposal_items")
    .select("preco_unitario_cents")
    .eq("organization_id", authz.org.orgId)
    .eq("proposal_id", id);
  const temItensComPreco = (itens ?? []).length > 0 && (itens ?? []).every((it) => it.preco_unitario_cents !== null);

  const prontidao = montarEntradaDeProntidao(
    {
      contact_id: proposta.contact_id,
      titulo: proposta.titulo,
      pricing_status: proposta.pricing_status,
      prazo_dias_uteis: proposta.prazo_dias_uteis,
      pagamento: proposta.pagamento,
      valid_until: proposta.valid_until,
      briefing_json: proposta.briefing_json,
    },
    temItensComPreco,
  );

  return ok(
    {
      ...base,
      modeloSlug: documento.modelo.slug,
      secoes: documento.secoes,
      variaveisFaltando: documento.pendencias,
      camposFaltando: documento.camposFaltando,
      prontidao,
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_proposals" });
  if (!authz.ok) return authz.response;
  const desligada = await sePropostasDesligadas(authz.org.orgId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const admin = createAdminClient();
  const proposta = await buscarProposta(admin, authz.org.orgId, id);
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });
  // Achado do plano M6 que ficou sem dono: editar uma proposta já enviada
  // mudava a tela sem mudar o que o cliente recebeu.
  if (proposta.status !== "rascunho") {
    return fail("proposal_context_stale", t("Só é possível editar o documento de uma proposta em rascunho."), 409, {
      requestId,
    });
  }

  if ("campo" in parsed.data) {
    const { campo, valor } = parsed.data;
    const contato = await buscarContato(admin, authz.org.orgId, proposta.contact_id);
    const documento = await montarDocumentoDaProposta(admin, authz.org.orgId, proposta, contato);
    if (!documento) {
      return fail("validation_failed", t("Escolha o modelo da proposta antes de preencher campos."), 422, { requestId });
    }
    const variaveisDoModelo = new Set(documento.modelo.sections.flatMap((s) => extrairVariaveis(s.body)));
    if (!variaveisDoModelo.has(campo) || ondePreencher(campo) !== "briefing") {
      return fail("validation_failed", t("Este campo não se preenche por aqui."), 422, { requestId });
    }

    const briefing = definirCaminho(comoObjeto(proposta.briefing_json), campo, valor);
    const { error } = await admin
      .from("crm_proposals")
      .update({ briefing_json: briefing })
      .eq("organization_id", authz.org.orgId)
      .eq("id", id);
    if (error) return fail("internal_error", t("Falha ao salvar o campo."), 500, { requestId });

    void resolverAvisoDeRevisaoSeProntaOuEncerrada(admin, authz.org.orgId, id);
    void audit({
      action: "proposal.documento_campo_preenchido",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "crm_proposals",
      resourceId: id,
      requestId,
      metadata: { campo },
    });
    return ok({ campo }, { requestId });
  }

  const { secaoId, texto } = parsed.data;
  const editadas = lerSecoesEditadas(proposta.secoes_editadas);
  if (texto === null) delete editadas[secaoId];
  else editadas[secaoId] = texto;
  const secoesEditadas = Object.keys(editadas).length > 0 ? editadas : null;

  const { error } = await admin
    .from("crm_proposals")
    .update({ secoes_editadas: secoesEditadas })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id);
  if (error) return fail("internal_error", t("Falha ao salvar a seção."), 500, { requestId });

  void resolverAvisoDeRevisaoSeProntaOuEncerrada(admin, authz.org.orgId, id);
  void audit({
    action: "proposal.documento_editado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "crm_proposals",
    resourceId: id,
    requestId,
    metadata: { secaoId, restaurada: texto === null },
  });

  return ok({ secoesEditadas }, { requestId });
}
