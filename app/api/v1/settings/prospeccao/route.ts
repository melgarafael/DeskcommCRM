/**
 * GET   /api/v1/settings/prospeccao — personalização da prospecção (voz e vocabulário).
 * PATCH /api/v1/settings/prospeccao — grava (manager+).
 *
 * Fatia `prospeccao` de `organizations.settings`: merge NÃO destrutivo,
 * preservando as demais chaves. Sem segredo aqui (só nome, apresentação e
 * vocabulário) — o que volta no GET é exibível.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  lerPersonalizacao,
  personalizacaoProspeccaoSchema,
} from "@/lib/prospecting/personalizar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "prospecting_settings", role: "manager", scope: "config:read", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.prospeccao", requestId);
  if (teto) return teto;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.organizationId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    { personalizacao: lerPersonalizacao((data as { settings?: unknown } | null)?.settings) },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "prospecting_settings", role: "manager", scope: "config:write", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.prospeccao", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const parsed = personalizacaoProspeccaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.organizationId)
    .maybeSingle();
  if (erroLeitura) return fail("internal_error", erroLeitura.message, 500, { requestId });

  const settings = ((atual as { settings?: Record<string, unknown> } | null)?.settings ??
    {}) as Record<string, unknown>;
  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, prospeccao: parsed.data } })
    .eq("id", authz.organizationId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "prospecting.settings_updated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "organization",
    resourceId: authz.organizationId,
    requestId,
    metadata: parsed.data as unknown as Record<string, unknown>,
  });

  return ok({ personalizacao: parsed.data }, { requestId });
}
