/**
 * O prazo total do desligamento do worker (#2823) — num módulo, e não inline no
 * `main.ts`, por um motivo de prova: o que está errado aqui não é aritmética, é
 * ONDE o relógio começa. Inline, o único jeito de medir seria subir o worker
 * contra um Postgres de verdade e pendurar um laço — e um teste que precisa de
 * banco para provar prazo não roda no CI.
 *
 * O que a issue #2823 mediu: com o prazo armado DEPOIS de `await` nos laços (e
 * no `workerLoop`), um laço preso numa chamada de rede fica FORA da contagem —
 * 19,6 s numa parada ociosa sem PostgREST, e o `docker stop` continua esperando
 * depois disso. O desenho aqui é o inverso: o relógio arma no SINAL e o que for
 * aguardado entra dentro dele.
 *
 * E o prazo tem de CABER no que o kit dá: o Docker manda SIGKILL no
 * `stop_grace_period` (padrão de 10 s, e nem `docker-compose.prod.yml` nem
 * `hostgator-setup-kit/` declaravam um) — abaixo dos 30 s de `SHUTDOWN_GRACE_MS`.
 * Não é este módulo que resolve isso; quem resolve é o `stop_grace_period` do
 * compose, pela mesma issue. Aqui a garantia é só a de que o prazo não começa
 * tarde e não vaza: vencido, o processo sai e quem manda é ele, não o SIGKILL.
 */
import type { Logger } from "@/lib/agent-engine/obs/logger";

/**
 * `encerrado` = laços, drain e pool fecharam dentro do prazo, exit limpo.
 * `prazo-estourado` = o prazo venceu com trabalho ainda em curso; o chamador
 * encerra o processo (exit ≠ 0) — o reaper devolve o lease depois.
 */
export type FimDoDesligamento = "encerrado" | "prazo-estourado";

export interface DepsDoDesligamento {
  /** Prazo total, em ms, contado DO SINAL até o exit — `SHUTDOWN_GRACE_MS`. */
  prazoMs: number;
  /** Só para o log: qual sinal disparou. */
  sinal: NodeJS.Signals;
  /** Jobs em curso — só o tamanho é lido, para o log e para a evidência. */
  emVoo: () => number;
  /**
   * Efeitos síncronos do sinal: aborta os laços, fecha o healthz, para os
   * intervalos. Roda com o prazo JÁ correndo — fechar isso pode bloquear.
   */
  aoSinal: () => void;
  /**
   * O que o prazo TEM de cobrir, na ordem do chamador: laços, `workerLoop`,
   * drain dos jobs em voo e `pool.end()`. Se isto pendurar, é o prazo quem
   * decide — nunca a espera.
   */
  encerrar: () => Promise<void>;
  log: Logger;
  /** Injetável para o teste medir sem depender do relógio de parede. */
  agora?: () => number;
}

export async function desligarNoPrazo(deps: DepsDoDesligamento): Promise<FimDoDesligamento> {
  const agora = deps.agora ?? ((): number => Date.now());
  const inicio = agora();

  // (1) O RELÓGIO ARMA AQUI — antes do `aoSinal` e de qualquer `await`. É a
  // linha inteira da issue: armado depois de esperar os laços, o prazo não
  // cobria os laços, e a parada ociosa de 19,6 s (laço do event_log preso numa
  // chamada de rede) passava por fora dele.
  let timer: NodeJS.Timeout | undefined;
  const prazo = new Promise<"prazo-estourado">((resolve) => {
    timer = setTimeout(() => resolve("prazo-estourado"), deps.prazoMs);
  });

  deps.aoSinal();
  deps.log.info("sinal recebido — parando de claimar e drenando jobs em curso", {
    signal: deps.sinal,
    in_flight: deps.emVoo(),
    // O prazo TOTAL, não o que sobra: é este número que tem de caber no
    // `stop_grace_period` que o kit passa ao `docker stop`.
    prazo_total_ms: deps.prazoMs,
  });

  const encerramento = deps.encerrar();
  // O prazo pode vencer primeiro, e aí o processo sai no `process.exit` do
  // chamador com a promessa de encerramento ainda em voo: sem este `catch`, uma
  // rejeição tardia viraria `unhandledRejection` — e o exit code deixaria de ser
  // o que o desligamento escolheu.
  void encerramento.catch(() => undefined);
  const fim = await Promise.race([encerramento.then(() => "encerrado" as const), prazo]);
  clearTimeout(timer);

  if (fim === "prazo-estourado") {
    deps.log.error("shutdown: prazo total estourado — saindo sem esperar", {
      grace_ms: deps.prazoMs,
      // Medido, não estimado: é o que a evidência da issue precisa mostrar.
      decorrido_ms: agora() - inicio,
      in_flight: deps.emVoo(),
    });
    return fim;
  }

  deps.log.info("worker encerrado limpo", { decorrido_ms: agora() - inicio });
  return fim;
}
