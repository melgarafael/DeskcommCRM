/**
 * O laço que roda os handlers do event_log dentro do worker.
 *
 * O que estes testes protegem, e por quê (medido em VPS, 2026-08-25): os
 * handlers só rodavam pelo cron `event-log-drain`, 1×/min. A cadeia
 * persist→derive de um áudio levava 103-188s — dois saltos de cron — enquanto o
 * drain do turno espera 45s pela transcrição e então responde sem ela. O agente
 * dizia "não consigo ouvir áudio" com o texto chegando ao banco meio minuto
 * depois. A transcrição em si levava 3,9s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/lib/agent-engine/obs/logger';
import type { DrainSummary } from '@/lib/event-log/drain';
import {
  _reiniciarSinalDeTrabalho,
  acordarLacoDeEventLog,
  criarSinalDeTrabalho,
} from '@/lib/event-log/sinal-de-trabalho';

const drainEventLog = vi.fn();
const ensureHandlersRegistered = vi.fn();
const createAdminClient = vi.fn(() => ({ marcador: 'admin' }));

vi.mock('@/lib/event-log/drain', () => ({ drainEventLog }));
vi.mock('@/lib/event-log/register-handlers', () => ({ ensureHandlersRegistered }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));

const {
  _reiniciarProntidaoDoLaco,
  esperaOciosa,
  prontidaoDoLacoDeEventLog,
  proximaEspera,
  proximaRodadaOciosa,
  rodadasAteOTeto,
  runEventLogDrainLoop,
} = await import('@/lib/event-log/drain-loop');

const knobs = {
  intervalMs: 2_000,
  idleIntervalMs: 10_000,
  idleMaxMs: 60_000,
  staleSweepMs: 60_000,
  batchSize: 50,
};
const vazio: DrainSummary = { scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 };
// O dublê mantém o tipo do MOCK (`log.warn` é um `vi.fn()` que as asserções
// interrogam); o cast para `Logger` fica no ponto em que ele CRUZA a fronteira
// da função. `as never` apagava o objeto inteiro e derrubava o typecheck do
// CI, que roda `-p tsconfig.typecheck.json` e inclui `tests/`.
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const logger = log as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  createAdminClient.mockReturnValue({ marcador: 'admin' });
  _reiniciarProntidaoDoLaco();
  _reiniciarSinalDeTrabalho();
});

describe('proximaEspera — a regra de ritmo', () => {
  it('tick que processou alguma linha mantém o laço rápido', () => {
    for (const campo of ['done', 'retried', 'failed', 'dead'] as const) {
      expect(proximaEspera({ ...vazio, scanned: 1, [campo]: 1 }, knobs)).toBe(knobs.intervalMs);
    }
  });

  it('tick ocioso recua para a espera longa', () => {
    expect(proximaEspera(vazio, knobs)).toBe(knobs.idleIntervalMs);
  });

  it('linha varrida mas NÃO processada conta como ocioso', () => {
    // É o caso de concorrência com o cron: o claim otimista de drainEventLog
    // devolve `scanned` alto e zero processado quando a outra instância chegou
    // antes. Contar isso como trabalho faria o laço girar rápido à toa toda vez
    // que o cron passasse.
    expect(proximaEspera({ ...vazio, scanned: 50 }, knobs)).toBe(knobs.idleIntervalMs);
  });

  it('dez rodadas ociosas recuam 10 → 20 → 40 → 60 e travam no teto', () => {
    // Antes: 10s PARA SEMPRE. A instalação parada batia no PostgREST 17,4×/min
    // (medido pelo @DPalmercs) e 2.084 de 2.084 respostas vinham vazias.
    const esperas = Array.from({ length: 10 }, (_, rodadas) => proximaEspera(vazio, knobs, rodadas));

    expect(esperas).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    // O teto é o que impede o recuo de virar "acorda amanhã": sem ele, a décima
    // rodada ociosa esperaria 10s × 2⁹ ≈ 85 min.
    expect(Math.max(...esperas)).toBe(knobs.idleMaxMs);
  });

  it('tick que MEXEU em linha volta a 2s na rodada seguinte', () => {
    // O contador mora no laço; a regra é pura. Depois de seis rodadas ociosas,
    // um tick com trabalho zera o contador E a espera cai para o piso na hora —
    // um evento novo não paga o recuo acumulado.
    const feitos: DrainSummary = { ...vazio, done: 1 };

    expect(proximaRodadaOciosa(feitos, 6)).toBe(0);
    expect(proximaEspera(feitos, knobs, 6)).toBe(knobs.intervalMs);
    // E a rodada seguinte, se ociosa de novo, recomeça do piso (10s), não de 60s.
    expect(esperaOciosa(knobs, proximaRodadaOciosa(feitos, 6))).toBe(knobs.idleIntervalMs);
  });

  it('`scanned` sozinho NÃO tira o laço do ocioso — o contador continua subindo', () => {
    const varridas: DrainSummary = { ...vazio, scanned: 50 };

    expect(proximaRodadaOciosa(varridas, 1)).toBe(2);
    expect(proximaEspera(varridas, knobs, 1)).toBe(20_000);
  });

  it('contador absurdo não vira Infinity nem NaN', () => {
    // O clamp do expoente existe para isto: um contador que estoure (bug de
    // contagem, `Infinity`, `NaN`) não pode transformar a espera do laço num
    // `setTimeout(Infinity)` — que o Node trata como 1ms e vira laço quente — nem
    // num NaN.
    for (const rodadas of [Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, Number.NaN, -5]) {
      const espera = proximaEspera(vazio, knobs, rodadas);
      expect(Number.isFinite(espera), `rodadas=${rodadas} produziu espera não finita`).toBe(true);
      expect(espera).toBeGreaterThanOrEqual(knobs.idleIntervalMs);
      expect(espera).toBeLessThanOrEqual(knobs.idleMaxMs);
    }
    // E o arredondamento não deixa passar fração de rodada.
    expect(proximaEspera(vazio, knobs, 2.7)).toBe(40_000);
  });

  it('o teto do recuo nunca fica abaixo do piso, mesmo mal configurado', () => {
    // Teto menor que o piso não pode tornar o ocioso MAIS rápido que hoje —
    // configuração errada paga o ritmo antigo, não um laço girando mais.
    const torto = { ...knobs, idleMaxMs: 1_000 };
    expect(proximaEspera(vazio, torto, 0)).toBe(knobs.idleIntervalMs);
    expect(proximaEspera(vazio, torto, 5)).toBe(knobs.idleIntervalMs);
    expect(rodadasAteOTeto(torto)).toBe(0);
  });
});

describe('runEventLogDrainLoop', () => {
  it('drena com o batchSize dos knobs e para quando abortado', async () => {
    const abort = new AbortController();
    drainEventLog.mockImplementation(() => {
      abort.abort();
      return Promise.resolve({ ...vazio, done: 1 });
    });

    await runEventLogDrainLoop({ ...knobs, intervalMs: 0, idleIntervalMs: 0 }, logger, abort.signal);

    expect(ensureHandlersRegistered).toHaveBeenCalledOnce();
    // O primeiro tick SEMPRE varre `processing` preso: o worker que acabou de
    // subir não pode esperar um minuto para recolher o evento da queda anterior.
    expect(drainEventLog).toHaveBeenCalledWith({ marcador: 'admin' }, { limit: 50, varrerPresos: true });
  });

  it('varre `processing` preso no primeiro tick e no teto, não a cada tick (#3693)', async () => {
    // A varredura procura linhas de 10 min atrás; repetir a consulta a cada 2s
    // era tráfego puro (17,4 req/min medidos pelo @DPalmercs, 100% vazias).
    //
    // Piso 5ms e teto 40ms → o recuo bate no teto na 3ª rodada ociosa, e o
    // horizonte de varredura é de 1h, então só o teto pode disparar de novo.
    // Assim o caso mede a cadência sem esperar um minuto de verdade.
    const abort = new AbortController();
    const varreduras: Array<boolean | undefined> = [];
    drainEventLog.mockImplementation((_admin: unknown, opts: { varrerPresos?: boolean }) => {
      varreduras.push(opts.varrerPresos);
      if (varreduras.length >= 5) abort.abort();
      return Promise.resolve({ ...vazio, scanned: 3 });
    });

    const recuoRapido = {
      ...knobs,
      intervalMs: 0,
      idleIntervalMs: 5,
      idleMaxMs: 40,
      staleSweepMs: 3_600_000,
    };
    expect(rodadasAteOTeto(recuoRapido)).toBe(3);

    await runEventLogDrainLoop(recuoRapido, logger, abort.signal);

    expect(varreduras).toEqual([true, false, false, true, true]);
  });

  it('admin client indisponível DESLIGA o laço sem derrubar o worker', async () => {
    // `@/lib/supabase/admin` importa `@/lib/env`, que faz throw no topo do
    // módulo quando falta variável obrigatória. Num `.env` enxuto, um import
    // estático mataria o worker INTEIRO — fila durável, cron e turnos — por
    // causa de um laço acessório. Ele tem que se desligar sozinho e avisar.
    //
    // `error`, e não o `warn` de antes: era o `warn` que fazia o laço desligado
    // parecer ruído — a #648 ficou dez dias assim, com o `/healthz` verde
    // (#604). A prontidão publicada é o que transforma isso em sinal visível.
    createAdminClient.mockImplementation(() => {
      throw new Error('env inválido — verifique no .env: INTERNAL_SECRET');
    });
    const abort = new AbortController();

    await expect(
      runEventLogDrainLoop(knobs, logger, abort.signal),
    ).resolves.toBeUndefined();

    expect(drainEventLog).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledOnce();
    expect(prontidaoDoLacoDeEventLog()).toEqual({
      carregado: false,
      motivo: expect.stringContaining('INTERNAL_SECRET'),
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('erro num tick não interrompe o laço nem acelera as tentativas', async () => {
    const abort = new AbortController();
    let ticks = 0;
    drainEventLog.mockImplementation(() => {
      ticks += 1;
      if (ticks >= 3) abort.abort();
      return Promise.reject(new Error('banco fora do ar'));
    });

    await runEventLogDrainLoop({ ...knobs, intervalMs: 0, idleIntervalMs: 0 }, logger, abort.signal);

    expect(ticks).toBe(3);
    expect(log.error).toHaveBeenCalledTimes(3);
  });
});

/**
 * O WAKE — a soneca do recuo sai antes quando a mídia está pendente (#3701).
 *
 * O defeito medido pelo @DPalmercs: o recuo vai a 60s, e o caminho da PRIMEIRA
 * resposta a um áudio passa pelo `event_log` (persist → derive → Whisper). Com
 * a instalação parada, o primeiro salto custava até 60s; um áudio lento (86s)
 * fazia 60+86 passar do teto de 120s do turno e a resposta voltava a ser "não
 * consegui ouvir seu áudio". O `crm/drain.ts` adia o turno nesse instante e é
 * ele quem acorda o laço — os dois rodam no mesmo processo.
 *
 * Relógio falso de verdade: os 60s destes casos são de mentira, e o número que
 * as asserções medem é QUANTOS TICKS o laço deu, não quanto tempo passou.
 */
