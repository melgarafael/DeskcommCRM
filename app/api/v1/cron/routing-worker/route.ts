/**
 * GET/POST /api/v1/cron/routing-worker — G5-02 (AT-03, spec 13 §5).
 *
 * Drena `conversation.routing_requested` do event_log e distribui conversas sem
 * dono segundo o modo da org (manual = no-op; round_robin = rodízio entre
 * elegíveis). Trigger NUNCA faz HTTP — a emissão é um trigger AFTER INSERT em
 * conversations (migration 0040); este cron TS consome via admin client.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed). Audit agregada por tick.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { runRoutingWorker } from "@/lib/routing/worker";

export const dynamic = "force-dynamic";

/**
 * O que roda DEPOIS do portão (#3773), na ordem do arquivo.
 *
 * Nenhum destes passos pode ser pulado numa instalação ociosa, e a lista é a
 * decisão escrita: `summary`/`try` são a própria rodada (que só roda quando há
 * evento na fila); a auditoria já é condicional a `batch_size > 0`, ou seja, o
 * tick vazio não gravava linha de auditoria nem antes deste portão; e o
 * `return` é a resposta. Passo novo aqui embaixo — um aviso, uma promoção —
 * precisa ser declarado, e o teste reprova se a lista divergir do fonte.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let summary",
  "try",
  "if (summary.batch_size > 0 || summary.errors.length > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // ─── O PISO OCIOSO DA ÚLTIMA ROTA DE MINUTO A MINUTO (#3878) ───────────────
  //
  // A rodada faz DUAS leituras no PostgREST antes de saber que não há nada a
  // fazer: a varredura de `processing` preso (janela de 5 min) e a de
  // `pending`. Numa instalação ociosa isso é 2 requisições por minuto, 2.880
  // por dia, contra `event_log` — o endpoint nº 1 do egress no relato da #3878
  // (18.880 chamadas/dia) — para receber dois vazios.
  //
  // O portão responde à mesma pergunta por UMA consulta no pool `pg`
  // compartilhada com as outras rotas (`lib/cron/piso-ocioso.ts`), que não gasta
  // a cota do PostgREST. O predicado dele é DELIBERADAMENTE mais largo que a
  // varredura (aceita `pending` já vencido e `processing` acima de 5 min);
  // fechar com trabalho na fila é o defeito que o portão existe para não ter.
  //
  // A promessa que NÃO muda: evento novo é distribuído na primeira batida
  // seguinte ao TTL de 30 s — o mesmo atraso que qualquer outra rota do
  // crontab já tem hoje com o portão ligado, e bem abaixo do minuto de cadência
  // que a rota sempre teve.
  if (await recursoOcioso("roteamento")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  let summary;
  try {
    summary = await runRoutingWorker();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[routing-worker.cron] runRoutingWorker threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }

  // Tick que não drenou evento nenhum não é mutação e não ocupa linha de
  // auditoria (mesmo critério do snooze-watcher, do followup-flow-worker e do
  // recover-stuck-messages). Esta rota roda 1×/min: auditar incondicionalmente
  // gravava 43.200 linhas/mês numa instalação que não atende ninguém, numa
  // tabela append-only com retenção de anos — 95% do audit log de uma VPS real
  // era batida de cron vazia (`docs/testing/user-journey-map.md`, achado 17).
  //
  // `errors` entra na condição e NÃO é redundante com `batch_size`: quando o
  // `select` do event_log falha, `runRoutingWorker` devolve `batch_size = 0` com
  // o erro dentro (worker.ts:88). Sem esta cláusula, o tick em que o banco não
  // respondeu ficaria idêntico, na trilha, ao tick de uma instalação sem nada a
  // fazer — o mesmo defeito que `claim_falhou` conserta no followup-flow-worker.
  if (summary.batch_size > 0 || summary.errors.length > 0) {
    void audit({
      action: "routing.worker_run",
      organizationId: null,
      bypassedRls: true,
      metadata: {
        batch_size: summary.batch_size,
        outcomes: summary.outcomes,
        errors: summary.errors.length,
      },
      requestId,
    });
  }

  return ok(
    { batch_size: summary.batch_size, outcomes: summary.outcomes, errors: summary.errors },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
