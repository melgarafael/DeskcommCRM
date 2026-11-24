/**
 * GET   /api/v1/settings/links-de-contato — os tipos de link que esta empresa
 *       mostra na ficha e no funil (#5128).
 * PATCH /api/v1/settings/links-de-contato — grava a escolha (admin).
 *
 * ── Formato ─────────────────────────────────────────────────────────────────
 *
 *     organizations.settings.links_de_contato = { "tipos": ["instagram", …] }
 *
 * Chave NOVA num jsonb que já existe. Ausente/lixo continua valendo o catálogo
 * inteiro (`lib/leads/tipos-por-organizacao.ts`) — quem já instalou não muda
 * nada sem salvar na tela.
 *
 * ── Papéis ──────────────────────────────────────────────────────────────────
 *
 * GET é `viewer`: toda ficha e todo card precisam saber o que a empresa escolheu
 * mostrar. É leitura, e a escolha não é segredo — negá-la a quem atende faria a
 * tela dele mostrar justamente o que a empresa pediu para esconder.
 * PATCH é `admin`, o mesmo papel da vizinha `settings/catalogo` que grava
 * configuração da empresa.
 *
 * ── A escrita preserva o resto ──────────────────────────────────────────────
 *
 * O update troca o DESENHO INTEIRO de `settings` (jsonb não tem merge parcial):
 * por isso a mescla parte do documento relido e o CAS abaixo usa o documento
 * lido como filtro. Uma escrita concorrente vira 409, nunca perde a configuração
 * de outra pessoa.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  settingsComTiposDeLink,
  TODOS_OS_TIPOS_DE_LINK,
  tiposDeLinkHabilitados,
} from "@/lib/leads/tipos-por-organizacao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAXIMO_DE_TIPOS = TODOS_OS_TIPOS_DE_LINK.length;

/**
 * `tipos` é lista de ids do CATÁLOGO, sem repetição e com pelo menos um.
 *
 * `.max` fecha a porta para "corpo grande": o catálogo tem 9 tipos, e uma lista
 * maior é, na melhor das hipóteses, repetição; na pior, tentativa de engordar o
 * jsonb. O `.strict()` recusa chave que não seja `tipos`, então o PATCH nunca
 * ganha um campo que ninguém revisou.
 */
const patchSchema = z
  .object({
    tipos: z
      .array(z.string())
      .min(1)
      .max(MAXIMO_DE_TIPOS)
      .refine((ids) => new Set(ids).size === ids.length, { message: "tipo repetido" })
      .refine((ids) => ids.every((id) => TODOS_OS_TIPOS_DE_LINK.includes(id as never)), {
        message: "tipo fora do catálogo",
      }),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "settings_links_de_contato",
    role: "viewer",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.links-de-contato", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const db = createAdminClient();
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", authz.organizationId)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Não foi possível carregar os tipos de link."), 500, { requestId });
  }

  return ok(
    { tipos: tiposDeLinkHabilitados((data as { settings?: unknown } | null)?.settings) },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "settings_links_de_contato",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.links-de-contato", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Escolha ao menos um tipo de link válido."), 422, {
      requestId,
    });
  }

  // Admin client: a RLS de `organizations` só deixa platform admin escrever, e o
  // cliente de sessão casaria zero linhas dizendo "sucesso" (issue #144).
  const db = createAdminClient();
  const lido = await db
    .from("organizations")
    .select("settings")
    .eq("id", authz.organizationId)
    .maybeSingle();
  // Leitura que falhou NÃO vira `settings` vazio: o update apagaria o resto da
  // configuração da empresa.
  if (lido.error || !lido.data) {
    return fail("internal_error", t("Não foi possível salvar."), 500, { requestId });
  }

  const settings = lido.data.settings;
  if (settings !== null && (typeof settings !== "object" || Array.isArray(settings))) {
    return fail("conflict", t("A configuração da empresa está em um formato inesperado."), 409, {
      requestId,
    });
  }

  const tipos = parsed.data.tipos as (typeof TODOS_OS_TIPOS_DE_LINK)[number][];
  const novo = settingsComTiposDeLink(settings, tipos);

  // CAS do documento inteiro: escrita concorrente não perde outra configuração.
  const update = db.from("organizations").update({ settings: novo }).eq("id", authz.organizationId);
  const salvo = await (settings === null
    ? update.is("settings", null)
    : update.filter("settings", "eq", JSON.stringify(settings))
  )
    .select("id")
    .maybeSingle();
  if (salvo.error) return fail("internal_error", t("Não foi possível salvar."), 500, { requestId });
  if (!salvo.data) {
    return fail(
      "conflict",
      t("A configuração mudou. Recarregue a página e tente novamente."),
      409,
      { requestId },
    );
  }

  void audit({
    action: "settings.links_de_contato_updated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "organization",
    resourceId: authz.organizationId,
    requestId,
    metadata: { tipos },
  });

  return ok({ tipos: tiposDeLinkHabilitados(novo) }, { requestId });
}
