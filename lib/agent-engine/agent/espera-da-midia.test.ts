/**
 * A espera pela mídia que chega no meio do turno (#3836) — a MECÂNICA.
 *
 * O caso do relato (texto dispara, dois áudios chegam depois, transcrição fica
 * pronta) é medido ponta a ponta em
 * `turno-espera-a-midia-do-meio-do-turno.test.ts`, com o turno real. Aqui se
 * mede o que aquele arquivo não vê, porque lá a espera é instantânea: o TETO.
 *
 * Três desfechos, todos NOMEADOS no retorno e no log — nunca um silêncio que
 * deixa a resposta sair antes de a derivação a caminho terminar:
 *
 *  - nada pendente → nenhuma consulta a mais;
 *  - derivou → segue, com o texto;
 *  - estourou o teto (prazo do turno ou idade da mídia) → segue SEM o texto, e
 *    o registro diz que foi isso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acordarLacoDeEventLog } = vi.hoisted(() => ({ acordarLacoDeEventLog: vi.fn() }));
vi.mock("@/lib/event-log/sinal-de-trabalho", () => ({ acordarLacoDeEventLog }));

import {
  INTERVALO_DA_ESPERA_MS,
  esperarMidiaDerivavel,
  type ResultadoDaEsperaDaMidia,
} from "@/lib/agent-engine/agent/espera-da-midia";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

function logFalso() {
  const info = vi.fn();
  const warn = vi.fn();
  return {
    info,
    warn,
    error: vi.fn(),
    frases: () => [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])),
    campos: () => [...info.mock.calls, ...warn.mock.calls].map((c) => c[1] as Record<string, unknown>),
  };
}

/**
 * Pool que responde à consulta da mídia derivável com a FILA de estados dada:
 * cada consulta consome um item; acabada a fila, repete o último.
 */
function poolEmFila(estados: ({ tipo: string; quando: string } | null)[]) {
  let i = 0;
  const query = vi.fn(async () => {
    const estado = estados[Math.min(i, estados.length - 1)] ?? null;
    i += 1;
    if (estado === null) return { rows: [] };
    return {
      rows: [{ type: estado.tipo, media_derived_status: "pending", quando: estado.quando }],
    };
  });
  return { pool: { query } as never, consultas: () => query.mock.calls.length };
}

/** Monta um resultado esperado sem repetir os três campos em cada asserção. */
const desfecho = (r: ResultadoDaEsperaDaMidia): string => r.desfecho;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("esperarMidiaDerivavel", () => {
  it("sem mídia pendente: devolve na hora, sem dormir e sem acordar o laço", async () => {
    const { pool, consultas } = poolEmFila([null]);
    const dormir = vi.fn(async () => {});
    const log = logFalso();

    const r = await esperarMidiaDerivavel(pool, {
      organizationId: ORG,
      conversationId: CONVERSA,
      prazoMs: Date.now() + 60_000,
      log,
      sleep: dormir,
    });

    expect(desfecho(r)).toBe("sem_midia_pendente");
    expect(consultas()).toBe(1);
    expect(dormir).not.toHaveBeenCalled();
    expect(acordarLacoDeEventLog).not.toHaveBeenCalled();
  });

  it("mídia que deriva durante a espera: segue com 'derivacao_concluida' e acorda quem deriva", async () => {
    const agora = new Date().toISOString();
    const { pool, consultas } = poolEmFila([
      { tipo: "audio", quando: agora },
      { tipo: "audio", quando: agora },
      null,
    ]);
    const dormidos: number[] = [];
    const dormir = vi.fn(async (ms: number) => {
      dormidos.push(ms);
    });
    const log = logFalso();

    const r = await esperarMidiaDerivavel(pool, {
      organizationId: ORG,
      conversationId: CONVERSA,
      prazoMs: Date.now() + 60_000,
      log,
      sleep: dormir,
    });

    expect(desfecho(r)).toBe("derivacao_concluida");
    expect(r.tipo).toBe("audio");
    expect(r.recheques).toBe(2);
    expect(consultas()).toBe(3);
    expect(dormidos).toEqual([INTERVALO_DA_ESPERA_MS, INTERVALO_DA_ESPERA_MS]);
    // Uma vez por recheque: é o sinal que faz o laço da derivação sair da
    // soneca — sem ele a espera pagaria o recuo inteiro antes de começar.
    expect(acordarLacoDeEventLog).toHaveBeenCalledTimes(2);
  });

  it("prazo do turno estourado: para no orçamento e NOMEIA o desfecho", async () => {
    const agora = new Date().toISOString();
    const { pool } = poolEmFila([{ tipo: "audio", quando: agora }]);
    let relogio = 1_000_000;
    const dormidos: number[] = [];
    const dormir = vi.fn(async (ms: number) => {
      dormidos.push(ms);
      relogio += ms;
    });
    const log = logFalso();

    const r = await esperarMidiaDerivavel(pool, {
      organizationId: ORG,
      conversationId: CONVERSA,
      prazoMs: relogio + 3_000,
      intervaloMs: 1_000,
      agoraMs: () => relogio,
      log,
      sleep: dormir,
    });

    expect(desfecho(r)).toBe("teto_da_espera");
    // NÃO passa do orçamento do turno: três esperas de 1s e encerra.
    expect(dormidos).toEqual([1_000, 1_000, 1_000]);
    expect(r.esperou_ms).toBe(3_000);
    expect(log.campos().some((c) => c?.["desfecho"] === "teto_da_espera")).toBe(true);
    expect(log.frases().some((f) => f.includes("teto da espera"))).toBe(true);
  });

  it("mídia travada há mais que o teto: não segura o turno por um problema que não é dele", async () => {
    const velha = new Date(Date.now() - 10 * 60_000).toISOString();
    const { pool } = poolEmFila([{ tipo: "image", quando: velha }]);
    const dormir = vi.fn(async () => {});
    const log = logFalso();

    const r = await esperarMidiaDerivavel(pool, {
      organizationId: ORG,
      conversationId: CONVERSA,
      prazoMs: Date.now() + 60_000,
      log,
      sleep: dormir,
    });

    expect(desfecho(r)).toBe("teto_da_espera");
    expect(r.tipo).toBe("image");
    expect(dormir).not.toHaveBeenCalled();
    expect(log.frases().some((f) => f.includes("teto da espera"))).toBe(true);
  });

  it("relógio parado não vira laço infinito: o número de recheques também limita", async () => {
    const agora = new Date().toISOString();
    const { pool, consultas } = poolEmFila([{ tipo: "audio", quando: agora }]);
    const log = logFalso();

    const r = await esperarMidiaDerivavel(pool, {
      organizationId: ORG,
      conversationId: CONVERSA,
      prazoMs: Number.MAX_SAFE_INTEGER,
      intervaloMs: 1_000,
      // Relógio congelado: só a guarda de recheques encerra.
      agoraMs: () => 1_000_000,
      log,
      sleep: async () => {},
    });

    expect(desfecho(r)).toBe("teto_da_espera");
    expect(r.recheques).toBeLessThanOrEqual(121);
    expect(consultas()).toBeLessThanOrEqual(122);
  });
});
