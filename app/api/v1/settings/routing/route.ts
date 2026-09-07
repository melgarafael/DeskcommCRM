import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/settings/routing — lê a config de ATENDIMENTO (manager+):
 *      `organizations.settings.routing` + `settings.visibility_mode`.
 * PATCH /api/v1/settings/routing — grava as duas (manager+).
 *
 * Rota v1 dedicada (não o Server Action updateTenant): a matriz spec 13 §4 nota
 * 5 separa autz — routing/atendimento é manager+, enquanto o perfil da org
 * (updateTenant) é admin-only. Forçar routing no updateTenant misturaria os dois
 * gates. Merge não-destrutivo do jsonb settings (preserva as demais chaves).
 *
 * knobs (max_retries, backoff_seconds) são CONFIG — o worker de G5-02 LÊ daqui;
 * nunca constantes hardcoded no worker (doutrina). org de fonte confiável.
 *
 * POR QUE `visibility_mode` ENTRA AQUI (issue #144). A matriz de papéis da spec
 * 13 §4 trata as duas como a MESMA linha — "config de atendimento/roteamento:
 * manager+" — e a §3.5 as declara no mesmo bloco. Separar em duas rotas com o
 * mesmo gate seria inventar uma fronteira que a spec não tem, e deixaria a tela
 * fazendo dois round-trips para salvar uma decisão só ("como distribuo, e quem
 * enxerga o quê").
 *
 * Até esta mudança, `visibility_mode` era LIDO em `app/app/layout.tsx` e escrito
 * por NINGUÉM: a restrição existia na RLS, no schema e na doutrina, e não havia
 * caminho no produto para ligá-la — só `UPDATE` à mão no banco. Num produto
 * self-host isso equivale a não existir.
 *
 * `visibility_mode` fica em `settings.visibility_mode`, irmão de
 * `settings.routing` e não dentro dele: é esse caminho exato que
 * `fn_can_view_lead`/`fn_can_view_conversation` leem na RLS.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { atendimentoConfigPatchSchema, routingConfigSchema, validateRequest } from "@/lib/schemas";
import { DEFAULT_VISIBILITY_MODE, type VisibilityMode } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Default aplicado quando settings.routing ainda não existe (G1-06b). */
const DEFAULT_ROUTING = routingConfigSchema.parse({});

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_routing" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: orgRow, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const settings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const routing = routingConfigSchema.catch(DEFAULT_ROUTING).parse(settings.routing ?? {});
  // O default é o MESMO de `lib/auth/types.ts`, que é o que a RLS assume quando
  // a chave não existe (`coalesce(..., 'own_and_unassigned')`). Divergir aqui
  // faria a tela mostrar um estado que o banco não pratica.
  const visibility_mode = (settings.visibility_mode as VisibilityMode | undefined) ?? DEFAULT_VISIBILITY_MODE;
  return ok({ ...routing, visibility_mode }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_routing" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(atendimentoConfigPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

/**
 * A ESCRITA EM `organizations` VAI PELO ADMIN CLIENT — e não é preguiça.
 *
 * A única policy de escrita da tabela é `orgs_write_platform_admin`, com
 * `USING (fn_is_platform_admin())`. Pelo client de sessão, o UPDATE de quem não
 * é super-admin de plataforma casa ZERO linhas — e o PostgREST devolve sucesso,
 * porque "nenhuma linha casou o filtro" não é erro. Resultado: a tela dizia
 * "salvo", nada era gravado, e recarregar mostrava o estado antigo.
 *
 * Medido em Postgres com o baseline aplicado (issue #144): sob `authenticated`
 * com o JWT de um manager, `update organizations` devolve 0 linhas; sob
 * postgres, 1. Ninguém tinha notado porque o dono do repo e o owner criado pelo
 * `bootstrap-owner.ts` SÃO platform_admin — quem tropeça é o segundo admin
 * convidado e qualquer manager.
 *
 * O gate continua sendo o de cima (papel resolvido de fonte confiável), e o
 * filtro por `organization_id` é explícito, como a doutrina exige de todo
 * handler que usa service role.
 */
  const supabase = createAdminClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const { visibility_mode, ...routing } = input;
  // Merge não-destrutivo em DOIS níveis: preserva as demais chaves de `settings`
  // e, quando `visibility_mode` não vem no corpo, preserva a que já valia — um
  // cliente antigo (que só conhece o roteamento) não pode desligar a restrição
  // de visibilidade sem pedir.
  const nextSettings: Record<string, unknown> = { ...currentSettings, routing };
  if (visibility_mode !== undefined) nextSettings.visibility_mode = visibility_mode;

  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: nextSettings })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "routing.config_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { routing, ...(visibility_mode !== undefined ? { visibility_mode } : {}) },
  });

  return ok(
    {
      ...routing,
      visibility_mode:
        visibility_mode ??
        ((currentSettings.visibility_mode as VisibilityMode | undefined) ?? DEFAULT_VISIBILITY_MODE),
    },
    { requestId },
  );
}
