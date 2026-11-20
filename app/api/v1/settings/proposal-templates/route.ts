// app/api/v1/settings/proposal-templates/route.ts
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { MODELOS_BASE } from "@/lib/propostas/modelos/catalogo-base";
import { listarModelosDaOrganizacao } from "@/lib/propostas/modelos/catalogo-da-organizacao";
import { proximaVersao, secaoSchema, secoesParaGravar } from "@/lib/propostas/modelos/gravacao";
import { ROTULO_DO_MODELO } from "@/lib/propostas/modelos/rotulos";
import { slugDaEmpresa, validarModelo } from "@/lib/propostas/modelos/validar-modelo";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const postSchema = z.union([
  z.object({ acao: z.literal("personalizar"), base_slug: z.string().min(1).max(100) }),
  z.object({
    acao: z.literal("novo"),
    nome: z.string().max(200),
    descricao: z.string().max(300).nullable().optional(),
    sections: z.array(secaoSchema).max(40).optional(),
    section_order: z.array(z.string().max(60)).max(40).optional(),
  }),
  z.object({ acao: z.union([z.literal("ocultar"), z.literal("mostrar")]), slug: z.string().min(1).max(100) }),
]);

const SECAO_INICIAL = {
  id: "summary",
  title: "Resumo da proposta",
  titleEs: null,
  body: "Esta proposta apresenta {{project.name}} para {{client.company_or_name}}.",
  bodyEs: null,
  required: true,
  conditional: false,
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "proposal_templates", role: "viewer", scope: "config:read", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposal-templates", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const admin = createAdminClient();
  return ok(await listarModelosDaOrganizacao(admin, authz.organizationId), { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "proposal_templates", role: "manager", scope: "config:write", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposal-templates", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  const admin = createAdminClient();
  const orgId = authz.organizationId;

  // Desligar um modelo da plataforma: some do seletor e da lista da IA, mas
  // continua resolvendo para propostas que já o usam. Guardado em
  // `settings.proposals.modelos_ocultos`, por MERGE — nunca sobrescrever
  // `settings` nem `settings.proposals` (o mesmo cuidado do PATCH de
  // `settings/proposals`, que manda só os campos dele).
  if (parsed.data.acao === "ocultar" || parsed.data.acao === "mostrar") {
    const slug = parsed.data.slug;
    if (!Object.hasOwn(ROTULO_DO_MODELO, slug)) {
      return fail("validation_failed", t("Modelo desconhecido."), 422, { requestId });
    }
    const { data: atual } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
    const bruto = (atual as { settings?: unknown } | null)?.settings;
    const settingsAtual = bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
    const brutoPropostas = settingsAtual.proposals;
    const proposalsAtual =
      brutoPropostas && typeof brutoPropostas === "object" && !Array.isArray(brutoPropostas)
        ? (brutoPropostas as Record<string, unknown>)
        : {};
    const brutoOcultos = proposalsAtual.modelos_ocultos;
    const ocultosAtual = Array.isArray(brutoOcultos) ? brutoOcultos.filter((s): s is string => typeof s === "string") : [];
    const lista =
      parsed.data.acao === "ocultar"
        ? [...new Set([...ocultosAtual, slug])]
        : ocultosAtual.filter((s) => s !== slug);
    const settingsMesclado = { ...settingsAtual, proposals: { ...proposalsAtual, modelos_ocultos: lista } };

    const { error } = await admin.from("organizations").update({ settings: settingsMesclado }).eq("id", orgId);
    if (error) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });

    void audit({
      action: parsed.data.acao === "ocultar" ? "proposal_template.hidden" : "proposal_template.shown",
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: orgId,
      resourceType: "proposal_templates",
      resourceId: null,
      requestId,
      metadata: { slug },
    });
    return ok({ slug, oculto: parsed.data.acao === "ocultar" }, { requestId });
  }

  let linha: Record<string, unknown>;
  if (parsed.data.acao === "personalizar") {
    const slug = parsed.data.base_slug;
    if (!Object.hasOwn(MODELOS_BASE, slug)) return fail("not_found", t("Modelo da plataforma não encontrado."), 404, { requestId });
    const { data: ativa } = await admin
      .from("proposal_templates")
      .select("id")
      .eq("organization_id", orgId)
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle();
    if (ativa) return fail("state_conflict", t("Este modelo já foi personalizado."), 409, { requestId });
    const base = MODELOS_BASE[slug]!;
    linha = {
      organization_id: orgId,
      slug,
      version: await proximaVersao(admin, orgId, slug),
      base_slug: slug,
      base_version: base.version,
      nome: ROTULO_DO_MODELO[slug] ?? null,
      descricao: null,
      sections: secoesParaGravar(base.sections),
      section_order: base.sectionOrder,
      is_active: true,
    };
  } else if (parsed.data.acao === "novo") {
    const nome = parsed.data.nome.trim();
    const sections = parsed.data.sections ?? [SECAO_INICIAL];
    const sectionOrder = parsed.data.section_order ?? sections.map((s) => s.id);
    const erros = validarModelo({
      nome,
      descricao: parsed.data.descricao ?? null,
      sections: sections.map((s) => ({ ...s, titleEs: null, bodyEs: null })),
      sectionOrder,
    });
    if (erros.length > 0) {
      return fail("validation_failed", t("O modelo tem problemas."), 422, { requestId, details: { erros } });
    }
    let slug = slugDaEmpresa(nome);
    for (let n = 2; n <= 9; n++) {
      const { data: existe } = await admin
        .from("proposal_templates")
        .select("id")
        .eq("organization_id", orgId)
        .eq("slug", slug)
        .eq("is_active", true)
        .maybeSingle();
      if (!existe) break;
      slug = `${slugDaEmpresa(nome).slice(0, 57)}_${n}`;
    }
    linha = {
      organization_id: orgId,
      slug,
      version: await proximaVersao(admin, orgId, slug),
      base_slug: null,
      base_version: null,
      nome,
      descricao: parsed.data.descricao ?? null,
      sections: secoesParaGravar(sections),
      section_order: sectionOrder,
      is_active: true,
    };
  } else {
    // Inalcançável pelo schema — ocultar/mostrar já retornou acima. O else
    // existe para o TS estreitar o union no ramo "novo".
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  }

  const { error } = await admin.from("proposal_templates").insert({ ...linha, organization_id: orgId });
  if (error) {
    if ((error as { code?: string }).code === "23505") return fail("state_conflict", t("Já existe um modelo ativo com este nome."), 409, { requestId });
    return fail("internal_error", t("Falha ao salvar o modelo."), 500, { requestId });
  }

  void audit({
    action: "proposal_template.saved",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "proposal_templates",
    resourceId: null,
    requestId,
    metadata: { slug: linha.slug, acao: parsed.data.acao, version: linha.version },
  });
  return ok({ slug: linha.slug }, { requestId });
}
