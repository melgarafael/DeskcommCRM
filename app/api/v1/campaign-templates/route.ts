/**
 * GET  /api/v1/campaign-templates — a copy guardada da organização.
 * POST /api/v1/campaign-templates — guarda uma.
 *
 * Escrita pelo client ADMIN com filtro explícito de organização, como todo o
 * módulo: o papel `authenticated` só tem SELECT (migration 0376). Ver
 * `tests/unit/campanha-escreve-como-servidor.test.ts`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { criarTemplateSchema } from "@/lib/campanhas/schemas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id, name, body, created_at, updated_at, created_by";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaign_templates",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaign_templates_lista", requestId);
  if (teto) return teto;
  const org = { orgId: authz.organizationId };

  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from("campaign_templates")
    .select(COLUNAS)
    .eq("organization_id", org.orgId)
    .order("name", { ascending: true })
    .limit(200);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaign_templates",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaign_templates_criar", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };
  const autor = authz.actor.type === "user" ? authz.actor.id : null;

  const parsed = criarTemplateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("campaign_templates")
    .insert({
      organization_id: org.orgId,
      name: parsed.data.name,
      body: parsed.data.body,
      created_by: autor,
      updated_by: autor,
    })
    .select(COLUNAS)
    .single();
  if (error) {
    // 23505 é a unicidade `(organization_id, name)`: dois templates com o mesmo
    // nome é a receita para usar o errado, porque quem escolhe escolhe pelo nome.
    if (error.code === "23505") {
      return fail("campanha_conteudo_invalido", t("Já existe um texto salvo com esse nome."), 409, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data, { requestId, status: 201 });
}
