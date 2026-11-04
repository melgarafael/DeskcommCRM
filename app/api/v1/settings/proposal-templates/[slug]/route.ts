// app/api/v1/settings/proposal-templates/[slug]/route.ts
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
import { ROTULO_DO_MODELO } from "@/lib/propostas/modelos/rotulos";
import { validarModelo } from "@/lib/propostas/modelos/validar-modelo";
import { proximaVersao, secaoSchema, secoesParaGravar } from "@/lib/propostas/modelos/gravacao";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ slug: string }> };

const patchSchema = z.object({
  nome: z.string().max(200),
  descricao: z.string().max(300).nullable(),
  sections: z.array(secaoSchema).max(40),
  section_order: z.array(z.string().max(60)).max(40),
});

interface LinhaDoModelo {
  id: string;
  slug: string;
  nome: string | null;
  descricao: string | null;
  version: number;
  sections: Array<{ id: string; title: string; body: string; required: boolean; conditional: boolean }>;
  section_order: string[];
}

async function copiaAtiva(admin: ReturnType<typeof createAdminClient>, orgId: string, slug: string) {
  const { data } = await admin
    .from("proposal_templates")
    .select("id, slug, nome, descricao, version, sections, section_order")
    .eq("organization_id", orgId)
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  return (data as LinhaDoModelo | null) ?? null;
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "proposal_templates", role: "viewer", scope: "config:read", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposal-templates.slug", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { slug } = await ctx.params;
  const admin = createAdminClient();

  const copia = await copiaAtiva(admin, authz.organizationId, slug);
  if (copia) {
    return ok(
      {
        slug,
        nome: copia.nome ?? ROTULO_DO_MODELO[slug] ?? slug,
        descricao: copia.descricao,
        origem: Object.hasOwn(MODELOS_BASE, slug) ? "personalizado" : "empresa",
        version: copia.version,
        sections: copia.sections,
        sectionOrder: copia.section_order,
      },
      { requestId },
    );
  }
  if (Object.hasOwn(MODELOS_BASE, slug)) {
    const base = MODELOS_BASE[slug]!;
    return ok(
      { slug, nome: ROTULO_DO_MODELO[slug] ?? slug, descricao: null, origem: "plataforma", version: base.version, sections: base.sections, sectionOrder: base.sectionOrder },
      { requestId },
    );
  }
  return fail("not_found", t("Modelo não encontrado."), 404, { requestId });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "proposal_templates", role: "manager", scope: "config:write", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposal-templates.slug", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { slug } = await ctx.params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  const erros = validarModelo({
    nome: parsed.data.nome,
    descricao: parsed.data.descricao,
    sections: parsed.data.sections.map((s) => ({ ...s, titleEs: null, bodyEs: null })),
    sectionOrder: parsed.data.section_order,
  });
  if (erros.length > 0) return fail("validation_failed", t("O modelo tem problemas."), 422, { requestId, details: { erros } });

  const admin = createAdminClient();
  const copia = await copiaAtiva(admin, authz.organizationId, slug);
  if (!copia) {
    return fail("state_conflict", t("Personalize o modelo da plataforma antes de editá-lo."), 409, { requestId });
  }
  const version = await proximaVersao(admin, authz.organizationId, slug);
  const { error } = await admin
    .from("proposal_templates")
    .update({
      nome: parsed.data.nome.trim(),
      descricao: parsed.data.descricao,
      sections: secoesParaGravar(parsed.data.sections),
      section_order: parsed.data.section_order,
      version,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", authz.organizationId)
    .eq("id", copia.id);
  if (error) return fail("internal_error", t("Falha ao salvar o modelo."), 500, { requestId });

  void audit({
    action: "proposal_template.saved",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "proposal_templates",
    resourceId: copia.id,
    requestId,
    metadata: { slug, version },
  });
  return ok({ slug, version }, { requestId });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "proposal_templates", role: "manager", scope: "config:write", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposal-templates.slug", requestId);
  if (teto) return teto;
  const desligada = await sePropostasDesligadas(authz.organizationId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { slug } = await ctx.params;
  const admin = createAdminClient();

  const copia = await copiaAtiva(admin, authz.organizationId, slug);
  if (!copia) return fail("not_found", t("Não há cópia da empresa para este modelo."), 404, { requestId });
  const { error } = await admin
    .from("proposal_templates")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("organization_id", authz.organizationId)
    .eq("id", copia.id);
  if (error) return fail("internal_error", t("Falha ao desativar o modelo."), 500, { requestId });

  void audit({
    action: "proposal_template.deactivated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "proposal_templates",
    resourceId: copia.id,
    requestId,
    metadata: { slug },
  });
  return ok({ slug }, { requestId });
}
