/**
 * `/healthz` + `/metrics` do worker do agent-engine.
 *
 * ─── Por que isto mora num módulo próprio (#2505) ───────────────────────────
 *
 * O `main.ts` chama `main()` no TOPO do módulo (é entrypoint do `tsx`), então
 * importá-lo num teste subiria o worker inteiro — pool, loops, portas. Extrair
 * o servidor de saúde é o que permite o caso de aceite da #2505 existir: travar
 * o tick do drain e provar, pela porta de verdade, que o `/healthz` responde
 * não saudável depois do limite.
 *
 * ─── O laço da IA é informação de PRIMEIRA classe (#2505) ───────────────────
 *
 * O caso real (#2501): o drain do `ai_agent.dispatch_requested` ficou dois dias
 * esperando uma consulta que nunca voltou, o `/healthz` dizia `ok` o tempo
 * todo, e os eventos se acumulavam com `attempts=0`. O `event_log_drain` já
 * tinha o precedente (#604/#648: dez dias de laço parado com 200 no healthz) e
 * virou CAMPO em ambos os ramos; aqui, além do campo, o carimbo vencido vira
 * **503** — o pedido da issue é "responder não saudável", que é o que faz o
 * healthcheck do container e o operador agirem.
 */
import http from "node:http";

import type pg from "pg";

import { prontidaoDoDrainDaIa } from "@/lib/agent-engine/edge/crm/drain";
import { sessionHealthMetrics } from "@/lib/agent-engine/edge/crm/session-watchdog";
import { prontidaoDoLacoDeEventLog } from "@/lib/event-log/drain-loop";
import { metricsSnapshot, profundidadeDaFilaViva } from "@/lib/agent-engine/obs/metrics";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Mesma disciplina da fila: 1ª linha truncada — PII fora. */
function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n", 1)[0] ?? "").slice(0, 300);
}

export function createHealthzServer(
  pool: pg.Pool,
  log: Logger,
  metricsWindowMs: number,
): http.Server {
  const respond = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const route = (req.url ?? "").split("?", 1)[0];
    if (req.method !== "GET" || (route !== "/healthz" && route !== "/metrics")) {
      respond(res, 404, { error: "not_found" });
      return;
    }
    if (route === "/metrics") {
      try {
        respond(res, 200, await metricsSnapshot(pool, metricsWindowMs));
      } catch (err) {
        log.error("metrics: snapshot indisponível", { error: errMsg(err) });
        respond(res, 503, { status: "degraded", db: "error" });
      }
      return;
    }
    const uptime_s = Math.round(process.uptime());
    // Lido ANTES do banco: o carimbo do laço não depende do Postgres responder,
    // e é justamente quando ele não responde que o carimbo envelhece.
    const ia_drain = prontidaoDoDrainDaIa();
    try {
      const queue = await profundidadeDaFilaViva(pool);
      const sessions = await sessionHealthMetrics(pool);
      // O laço do event_log é informação de saúde de PRIMEIRA classe (#604): na
      // #648 este mesmo handler respondia 200 com o laço parado havia dez dias.
      // `event_log_drain` vai nos DOIS ramos, de propósito — a prontidão do laço
      // não depende do banco estar de pé.
      if (ia_drain.parado) {
        // Carimbo vencido = o laço travou NO MEIO de um tick (#2505): as
        // mensagens chegam e nenhum turno é enfileirado. Isto é 503 de propósito
        // — é o sinal que o healthcheck do container e o operador leem.
        respond(res, 503, {
          status: "degraded",
          db: "ok",
          queue,
          sessions,
          ia_drain,
          event_log_drain: prontidaoDoLacoDeEventLog(),
          uptime_s,
        });
        return;
      }
      respond(res, 200, {
        status: "ok",
        db: "ok",
        queue,
        sessions,
        ia_drain,
        event_log_drain: prontidaoDoLacoDeEventLog(),
        uptime_s,
      });
    } catch (err) {
      log.error("healthz: banco indisponível", { error: errMsg(err) });
      respond(res, 503, {
        status: "degraded",
        db: "error",
        queue: null,
        sessions: null,
        // Mesmo com o banco fora, os laços aparecem: o carimbo do drain já foi
        // lido acima e a prontidão do event_log é uma cópia em memória.
        ia_drain,
        event_log_drain: prontidaoDoLacoDeEventLog(),
        uptime_s,
      });
    }
  };
  return http.createServer((req, res) => void handle(req, res));
}
