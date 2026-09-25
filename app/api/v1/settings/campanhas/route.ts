/**
 * GET   /api/v1/settings/campanhas — os padrões de campanha da organização.
 * PATCH /api/v1/settings/campanhas — grava (manager+).
 *
 * Mesma forma da rota de atendimento (`settings/routing`): merge NÃO destrutivo
 * do jsonb `organizations.settings`, preservando as demais chaves. Sobrescrever
 * o objeto inteiro apagaria `routing`, `branding` e o resto — e o estrago só
 * apareceria na próxima vez que alguém precisasse deles.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CONFIGURACAO_PADRAO,
  configuracaoDeCampanhasSchema,
  lerConfiguracao,
} from "@/lib/campanhas/configuracao";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaign_settings" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    { configuracao: lerConfiguracao((data as { settings?: unknown } | null)?.settings), padrao: CONFIGURACAO_PADRAO },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaign_settings" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = configuracaoDeCampanhasSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const nova = parsed.data;
  if (
    nova.janela_inicio_hora !== null &&
    nova.janela_fim_hora !== null &&
    nova.janela_fim_hora <= nova.janela_inicio_hora
  ) {
    return fail("validation_failed", t("A janela precisa terminar depois de começar."), 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (erroLeitura) return fail("internal_error", erroLeitura.message, 500, { requestId });

  const settings = ((atual as { settings?: Record<string, unknown> } | null)?.settings ??
    {}) as Record<string, unknown>;
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, campanhas: nova } })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "campaign.settings_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: nova as unknown as Record<string, unknown>,
  });

  return ok({ configuracao: nova }, { requestId });
}
