/**
 * GET /api/v1/cron/webhook-log-retention
 *
 * Poda o arquivo do corpo cru dos webhooks (`webhook_events_log`). Um lote por
 * chamada, idempotente: linha já esvaziada não é escolhida de novo.
 *
 * Por que ele existe, em uma linha: numa instalação real o arquivo era 86% do
 * banco (468 MB de 545 MB) e crescia ~23 MB/dia sem teto, contra os 500 MB do
 * plano gratuito do Supabase — onde a maioria dos clones vive. O racional
 * inteiro está em `lib/channels/retencao-do-arquivo.ts`.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fecha quando falta o
 * segredo). Mesma forma de `app/api/v1/cron/storage-redaction/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { LOTE_PADRAO, podarArquivoDeWebhooks } from "@/lib/channels/retencao-do-arquivo";
import { podarHistoricoDeCaptacao } from "@/lib/webhooks/retencao-da-captacao";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

const LOTE_MAXIMO = 5_000;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O lote é ajustável pela URL para o PRIMEIRO dia, que é o caso incomum: uma
  // instalação que nunca podou chega aqui com dezenas de milhares de linhas
  // atrasadas, e o operador quer alcançar o estado estável sem esperar dias.
  // O teto existe porque um lote gigante segura a tabela em que TODO webhook
  // escreve — a poda derrubando a entrada de mensagem seria o oposto do ponto.
  const url = new URL(req.url);
  const pedido = Number.parseInt(url.searchParams.get("lote") ?? "", 10);
  const lote =
    Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, LOTE_MAXIMO) : LOTE_PADRAO;

  const admin = createAdminClient();

  const resultado = await podarArquivoDeWebhooks(admin, {
    diasComCorpo: env.WEBHOOK_LOG_BODY_RETENTION_DAYS,
    diasParaApagar: env.WEBHOOK_LOG_ROW_RETENTION_DAYS,
    lote,
  });

  // O HISTÓRICO de captação (`webhook_lead_captures`) roda no MESMO tique, e
  // não num cron novo: são duas tabelas do mesmo assunto, e uma rota a mais
  // seria mais uma linha no `entrypoint.sh` do scheduler para alguém esquecer
  // de agendar — o defeito que já custou meses ao risk-watcher e ao
  // routing-worker. Horizonte próprio (muito mais longo), porque lá a linha é
  // despejo de depuração e aqui ela é o produto.
  const captacao = await podarHistoricoDeCaptacao(admin, {
    // A STRING crua, e não um número já coagido: quem interpreta é
    // `lib/retencao/politica.ts`, que sabe resolver lixo para o lado seguro E
    // devolver a frase de aviso. Coagir antes jogaria o aviso fora.
    diasBrutos: env.LEAD_CAPTURE_RETENTION_DAYS,
    lote,
  });

  return ok({ ...resultado, captacao }, { requestId });
}
