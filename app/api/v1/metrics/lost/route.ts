/**
 * GET /api/v1/metrics/lost — relatório "Perdas" (issue #1537).
 *
 * Por motivo, por categoria e pela etapa de onde o negócio saiu
 * (`lost_from_stage_id`), em QUANTIDADE e em VALOR agrupado por moeda — o
 * agrupamento é `agruparPerdas` (`lib/metrics/perdas.ts`), que é a conta testada;
 * aqui só se lê e se monta o contexto.
 *
 * Escopo: manager+ (a comparação de métricas na tela é manager+, e este
 * relatório mostra o funil INTEIRO, não o pedaço do atendente). Leitura com o
 * client admin + `organization_id` explícito — a mesma disciplina de todo
 * service-role query do projeto. Read-only ⇒ sem audit.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { agruparPerdas, type PerdaLinha } from "@/lib/metrics/perdas";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Teto da leitura: acima disso o relatório diz que está cortado, não mente. */
const LIMITE = 5000;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }

  const supabase = createAdminClient();

  const [perdas, funis, etapas] = await Promise.all([
    supabase
      .from("crm_leads")
      .select("lost_reason, lost_from_stage_id, value_cents, currency, pipeline_id")
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "lost")
      .gte("closed_at", from.toISOString())
      .lt("closed_at", to.toISOString())
      .order("closed_at", { ascending: false })
      .limit(LIMITE),
    supabase.from("crm_pipelines").select("id, settings").eq("organization_id", activeOrg.orgId),
    supabase.from("crm_stages").select("id, name").eq("organization_id", activeOrg.orgId),
  ]);

  if (perdas.error) return fail("internal_error", perdas.error.message, 500, { requestId });
  if (funis.error) return fail("internal_error", funis.error.message, 500, { requestId });
  if (etapas.error) return fail("internal_error", etapas.error.message, 500, { requestId });

  const settingsPorFunil: Record<string, unknown> = {};
  for (const funil of funis.data ?? []) settingsPorFunil[funil.id] = funil.settings;

  const nomesDasEtapas: Record<string, string> = {};
  for (const etapa of etapas.data ?? []) nomesDasEtapas[etapa.id] = etapa.name;

  const linhas = (perdas.data ?? []) as PerdaLinha[];
  const relatorio = agruparPerdas(linhas, { settingsPorFunil, etapas: nomesDasEtapas });

  return ok(
    {
      janela: { from: from.toISOString(), to: to.toISOString() },
      ...relatorio,
      truncado: linhas.length >= LIMITE,
    },
    { requestId },
  );
}
