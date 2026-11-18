import { describe, expect, it } from "vitest";

import { rodarLoopDaFila } from "@/lib/agent-engine/queue/loop";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/**
 * (e) O TESTE DE FIO DO RECUO DA FILA (#3878, sugestão 1) — relógio dublado.
 *
 * A conta pura está provada em `lib/agent-engine/queue/recuo.test.ts`. Aqui o
 * que se prova é o CALL SITE: o MESMO laço, com o MESMO relógio, fazendo menos
 * perguntas ao banco quando a fila está vazia e EXATAMENTE as mesmas quando há
 * trabalho agendado. Um teste só da aritmética ficaria verde com o laço
 * ignorando o teto — e é o laço que gasta a cota.
 *
 * Sem `vi.useFakeTimers`: a soneca é injetada e o tempo é o do teste (ver o
 * cabeçalho de `tests/unit/queue-loop.test.ts`).
 */

const HORIZONTE_MS = 600_000;
const BASE_MS = 2_000;
const TETO_MS = 60_000;

function logMudo(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

/**
 * Roda o laço por `HORIZONTE_MS` de tempo VIRTUAL. `respostaDoRelogio` recebe
 * o número da consulta (0-based) e devolve o que o banco diria: `null` = fila
 * vazia, número = ms até o próximo job.
 */
async function bancada(opcoes: {
  respostaDoRelogio: (consulta: number) => number | null;
  tetoMs?: number | undefined;
  horizonteMs?: number;
}): Promise<{ consultas: number; dormidas: number[] }> {
  const horizonte = opcoes.horizonteMs ?? HORIZONTE_MS;
  let agora = 0;
  let consultas = 0;
  const dormidas: number[] = [];

  await rodarLoopDaFila<{ id: string }>({
    relogio: async () => {
      consultas += 1;
      return opcoes.respostaDoRelogio(consultas - 1);
    },
    claimar: async () => [],
    aoClaimar: () => undefined,
    soneca: {
      acordar: () => undefined,
      geracao: () => 0,
      dormir: async (ms: number) => {
        dormidas.push(ms);
        agora += ms;
      },
    },
    deveParar: () => agora >= horizonte,
    intervalos: { ociosoMs: BASE_MS, retryMs: 250, ociosoMaxMs: opcoes.tetoMs },
    log: logMudo(),
  });

  return { consultas, dormidas };
}

describe("(e) laço da fila com relógio dublado — o recuo economiza consulta sem atrasar trabalho", () => {
  it("fila vazia: com teto o laço faz MUITO menos consultas no mesmo período", async () => {
    const semRecuo = await bancada({ respostaDoRelogio: () => null });
    const comRecuo = await bancada({ respostaDoRelogio: () => null, tetoMs: TETO_MS });

    // O ritmo de hoje (sem teto): uma consulta a cada piso de 2 s.
    expect(semRecuo.consultas).toBeGreaterThanOrEqual(290);
    // Com o recuo: 2 s, 4 s, 8 s, 16 s, 32 s e depois 1/min — dezenas, não centenas.
    expect(comRecuo.consultas).toBeLessThanOrEqual(20);
    expect(comRecuo.consultas).toBeLessThan(semRecuo.consultas / 10);
    // Nenhuma dormida fura o teto — nem a primeira, nem a última.
    for (const ms of comRecuo.dormidas) expect(ms).toBeLessThanOrEqual(TETO_MS);
    expect(comRecuo.dormidas.slice(0, 6)).toEqual([250, 2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  it("com trabalho agendado, o laço faz EXATAMENTE as mesmas consultas do ritmo de hoje", async () => {
    // Job vencendo em 60 s: o laço acorda no vencimento limitado pelo piso, então
    // o teto não entra — é o item 5 do pedido: o backoff só existe enquanto nada
    // aparece.
    const semTeto = await bancada({ respostaDoRelogio: () => 60_000 });
    const comTeto = await bancada({ respostaDoRelogio: () => 60_000, tetoMs: TETO_MS });

    expect(comTeto.consultas).toBe(semTeto.consultas);
    // E toda dormida é o piso (ou o retry do claim vazio), nunca o teto.
    for (const ms of comTeto.dormidas) expect(ms).toBeLessThanOrEqual(BASE_MS);
  });

  it("(b) no fio: passada com trabalho zera o recuo e a próxima espera volta ao piso", async () => {
    // Três passadas vazias seguidas (2 s, 4 s, 8 s) e então o banco passa a
    // responder que há trabalho: a volta seguinte tem de dormir o PISO.
    const { dormidas } = await bancada({
      respostaDoRelogio: (consulta) => (consulta < 3 ? null : 60_000),
      tetoMs: TETO_MS,
      horizonteMs: 40_000,
    });

    expect(dormidas.slice(0, 4)).toEqual([250, 2_000, 4_000, 8_000]);
    expect(dormidas[4]).toBe(BASE_MS);
  });
});
