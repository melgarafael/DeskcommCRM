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
 * ## Escopo = a PRÓPRIA RLS (sessão) ou a linha do token (servidor)
 *
 * Igual à rota irmã: na sessão a RPC é SECURITY INVOKER e roda com o client de
 * SESSÃO (cookie validado), então a policy de `conversations` (0035) faz o
 * recorte — agent vê só as próprias conversas, manager+ a organização (e
 * `owner_user_id` restringe ainda mais quem compara). A organização vem de
 * `authz.organizationId`, NUNCA da query. Piso de rota = `agent`, o mesmo da
 * irmã — um piso maior esconderia da pessoa as conversas dela.
 *
 * Sessão OU token de servidor `dsk_…` com `mcp:read` (Spec 33, R3). Pelo token
 * não há RLS por atendente: o cliente é o de serviço e a leitura é a da
 * organização inteira, então o token exige papel `manager` (a tela de um agent
 * não abre mais do que as conversas dele).
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

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { montarLinhas, type LinhaCanalBruta } from "@/lib/metrics/canais";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import {
  datasDaJanela,
  janelaDoDesempenho,
  MAXIMO_DE_DIAS,
  MS_POR_DIA,
} from "@/lib/metrics/periodo-do-desempenho";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Em organizações grandes, até janelas válidas podem esgotar o tempo da
// RPC (veja o teste de custo em metricas-cortam-pela-janela.test.ts, #2554).
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

  // Piso `agent` na sessão: a RLS é quem separa "as suas" da "da organização".
  // O token vê a organização inteira, então exige `manager`.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "metrics",
    role: "agent",
    scope: "mcp:read",
    tokenRole: "manager",
  });
  if (!authz.ok) return authz.response;
  // Está em PUBLIC_PATHS: o teto do token é a única contagem das chamadas dele.
  const teto = await tetoDeEscritaDoToken(authz, "metrics", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

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
  const de = from.toISOString();
  const ate = to.toISOString();
  const dias = Math.ceil((to.getTime() - from.getTime()) / MS_POR_DIA);
  let periodoCivilValido = false;

  // Preserva o limite dos intervalos ISO arbitrários. A única exceção é o
  // período da tela, alinhado aos dias locais, alongado pelo recuo do relógio.
  if (dias === MAXIMO_DE_DIAS + 1) {
    const { data: org, error } = await authz.supabase
      .from("organizations")
      .select("timezone")
      .eq("id", authz.organizationId)
      .maybeSingle();
    if (error) return fail("internal_error", error.message, 500, { requestId });
    const fuso = fusoUtilizavel(org?.timezone);
    const periodo = janelaDoDesempenho(datasDaJanela({ from, to }, fuso), fuso);
    periodoCivilValido = "janela" in periodo && periodo.janela.from === de && periodo.janela.to === ate;
  }

  if (dias > MAXIMO_DE_DIAS && !periodoCivilValido) {
    return fail(
      "validation_failed",
      t("Janela de {dias} dias: o relatório por canal cobre no máximo {maximo} dias.")
        .replace("{dias}", String(dias))
        .replace("{maximo}", String(MAXIMO_DE_DIAS)),
      422,
      { requestId },
    );
  }

  const { data, error } = await authz.supabase.rpc("fn_channel_metrics", {
    p_org: authz.organizationId,
    p_from: de,
    p_to: ate,
    p_owner: parsed.data.owner_user_id,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const metrics = (data ?? { channels: [] }) as unknown as MetricsPayload;

  return ok(
    {
      window: { from: de, to: ate },
      owner_user_id: parsed.data.owner_user_id ?? null,
      // `montarLinhas` preserva `null` na média (null ≠ 0) e ordena por volume.
      channels: montarLinhas(metrics.channels),
    },
    { requestId },
  );
}