describe('wake — a mídia pendente corta a soneca (#3701)', () => {
  // Piso = teto = 60s: o recuo ocioso fica no teto desde a primeira rodada, que
  // é o pior caso de quem não tem atendimento (noite, fim de semana).
  const sonecaLonga = {
    ...knobs,
    intervalMs: 0,
    idleIntervalMs: 60_000,
    idleMaxMs: 60_000,
    staleSweepMs: 3_600_000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('o laço dormindo 60s acorda no meio da soneca: o tick seguinte chega na hora', async () => {
    const abort = new AbortController();
    const sinal = criarSinalDeTrabalho();
    let ticks = 0;
    drainEventLog.mockImplementation(() => {
      ticks += 1;
      return Promise.resolve({ ...vazio, scanned: 1 });
    });

    const laco = runEventLogDrainLoop(sonecaLonga, logger, abort.signal, { sinal });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);
    // Metade da soneca (30 dos 60s): nenhum tick novo. É o comportamento certo
    // quando não há trabalho — e o que o wake tem de vencer.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toBe(1);

    // É o que `crm/drain.ts` faz ao adiar o turno por mídia pendente.
    sinal.acordar();
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks, 'o wake não cortou a soneca: o laço esperou o teto do recuo').toBe(2);

    abort.abort();
    await laco;
  });

  it('o wake chega DENTRO do tick (a linha nasceu depois da consulta) e não se perde', async () => {
    // O caso fino: o `drainEventLog` já leu o banco quando a mídia pendente
    // apareceu. Perder este acordar custaria os 60s inteiros — é exatamente o
    // que o pedido "não deixe pendente para sempre, mas não perca" protege.
    const abort = new AbortController();
    const sinal = criarSinalDeTrabalho();
    let ticks = 0;
    drainEventLog.mockImplementation(() => {
      ticks += 1;
      if (ticks === 1) sinal.acordar();
      return Promise.resolve({ ...vazio, scanned: 1 });
    });

    const laco = runEventLogDrainLoop(sonecaLonga, logger, abort.signal, { sinal });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks, 'a soneca seguinte saiu antes do prazo, como devia').toBe(2);

    // E o pedido foi CONSUMIDO: a soneca seguinte dorme o prazo inteiro.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ticks).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toBe(3);

    abort.abort();
    await laco;
  });

  it('dois acordes seguidos valem UM tick extra — o sinal não acumula', async () => {
    const abort = new AbortController();
    const sinal = criarSinalDeTrabalho();
    let ticks = 0;
    drainEventLog.mockImplementation(() => {
      ticks += 1;
      return Promise.resolve({ ...vazio, scanned: 1 });
    });

    const laco = runEventLogDrainLoop(sonecaLonga, logger, abort.signal, { sinal });
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);

    sinal.acordar();
    sinal.acordar();
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(2);

    // Nenhum terceiro tick de graça: o segundo acordar foi absorvido.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toBe(2);

    abort.abort();
    await laco;
  });

  it('acordarLacoDeEventLog() — o caminho de produção — corta a MESMA soneca', async () => {
    // Sem sinal injetado: o laço usa o de produção, que é o que o
    // `crm/drain.ts` acorda por `import`. Se este caso passar, o fio entre os
    // dois laços do worker existe de verdade.
    const abort = new AbortController();
    drainEventLog.mockResolvedValue({ ...vazio, scanned: 1 });

    const laco = runEventLogDrainLoop(sonecaLonga, logger, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(drainEventLog).toHaveBeenCalledTimes(1);

    acordarLacoDeEventLog();
    await vi.advanceTimersByTimeAsync(0);
    expect(drainEventLog).toHaveBeenCalledTimes(2);

    abort.abort();
    await laco;
  });

  it('shutdown: abortar tira o laço da soneca de 60s na hora, com ou sem wake pendente', async () => {
    for (const comWake of [false, true]) {
      vi.clearAllMocks();
      const abort = new AbortController();
      const sinal = criarSinalDeTrabalho();
      drainEventLog.mockResolvedValue({ ...vazio, scanned: 1 });

      const laco = runEventLogDrainLoop(sonecaLonga, logger, abort.signal, { sinal });
      await vi.advanceTimersByTimeAsync(10_000);
      if (comWake) sinal.acordar();
      abort.abort();

      // Zero milissegundos de relógio falso: o desligamento não espera timer.
      await vi.advanceTimersByTimeAsync(0);
      await expect(laco, `comWake=${comWake}`).resolves.toBeUndefined();
      expect(vi.getTimerCount(), `comWake=${comWake}: timer pendurado`).toBe(0);
    }
  });
});
