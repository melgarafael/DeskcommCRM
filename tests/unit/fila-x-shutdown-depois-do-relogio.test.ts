/**
 * A fila no DESLIGAMENTO (#2823) — o item (c) do conserto, que mora no laço de
 * consumo e não no shutdown:
 *
 *   (c1) a checagem de parada DEPOIS do await do relógio impede um claim NOVO
 *        quando o shutdown chegou enquanto a consulta estava em voo — claimar
 *        ali abriria uma transação que o drain já não vai esperar, e o lease
 *        ficaria preso até o reaper (QUEUE_VISIBILITY_TIMEOUT_MS);
 *   (c2) um claim JÁ iniciado termina e despacha: interromper no meio é largar
 *        o lease — é o guarda contra o conserto exagerado, e por isso ele é
 *        verde também sem a mudança.
 *
 * Sem Postgres e sem fake timers (mesmo motivo de `tests/unit/queue-loop.test.ts`):
 * `vi.useFakeTimers()` não fakeia o `setTimeout` de `node:timers/promises`, que
 * é o que o worker usa para dormir.
 */
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { rodarLoopDaFila } from "@/lib/agent-engine/queue/loop";

const INTERVALOS = { ociosoMs: 2_000, retryMs: 250 };

function logSpy(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop };
}

describe("fila × shutdown", () => {
  it("parar DURANTE o relógio pendente: nenhum claim novo abre transação", async () => {
    let parado = false;
    const claimsDepoisDeParar: number[] = [];
    const claimar = vi.fn(async () => {
      if (parado) claimsDepoisDeParar.push(1);
      return [];
    });
    // O shutdown chega enquanto a consulta do relógio está em voo: ela devolve
    // `0` (há trabalho VENCIDO) — o estado em que o claim seguiria sem a guarda.
    const relogio = vi.fn(async () => {
      parado = true;
      return 0;
    });

    await rodarLoopDaFila({
      relogio,
      claimar,
      aoClaimar: () => undefined,
      dormir: async () => undefined,
      deveParar: () => parado,
      intervalos: INTERVALOS,
      log: logSpy(),
    });

    expect(
      claimsDepoisDeParar,
      "o laço claimou DEPOIS do relógio ter dito que o shutdown já tinha chegado",
    ).toHaveLength(0);
    expect(claimar, "só o claim do boot — o de depois do relógio não nasce").toHaveBeenCalledTimes(1);
  });

  it("claim já iniciado termina e despacha — o lease não é largado no meio", async () => {
    let parado = false;
    const despachados: { id: string }[] = [];
    // O shutdown chega DURANTE o claim: ele já começou, então precisa ir até o
    // fim e despachar — o job em lease abandonado só volta quando o reaper
    // expira o QUEUE_VISIBILITY_TIMEOUT_MS (10 minutos).
    const claimar = vi.fn(async () => {
      parado = true;
      return [{ id: "job-9" }];
    });

    await rodarLoopDaFila({
      relogio: async () => 0,
      claimar,
      aoClaimar: (jobs) => void despachados.push(...jobs),
      dormir: async () => undefined,
      deveParar: () => parado,
      intervalos: INTERVALOS,
      log: logSpy(),
    });

    expect(despachados, "o claim em curso foi abandonado com o lease aberto").toEqual([{ id: "job-9" }]);
  });
});
