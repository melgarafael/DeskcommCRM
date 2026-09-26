/**
 * GET /api/v1/pipelines/[id]/forecast — previsão ponderada de UM funil (issue #1535).
 *
 * "Quanto deve entrar, e quando?" — negócios abertos agrupados por moeda × mês
 * de `expected_close_date`, com o ponderado (valor × probabilidade da etapa) e
 * os baldes "sem data" e "sem probabilidade" reportados à parte. A regra pura
 * mora em `lib/leads/previsao.ts`; aqui só há transporte.
 *
 * Auth: `requireRole("agent")` — é leitura de card, não configuração.
 *
 * ⚠️ O CLIENTE É O DE SESSÃO, e isto é o CRITÉRIO DE ACEITE, não um detalhe de
 * implementação: com `visibility_mode = "own"` (migration 0036) a RLS devolve
 * só os negócios do atendente, e é isso que faz a previsão de um atendente ser
 * a DELE. Um cliente admin furaria o `visibility_mode` e devolveria a previsão
 * da equipe inteira para quem só deveria ver a própria.
 *
 * `organization_id` sai do JWT — nunca da URL nem do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carregarPrevisao } from "@/lib/leads/previsao";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pipeline_forecast" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  try {
    const supabase = await createClient();
    const previsao = await carregarPrevisao(supabase, {
      organizationId: authz.org.orgId,
      pipelineId: id,
      requestId,
    });
    return ok(previsao, { requestId });
  } catch (e) {
    if (e instanceof ApiError) {
      return fail(e.code, e.message, e.status, { requestId, details: e.details });
    }
    return fail("internal_error", t("Falha ao calcular a previsão do funil."), 500, { requestId });
  }
}
