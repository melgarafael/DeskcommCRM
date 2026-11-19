import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/operacao/configuracao — a configuração da Operação do dia (manager+).
 * PATCH /api/v1/operacao/configuracao — muda etiquetas, etapas de proposta e a
 *       hora do relatório diário (admin).
 *
 * Mora em `organizations.settings.operacao_do_dia`. O PATCH lê o `settings`
 * inteiro e regrava só este bloco, como as outras chaves de `settings` fazem
 * (`/api/v1/settings/sons`): um `settings` vazio no update apagaria o resto.
 * Organização da sessão; service role com o id escrito.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { configuracaoSchema, lerConfiguracao } from "@/lib/operacao/regras";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function lerSettings(orgId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) {
    logger.error("operacao/configuracao: leitura de settings falhou", { organization_id: orgId, causa: error.message });
    return null;
  }
  return ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "operacao_do_dia" });
  if (!authz.ok) return authz.response;
  const settings = await lerSettings(authz.org.orgId);
  if (!settings) return fail("internal_error", traduzir("Erro ao ler a configuração.", authz.user.idioma), 500, { requestId });
  return ok(lerConfiguracao(settings), { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "operacao_do_dia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", t("JSON inválido."), 422, { requestId });
  }
  const parsed = configuracaoSchema.strict().safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("Payload inválido."), 422, { requestId, details: parsed.error.flatten() });
  }

  const settings = await lerSettings(orgId);
  if (!settings) return fail("internal_error", t("Erro ao ler a configuração."), 500, { requestId });
  const antes = lerConfiguracao(settings);
  const pedido = parsed.data;
  const depois = {
    tags: { ...antes.tags, ...pedido.tags },
    etapas_de_proposta: pedido.etapas_de_proposta ?? antes.etapas_de_proposta,
    relatorio: { ...antes.relatorio, ...pedido.relatorio },
  };

  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings: { ...settings, operacao_do_dia: depois } })
    .eq("id", orgId);
  if (error) {
    logger.error("operacao/configuracao: gravação falhou", { organization_id: orgId, request_id: requestId, causa: error.message });
    return fail("internal_error", t("Erro ao salvar a configuração."), 500, { requestId });
  }

  void audit({
    action: "settings.operacao_do_dia_updated",
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { antes, depois },
  });
  return ok(lerConfiguracao({ operacao_do_dia: depois }), { requestId });
}
