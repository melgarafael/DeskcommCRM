/**
 * GET /api/v1/pipelines/[id]/forecast — previsão ponderada de UM funil (issue #1535).
 *
 * "Quanto deve entrar, e quando?" — negócios abertos agrupados por moeda × mês
 * de `expected_close_date`, com o ponderado (valor × probabilidade da etapa) e
 * os baldes "sem data" e "sem probabilidade" reportados à parte. A regra pura
 * mora em `lib/leads/previsao.ts`; aqui só há transporte.
 *
 * Auth: sessão de navegador (`agent`, é leitura de card, não configuração) OU
 * Bearer `dsk_…` com escopo `config:read` e papel admin (`tokenRole`).
 *
 * ⚠️ NA SESSÃO O CLIENTE É O DE SESSÃO, e isto é o CRITÉRIO DE ACEITE, não um
 * detalhe de implementação: com `visibility_mode = "own"` (migration 0036) a RLS
 * devolve só os negócios do atendente, e é isso que faz a previsão de um
 * atendente ser a DELA. `resolveAuthDual` entrega `createClient()` na sessão e o
 * mesmo comportamento fica.
 *
 * ⚠️ NO TOKEN A LEITURA É DA ORGANIZAÇÃO INTEIRA. O cliente é o admin (sem RLS) e
 * não há pessoa para o `visibility_mode` recortar: por isso o token exige papel
 * admin, que já enxerga a equipe toda. Toda consulta de `carregarPrevisao` filtra
 * `organization_id`, e funil de outra organização responde 404.
 *
 * `organization_id` sai do JWT (sessão) ou da linha do token — nunca da URL nem
 * do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { carregarPrevisao } from "@/lib/leads/previsao";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "pipeline_forecast",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "pipelines.forecast", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;

  try {
    const previsao = await carregarPrevisao(authz.supabase, {
      organizationId: authz.organizationId,
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
