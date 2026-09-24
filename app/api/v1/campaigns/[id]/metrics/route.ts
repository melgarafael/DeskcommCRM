/**
 * GET /api/v1/campaigns/:id/metrics — o funil da campanha.
 *
 * As contagens saem dos DESTINATÁRIOS, que são a fonte da verdade; os contadores
 * de `campaigns` são cache do snapshot e não entram na conta de execução. O funil
 * é contado por CARIMBO (`sent_at`, `delivered_at`, …) e não por `status`: quem
 * respondeu vale `replied`, mas também foi entregue e lido — contar por status
 * faria a taxa de entrega CAIR quando a campanha vai bem.
 *
 * Sem RPC e sem `count(*) filter`: o PostgREST não expõe agregação condicional,
 * e criar uma função de banco para isto seria uma peça a mais para manter. A
 * consulta traz só os carimbos (seis colunas, sem PII) e conta em memória, com
 * teto — acima dele a resposta diz que é parcial em vez de mentir.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { progresso, taxasDaCampanha, type ContagemDaCampanha } from "@/lib/campanhas/metricas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto de linhas lidas por chamada. Acima disso a resposta se declara parcial. */
const TETO = 20_000;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaign_recipients")
    .select("status, eligibility_status, sent_at, delivered_at, read_at, replied_at, opted_out_at")
    .eq("organization_id", authz.org.orgId)
    .eq("campaign_id", id)
    .limit(TETO);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = (data ?? []) as unknown as Array<{
    status: string;
    eligibility_status: string;
    sent_at: string | null;
    delivered_at: string | null;
    read_at: string | null;
    replied_at: string | null;
    opted_out_at: string | null;
  }>;

  if (linhas.length === 0) {
    // Zero linhas pode ser campanha não preparada OU campanha de outra
    // organização. As duas respondem igual de propósito: a segunda não deve
    // revelar que existe.
    const { data: existe } = await supabase
      .from("campaigns")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (!existe) {
      return fail("campanha_nao_encontrada", t("Campanha não encontrada."), 404, { requestId });
    }
  }

  const c: ContagemDaCampanha = {
    total: linhas.length,
    elegiveis: linhas.filter((l) => l.eligibility_status === "eligible").length,
    excluidos: linhas.filter((l) => l.eligibility_status === "excluded").length,
    pendentes: linhas.filter((l) => l.status === "pending").length,
    naFila: linhas.filter((l) => l.status === "queued").length,
    enviando: linhas.filter((l) => l.status === "sending").length,
    enviados: linhas.filter((l) => l.sent_at !== null).length,
    entregues: linhas.filter((l) => l.delivered_at !== null).length,
    lidos: linhas.filter((l) => l.read_at !== null).length,
    responderam: linhas.filter((l) => l.replied_at !== null).length,
    falharam: linhas.filter((l) => l.status === "failed").length,
    cancelados: linhas.filter((l) => l.status === "cancelled").length,
    optOut: linhas.filter((l) => l.opted_out_at !== null).length,
  };

  return ok(
    {
      contagem: c,
      taxas: taxasDaCampanha(c),
      progresso: progresso(c),
      parcial: linhas.length >= TETO,
    },
    { requestId },
  );
}
