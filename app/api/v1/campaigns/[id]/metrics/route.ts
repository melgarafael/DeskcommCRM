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
 * consulta traz só id, estados e carimbos (sem PII) e conta em memória, com
 * teto — acima dele a resposta diz que é parcial em vez de mentir.
 *
 * Uma resposta é cortada pelo `max_rows` do PostgREST, mesmo com `.limit`
 * maior. Por isso a leitura segue por id até a página vazia; página curta não
 * prova o fim. O cursor não desloca linhas quando uma anterior é excluída.
 * São leituras sucessivas, não um snapshot: estados e linhas podem mudar
 * durante a chamada. `parcial` sinaliza linhas além do teto observado.
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
const TAMANHO_DA_PAGINA = 1000;

type LinhaDeDestinatario = {
  id: string;
  status: string;
  eligibility_status: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  opted_out_at: string | null;
};

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
  const consultaDeDestinatarios = () =>
    supabase
      .from("campaign_recipients")
      .select(
        "id, status, eligibility_status, sent_at, delivered_at, read_at, replied_at, opted_out_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("campaign_id", id)
      .order("id", { ascending: true });

  const linhas: LinhaDeDestinatario[] = [];
  let cursor: string | null = null;
  let parcial = false;
  while (linhas.length < TETO) {
    let consulta = consultaDeDestinatarios().limit(
      Math.min(TAMANHO_DA_PAGINA, TETO - linhas.length),
    );
    if (cursor) consulta = consulta.gt("id", cursor);
    const { data, error } = await consulta;
    if (error) return fail("internal_error", error.message, 500, { requestId });
    const lote = (data ?? []) as LinhaDeDestinatario[];
    if (lote.length === 0) break;
    const ultimoId = lote[lote.length - 1]!.id;
    if (cursor && ultimoId <= cursor) {
      return fail("internal_error", "campaign_metrics_page_did_not_advance", 500, { requestId });
    }
    linhas.push(...lote);
    cursor = ultimoId;
    if (linhas.length === TETO) {
      // Mesmo recorte e ordem da leitura. A sonda não entra nas contagens:
      // exatamente 20.000 não é parcial; uma linha além deles prova o corte.
      const { data: sobra, error: erroSobra } = await consultaDeDestinatarios()
        .gt("id", cursor)
        .limit(1);
      if (erroSobra) return fail("internal_error", erroSobra.message, 500, { requestId });
      parcial = (sobra ?? []).length > 0;
    }
  }

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
      parcial,
    },
    { requestId },
  );
}
