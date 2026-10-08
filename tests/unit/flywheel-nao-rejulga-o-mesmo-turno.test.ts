/**
 * O FLYWHEEL NÃO PAGA O JUIZ DUAS VEZES PELO MESMO TURNO.
 *
 * `collectRecentTurns` pegava os N turnos mais recentes sem olhar se já tinham
 * veredito; o `on conflict do nothing` do INSERT descartava o resultado DEPOIS
 * de a chamada ao modelo ter sido paga. Numa instalação parada, cada rodada
 * agendada (6h por padrão) rejulgava os mesmos turnos.
 *
 * ## O que este dublê é, e o que ele não é
 *
 * Não há Postgres aqui. O pool de brinquedo responde à consulta de turnos
 * aplicando, em JS, só os predicados que o SQL ESCREVE — `not exists` de
 * veredito, a janela `make_interval`, o `distinct on (j.contact_id)` — e
 * guarda os vereditos que o INSERT grava. Tirar um predicado do SQL tira o
 * filtro correspondente daqui, e o caso que depende dele fica vermelho.
 *
 * A POSIÇÃO do `not exists` também é lida do SQL: dentro da subconsulta (antes
 * do `) t`) ele filtra ANTES do `distinct on`, fora dela, DEPOIS — e é essa
 * ordem que o caso "um turno por contato" vigia. A sintaxe da consulta contra
 * um banco de verdade NÃO é medida por este arquivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: Array<Record<string, unknown>> = [];

vi.mock("../../lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(async (_pool: unknown, _cfg: unknown, input: Record<string, unknown>) => {
    chamadas.push(input);
    return { provider: "anthropic", model: "claude-haiku-4-5", result: { text: '{"verdict":"yes"}' } };
  }),
}));

import { runFlywheelLoop, runFlywheelOnce } from "../../lib/agent-engine/flywheel/live";

const HORA = 3_600_000;

interface Turno {
  job_id: string;
  organization_id: string;
  contact_id: string;
  idadeMs: number;
}

function turno(n: number, contato: string, idadeMs: number): Turno {
  return { job_id: `0000000${n}-0000-4000-8000-000000000000`, organization_id: "org-1", contact_id: contato, idadeMs };
}

function poolFalso(turnos: Turno[]) {
  const julgados = new Set<string>();
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from job_queue")) {
      consultas.push({ sql, params });
      let ls = [...turnos].sort((a, b) => a.idadeMs - b.idadeMs);
      const janelaS = params[1] as number | null;
      if (/make_interval\(secs => \$2/.test(sql) && janelaS !== null) {
        ls = ls.filter((t) => t.idadeMs < janelaS * 1000);
      }
      const posNotExists = sql.search(/not exists \(\s*select 1 from flywheel_judge_verdicts/);
      const naoJulgados = () => (ls = ls.filter((t) => !julgados.has(t.job_id)));
      const antesDoDistinct = posNotExists >= 0 && posNotExists < sql.indexOf(") t");
      if (antesDoDistinct) naoJulgados();
      if (/distinct on \(j\.contact_id\)/.test(sql)) {
        const vistos = new Set<string>();
        ls = ls.filter((t) => !vistos.has(t.contact_id) && vistos.add(t.contact_id));
      }
      if (posNotExists >= 0 && !antesDoDistinct) naoJulgados();
      return { rows: ls.slice(0, params[0] as number), rowCount: ls.length };
    }
    if (sql.includes("insert into flywheel_judge_verdicts")) {
      const id = params[2] as string;
      const novo = !julgados.has(id);
      julgados.add(id);
      return { rows: [], rowCount: novo ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, consultas };
}

const LOG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const juizes = () => chamadas.filter((c) => c.purpose === "flywheel_judge");

beforeEach(() => {
  chamadas.length = 0;
});

describe("flywheel — o juiz só é pago por turno ainda não julgado", () => {
  it("segunda rodada sem turno novo: zero chamadas ao modelo", async () => {
    const turnos = [turno(1, "c-1", HORA), turno(2, "c-2", 2 * HORA)];
    const { pool } = poolFalso(turnos);

    const primeira = await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG, janelaMs: 12 * HORA });
    expect(primeira.judged, "controle: a primeira rodada julga os dois").toBe(2);
    expect(juizes()).toHaveLength(2);

    chamadas.length = 0;
    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG, janelaMs: 12 * HORA });
    expect(juizes(), "o juiz foi pago de novo por turnos que já têm veredito").toHaveLength(0);

    chamadas.length = 0;
    // Controle: um turno novo de um contato já julgado é julgado — só ele.
    turnos.push(turno(3, "c-1", 0));
    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG, janelaMs: 12 * HORA });
    expect(juizes().map((c) => c.jobId)).toEqual([turno(3, "c-1", 0).job_id]);
  });

  it("um turno por contato: dois turnos do mesmo contato dariam o mesmo material", async () => {
    const { pool } = poolFalso([turno(1, "c-1", HORA), turno(2, "c-1", 2 * HORA)]);

    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG, janelaMs: 12 * HORA });
    expect(juizes().map((c) => c.jobId)).toEqual([turno(1, "c-1", 0).job_id]);

    chamadas.length = 0;
    // O turno mais velho do mesmo contato não vira julgamento na rodada seguinte.
    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG, janelaMs: 12 * HORA });
    expect(juizes()).toHaveLength(0);
  });

  it("o turno fora da janela não é desenterrado", async () => {
    const { pool } = poolFalso([turno(1, "c-1", HORA), turno(2, "c-2", 30 * HORA)]);

    await runFlywheelOnce(pool, {} as never, { limit: 10, log: LOG, janelaMs: 12 * HORA });
    expect(juizes().map((c) => c.jobId)).toEqual([turno(1, "c-1", 0).job_id]);
  });

  it("o laço agendado passa 2× o intervalo como janela", async () => {
    vi.useFakeTimers();
    try {
      const { pool, consultas } = poolFalso([]);
      const parar = new AbortController();
      const laco = runFlywheelLoop(pool, {} as never, { intervalMs: 6 * HORA, limit: 10, log: LOG }, parar.signal);
      await vi.advanceTimersByTimeAsync(6 * HORA);
      parar.abort();
      await laco;
      expect(consultas).toHaveLength(1);
      expect(consultas[0]!.params[1], "a janela, em segundos").toBe((12 * HORA) / 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
