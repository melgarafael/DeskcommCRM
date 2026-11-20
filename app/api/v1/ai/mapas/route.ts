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

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { extractBearer } from "@/lib/mcp/auth";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import {
  chaveDeMapasSchema,
  estadoDaChaveDeMapas,
  guardarChaveDeMapas,
  PROVEDOR_DE_MAPAS,
  removerChaveDeMapas,
} from "@/lib/mapas/credencial";
import { createAdminClient } from "@/lib/supabase/admin";

const putSchema = z.object({ api_key: chaveDeMapasSchema }).strict();

/** Quem chama, pelo portão que o trouxe (sessão de navegador ou token de integração). */
type QuemChama = { idioma: Idioma; orgId: string; autor: string | null; apiTokenId: string | null };

function corpoDoEstado(e: Awaited<ReturnType<typeof estadoDaChaveDeMapas>>) {
  return { provider: PROVEDOR_DE_MAPAS, configurada: e.configurada, ultimos4: e.ultimos4, atualizada_em: e.atualizadaEm };
}

async function lerEstado(orgId: string, idioma: Idioma, requestId: string): Promise<Response> {
  try {
    const estado = await estadoDaChaveDeMapas(createAdminClient(), orgId);
    return ok(corpoDoEstado(estado), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não consegui ler a configuração de mapas.", idioma), 500, { requestId });
  }
}

export async function GET(req?: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Token de integração (Bearer). Sem Bearer, a sessão segue como era.
  if (req && extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "ai_maps",
      role: "manager",
      scope: "config:read",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "ai_maps", requestId);
    if (teto) return teto;
    return lerEstado(authz.organizationId, authz.idioma ?? IDIOMA_PADRAO, requestId);
  }

  const authz = await requireRole("manager", { requestId, resource: "ai_maps" });
  if (!authz.ok) return authz.response;
  return lerEstado(authz.org.orgId, authz.user.idioma, requestId);
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let quem: QuemChama;
  if (extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "ai_maps",
      role: "admin",
      scope: "config:write",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "ai_maps", requestId);
    if (teto) return teto;
    quem = {
      idioma: authz.idioma ?? IDIOMA_PADRAO,
      orgId: authz.organizationId,
      autor: authz.actor.type === "user" ? authz.actor.id : null,
      apiTokenId: authz.apiTokenId ?? null,
    };
  } else {
    const authz = await requireRole("admin", { requestId, resource: "ai_maps" });
    if (!authz.ok) return authz.response;
    quem = { idioma: authz.user.idioma, orgId: authz.org.orgId, autor: authz.user.id, apiTokenId: null };
  }
  const t = (texto: string) => traduzir(texto, quem.idioma);

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
  const anterior = await estadoDaChaveDeMapas(admin, quem.orgId).catch(() => null);
  const r = await guardarChaveDeMapas(admin, {
    organizationId: quem.orgId,
    chave: parsed.data.api_key,
    atorId: quem.autor,
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
    actorUserId: quem.autor,
    actorApiTokenId: quem.apiTokenId,
    organizationId: quem.orgId,
    resourceType: "map_provider_credential",
    resourceId: null,
    requestId,
    // O QUE mudou, jamais o valor.
    metadata: { provider: PROVEDOR_DE_MAPAS, last4: r.ultimos4, trocou: Boolean(anterior?.configurada) },
  });

  const estado = await estadoDaChaveDeMapas(admin, quem.orgId);
  return ok(corpoDoEstado(estado), { requestId });
}

export async function DELETE(req?: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let quem: QuemChama;
  if (req && extractBearer(req.headers.get("authorization"))) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "ai_maps",
      role: "admin",
      scope: "config:write",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "ai_maps", requestId);
    if (teto) return teto;
    quem = {
      idioma: authz.idioma ?? IDIOMA_PADRAO,
      orgId: authz.organizationId,
      autor: authz.actor.type === "user" ? authz.actor.id : null,
      apiTokenId: authz.apiTokenId ?? null,
    };
  } else {
    const authz = await requireRole("admin", { requestId, resource: "ai_maps" });
    if (!authz.ok) return authz.response;
    quem = { idioma: authz.user.idioma, orgId: authz.org.orgId, autor: authz.user.id, apiTokenId: null };
  }

  const admin = createAdminClient();
  let removeu: boolean;
  try {
    removeu = await removerChaveDeMapas(admin, quem.orgId);
  } catch {
    return fail("internal_error", traduzir("Não consegui remover a chave.", quem.idioma), 500, { requestId });
  }
  if (removeu) {
    await audit({
      action: "ai.maps_credential_removed",
      actorUserId: quem.autor,
      actorApiTokenId: quem.apiTokenId,
      organizationId: quem.orgId,
      resourceType: "map_provider_credential",
      resourceId: null,
      requestId,
      metadata: { provider: PROVEDOR_DE_MAPAS },
    });
  }
  return ok({ provider: PROVEDOR_DE_MAPAS, configurada: false, removida: removeu }, { requestId });
}
