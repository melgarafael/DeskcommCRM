/**
 * GET   /api/v1/settings/task-plans — os planos de tarefa da organização.
 * PATCH /api/v1/settings/task-plans — grava (manager+).
 *
 * Mesma forma da rota de campanhas (`settings/campanhas`): merge NÃO destrutivo
 * do jsonb `organizations.settings`, preservando as demais chaves. Sobrescrever
 * o objeto inteiro apagaria `campanhas`, `routing` e o resto — e o estrago só
 * apareceria na próxima vez que alguém precisasse deles.
 *
 * O PATCH valida com o `planosSchema` de `lib/tarefas/plano.ts` — o MESMO que a
 * leitura do motor usa. Sem esta porta, criar um plano exigia editar o banco à
 * mão; com ela, o que a tela grava é exatamente o que `apply_task_plan` aplica.
 *
 * O GET devolve os planos VÁLIDOS (`lePlanosDoSettings`): é o que o motor
 * enxerga e o que o editor de regras oferece. Um item torto não é aplicável hoje
 * — ele já não estava em nenhum seletor, e o próximo salvamento o normaliza.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { lePlanosDoSettings, planosSchema } from "@/lib/tarefas/plano";

export const dynamic = "force-dynamic";

type LinhaDeOrganizacao = { settings?: unknown } | null;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "task_plans", role: "viewer", scope: "config:read", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.task-plans", requestId);
  if (teto) return teto;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.organizationId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    { planos: lePlanosDoSettings((data as LinhaDeOrganizacao)?.settings) },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "task_plans", role: "manager", scope: "config:write", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.task-plans", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const corpo = await req.json().catch(() => null);
  const parsed = planosSchema.safeParse(
    corpo && typeof corpo === "object" && !Array.isArray(corpo)
      ? (corpo as { planos?: unknown }).planos
      : undefined,
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      // `flatten().fieldErrors` desta rota é array (o schema raiz é uma lista),
      // então o caminho vira string: "0.titulo" → "o item 0, campo titulo".
      details: Object.fromEntries(
        parsed.error.issues.map((problema) => [
          problema.path.map(String).join(".") || "raiz",
          problema.message,
        ]),
      ),
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
    .update({ settings: { ...settings, task_plans: parsed.data } })
    .eq("id", authz.organizationId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "task_plans.settings_updated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "organization",
    resourceId: authz.organizationId,
    requestId,
    metadata: { planos: parsed.data.length } as unknown as Record<string, unknown>,
  });

  return ok({ planos: parsed.data }, { requestId });
}
