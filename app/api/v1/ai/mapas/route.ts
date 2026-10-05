import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * A chave de MAPAS da organização (Configurações › Provedores, cartão "Mapas").
 *
 *   GET    — estado: configurada?, 4 últimos caracteres, quando. Nunca a chave.
 *   PUT    — grava ou troca a chave (cifrada). Admin.
 *   DELETE — remove a chave: o pino volta a chegar só com o link. Admin.
 *
 * Com a chave, o pino de localização do WhatsApp ganha rua, cidade e região
 * aproximados (`lib/mapas/`). O botão "Testar" mora em `./testar`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  chaveDeMapasSchema,
  estadoDaChaveDeMapas,
  guardarChaveDeMapas,
  PROVEDOR_DE_MAPAS,
  removerChaveDeMapas,
} from "@/lib/mapas/credencial";
import { createAdminClient } from "@/lib/supabase/admin";

const putSchema = z.object({ api_key: chaveDeMapasSchema }).strict();

function corpoDoEstado(e: Awaited<ReturnType<typeof estadoDaChaveDeMapas>>) {
  return { provider: PROVEDOR_DE_MAPAS, configurada: e.configurada, ultimos4: e.ultimos4, atualizada_em: e.atualizadaEm };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_maps" });
  if (!authz.ok) return authz.response;
  try {
    const estado = await estadoDaChaveDeMapas(createAdminClient(), authz.org.orgId);
    return ok(corpoDoEstado(estado), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não consegui ler a configuração de mapas.", authz.user.idioma), 500, { requestId });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_maps" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = putSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Essa não parece uma chave do Google: confira se copiou a chave inteira."), 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const anterior = await estadoDaChaveDeMapas(admin, authz.org.orgId).catch(() => null);
  const r = await guardarChaveDeMapas(admin, {
    organizationId: authz.org.orgId,
    chave: parsed.data.api_key,
    atorId: authz.user.id,
  });
  if (!r.ok) {
    return fail(
      "internal_error",
      r.erro === "cifra_indisponivel"
        ? t("A cifra do servidor não está disponível; a chave não foi gravada.")
        : t("Não consegui gravar a chave."),
      500,
      { requestId },
    );
  }

  await audit({
    action: "ai.maps_credential_saved",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "map_provider_credential",
    resourceId: null,
    requestId,
    // O QUE mudou, jamais o valor.
    metadata: { provider: PROVEDOR_DE_MAPAS, last4: r.ultimos4, trocou: Boolean(anterior?.configurada) },
  });

  const estado = await estadoDaChaveDeMapas(admin, authz.org.orgId);
  return ok(corpoDoEstado(estado), { requestId });
}

export async function DELETE(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_maps" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  let removeu: boolean;
  try {
    removeu = await removerChaveDeMapas(admin, authz.org.orgId);
  } catch {
    return fail("internal_error", traduzir("Não consegui remover a chave.", authz.user.idioma), 500, { requestId });
  }
  if (removeu) {
    await audit({
      action: "ai.maps_credential_removed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "map_provider_credential",
      resourceId: null,
      requestId,
      metadata: { provider: PROVEDOR_DE_MAPAS },
    });
  }
  return ok({ provider: PROVEDOR_DE_MAPAS, configurada: false, removida: removeu }, { requestId });
}
