/**
 * GET   /api/v1/settings/assinatura — a assinatura do emissor (#2066).
 * PATCH /api/v1/settings/assinatura — grava (manager+).
 *
 * A porta que faltava: sem ela, `organizations.settings.assinatura_mensagens`
 * só ligava por SQL. Mesma forma de `settings/campanhas`: merge NÃO destrutivo
 * do jsonb, preservando as demais chaves, e leitura que falhou PARA a gravação
 * (tratá-la como `{}` regravaria o settings inteiro só com esta chave).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { assinaturaEntradaSchema, configAssinatura } from "@/lib/messaging/assinatura";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function lerSettings(orgId: string) {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) return { error };
  return { settings: ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown> };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "message_signature" });
  if (!authz.ok) return authz.response;

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });
  const c = configAssinatura(lido.settings);
  return ok({ humanos: c.humanos, ia: c.ia, nome_ia: c.nomeIa }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "message_signature" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = assinaturaEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const nova = parsed.data;

  const lido = await lerSettings(authz.org.orgId);
  if ("error" in lido) return fail("internal_error", lido.error?.message ?? "", 500, { requestId });

  // Cliente admin: a RLS de `organizations` só deixa platform admin escrever.
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ settings: { ...lido.settings, assinatura_mensagens: nova } })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "settings.message_signature_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: nova,
  });

  return ok(nova, { requestId });
}
