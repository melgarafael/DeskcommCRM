/**
 * GET /api/v1/metrics/channels — o RELATÓRIO POR CANAL (issue #2390).
 *
 * Uma pergunta que as duas telas de relatório não respondem: **quantos
 * atendimentos veio por cada número/conexão**. O dado já existe
 * (`conversations.channel_session_id` + `channel`, migration 0027); a conta é a
 * RPC `fn_channel_metrics` (migration 0590), que copia a régua da irmã
 * `fn_attendant_metrics` (0037) e só troca o `group by` por
 * `channel_session_id`.
 *
 * ## Escopo = a PRÓPRIA RLS
 *
 * Igual à rota irmã: a RPC é SECURITY INVOKER e roda com o client de SESSÃO
 * (cookie validado), então a policy de `conversations` (0035) faz o recorte —
 * agent vê só as próprias conversas, manager+ a organização (e `owner_user_id`
 * restringe ainda mais quem compara). A organização vem de
 * `authz.org.orgId`, NUNCA da query: quem escreve a query é quem já está
 * logado nela. Piso de rota = `agent`, o mesmo da irmã — um piso maior
 * esconderia da pessoa as conversas dela.
 *
 * ## Read-only ⇒ sem audit
 *
 * Nenhuma mutação, nenhum service role: a doutrina de audit cobre
 * POST/PATCH/DELETE, e este handler nem importa `lib/audit`.
 *
 * ## Teto de janela: declarar o corte em vez de cortar em silêncio
 *
 * Mesma doutrina de `DIAS_MAXIMOS = 90` em `/reports/activities` e
 * `/reports/tags`: a janela padrão é 30 dias, e um "desde sempre" chega pela
 * query string de qualquer um. Passou do teto ⇒ 422 COM O MOTIVO — a rota
 * recusa em vez de devolver número cortado com cara de número inteiro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { montarLinhas, type LinhaCanalBruta } from "@/lib/metrics/canais";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Quantos dias a janela pode cobrir. O teto limita o que o relatório AFIRMA,
 * não o custo. Desde a migration 0596 (#2554), esta RPC e a irmã
 * `fn_attendant_metrics` cortam pela janela ANTES do lateral: o custo acompanha
 * as conversas DA janela, não o histórico inteiro da organização. Medido na
 * triagem do #2554 (Postgres do baseline, 10 mil conversas espalhadas em 120
 * dias, sob RLS, limite de 8 s do papel authenticated): janela de 1 dia em
 * ~1,4–1,8 s; 30 dias (~2.500 conversas na janela, a janela que a tela usa) e
 * 90 dias ainda passam de 8 s — nesse volume a tela recebe ERRO em vez de
 * lentidão, aqui e na irmã por atendente (issue #2514).
 */
const DIAS_MAXIMOS = 90;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  owner_user_id: z.string().uuid().optional(),
});

interface MetricsPayload {
  channels: LinhaCanalBruta[];
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso `agent`: a RLS é quem separa "as suas" da "da organização".
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    owner_user_id: url.searchParams.get("owner_user_id") ?? undefined,
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

  // O teto é declarado, não aplicado por baixo: a rota recusa a janela que não
  // pode medir em vez de devolver um total que mente sobre o corte.
  const dias = Math.ceil((to.getTime() - from.getTime()) / MS_POR_DIA);
  if (dias > DIAS_MAXIMOS) {
    return fail(
      "validation_failed",
      t("Janela de {dias} dias: o relatório por canal cobre no máximo {maximo} dias.")
        .replace("{dias}", String(dias))
        .replace("{maximo}", String(DIAS_MAXIMOS)),
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_channel_metrics", {
    p_org: activeOrg.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_owner: parsed.data.owner_user_id,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const metrics = (data ?? { channels: [] }) as unknown as MetricsPayload;

  return ok(
    {
      window: { from: from.toISOString(), to: to.toISOString() },
      owner_user_id: parsed.data.owner_user_id ?? null,
      // `montarLinhas` preserva `null` na média (null ≠ 0) e ordena por volume.
      channels: montarLinhas(metrics.channels),
    },
    { requestId },
  );
}
