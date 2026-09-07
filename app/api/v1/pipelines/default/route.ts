/**
 * GET /api/v1/pipelines/default — pipeline padrão da org ativa (o primeiro
 * não-arquivado, se nenhum estiver marcado `is_default`), com estágios.
 *
 * Existe pra fluxos que precisam "de algum pipeline" sem exigir o role
 * `manager` da listagem completa (GET /api/v1/pipelines) — ex.: criar lead a
 * partir do painel do Inbox, onde quem atende é `agent`.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const supabase = await createClient();

  const { data: pipeline, error: pipelineErr } = await supabase
    .from("crm_pipelines")
    .select("*")
    .eq("organization_id", org.orgId)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (!pipeline) {
    return fail("resource_not_found", t("Nenhum funil configurado nesta organização."), 404, {
      requestId,
    });
  }

  const { data: stages, error: stagesErr } = await supabase
    .from("crm_stages")
    .select("*")
    .eq("pipeline_id", (pipeline as Pipeline).id)
    .eq("is_archived", false)
    .order("position");
  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });

  return ok(
    { pipeline: pipeline as Pipeline, stages: (stages ?? []) as Stage[] },
    { requestId },
  );
}
