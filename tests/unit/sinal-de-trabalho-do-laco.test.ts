/**
 * O sinal que corta a soneca do laço do `event_log` quando chega trabalho.
 *
 * O que estes testes protegem, em números: o recuo ocioso do laço chega a 60s,
 * e o teto do turno pela derivação é 120s (`TETO_ESPERA_DERIVACAO_MS`). Um áudio
 * lento — 86s documentados no cabeçalho do `crm/drain.ts` — faz 60+86 > 120, e
 * o cliente ouve "não consegui ouvir seu áudio". Com o corte, o primeiro salto
 * volta a ser o do tick, não o do teto.
 *
 * Relógio falso de verdade (`vi.useFakeTimers`): os `setTimeout` do sinal são os
 * globais, então o avanço é medido em milissegundos de mentira e nenhum caso
 * espera um minuto real. É o mesmo motivo pelo qual o laço da FILA tem o
 * `dormir` injetado (o `node:timers/promises` que o vitest não fakeia).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { criarSinalDeTrabalho } from '@/lib/event-log/sinal-de-trabalho';

const SONECA_LONGA_MS = 60_000;

let sinal = criarSinalDeTrabalho();
let soneca: 'pendente' | 'prazo' | 'trabalho' | 'abortado' = 'pendente';

/** Dispara a soneca e guarda o motivo sem deixar promessa flutuante. */
function dormir(ms: number, signal: AbortSignal): Promise<void> {
  soneca = 'pendente';
  return sinal.dormir(ms, signal).then((motivo) => {
    soneca = motivo;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sinal = criarSinalDeTrabalho();
  soneca = 'pendente';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dormir — o prazo, sem wake', () => {
  it('resolve no prazo e NÃO antes', async () => {
    const abort = new AbortController();
    const espera = dormir(SONECA_LONGA_MS, abort.signal);

    await vi.advanceTimersByTimeAsync(SONECA_LONGA_MS - 1);
    expect(soneca).toBe('pendente');

    await vi.advanceTimersByTimeAsync(1);
    await espera;
    expect(soneca).toBe('prazo');
  });

  it('espera mal calculada (NaN, Infinity, negativa) cai em 0 — não vira laço quente nem timer infinito', async () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const abort = new AbortController();
      const espera = dormir(ms, abort.signal);
      await vi.advanceTimersByTimeAsync(0);
      await espera;
      expect(soneca, `ms=${ms}`).toBe('prazo');
    }
  });
});

describe('acordar — corta a soneca em curso', () => {
  it('corta 60s de soneca no instante do acordar, não no teto do recuo', async () => {
    const abort = new AbortController();
    const espera = dormir(SONECA_LONGA_MS, abort.signal);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(soneca).toBe('pendente');

    sinal.acordar();
    await vi.advanceTimersByTimeAsync(0);
    await espera;

    // O número que importa: 1s de soneca, não 60s. Antes deste sinal o laço
    // dormia o teto inteiro e o evento novo só era visto no fim dele.
    expect(soneca).toBe('trabalho');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('acordar sem ninguém dormindo é CONSUMIDO pela soneca seguinte, e só uma vez', async () => {
    // O laço estava dentro do tick quando o trabalho chegou: o pedido não pode
    // se perder (o tick já tinha consultado o banco) nem ficar pendente para
    // sempre (senão toda soneca futura nasceria cortada e o recuo deixaria de
    // existir).
    sinal.acordar();

    const abort1 = new AbortController();
    const primeira = dormir(SONECA_LONGA_MS, abort1.signal);
    await vi.advanceTimersByTimeAsync(0);
    await primeira;
    expect(soneca).toBe('trabalho');
    expect(vi.getTimerCount()).toBe(0);

    // O tick pagou o pedido; a soneca seguinte volta a dormir o prazo inteiro.
    sinal.inicioDoTick();
    const abort2 = new AbortController();
    const segunda = dormir(SONECA_LONGA_MS, abort2.signal);
    await vi.advanceTimersByTimeAsync(SONECA_LONGA_MS - 1);
    expect(soneca).toBe('pendente');
    await vi.advanceTimersByTimeAsync(1);
    await segunda;
    expect(soneca).toBe('prazo');
  });

  it('dois acordes seguidos valem UMA soneca cortada — o sinal não acumula', async () => {
    const abort = new AbortController();
    const espera = dormir(SONECA_LONGA_MS, abort.signal);
    await vi.advanceTimersByTimeAsync(1_000);

    sinal.acordar();
    sinal.acordar();
    await vi.advanceTimersByTimeAsync(0);
    await espera;
    expect(soneca).toBe('trabalho');

    // O segundo acordar foi absorvido: em vez de cortar a soneca de novo, o
    // próximo tick (inicioDoTick) devolve o ritmo normal.
    sinal.inicioDoTick();
    const proxima = dormir(SONECA_LONGA_MS, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(soneca, 'a segunda soneca foi cortada por um acordar já pago').toBe('pendente');
    await vi.advanceTimersByTimeAsync(SONECA_LONGA_MS - 1_000);
    await proxima;
    expect(soneca).toBe('prazo');
  });

  it('dez acordes durante a mesma soneca continuam sendo UMA', async () => {
    const abort = new AbortController();
    const espera = dormir(SONECA_LONGA_MS, abort.signal);
    await vi.advanceTimersByTimeAsync(500);

    for (let i = 0; i < 10; i += 1) sinal.acordar();
    await vi.advanceTimersByTimeAsync(0);
    await espera;
    expect(soneca).toBe('trabalho');

    sinal.inicioDoTick();
    const seguinte = new AbortController();
    const proxima = dormir(SONECA_LONGA_MS, seguinte.signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(soneca).toBe('pendente');

    seguinte.abort();
    await proxima;
    expect(soneca).toBe('abortado');
  });
});

describe('abortar — o desligamento não pode ser engolido', () => {
  it('abortar corta a soneca na hora e resolve "abortado" (nunca rejeita)', async () => {
    const abort = new AbortController();
    const espera = dormir(SONECA_LONGA_MS, abort.signal);

    await vi.advanceTimersByTimeAsync(1_000);
    abort.abort();
    await espera;

    expect(soneca).toBe('abortado');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sinal já abortado não agenda timer nenhum', async () => {
    const abort = new AbortController();
    abort.abort();

    await sinal.dormir(SONECA_LONGA_MS, abort.signal);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('acordar NÃO deixa listener de abort pendurado — um laço de dias não pode vazar', async () => {
    const abort = new AbortController();
    const remover = vi.spyOn(abort.signal, 'removeEventListener');
    const espera = dormir(SONECA_LONGA_MS, abort.signal);
    await vi.advanceTimersByTimeAsync(1);

    sinal.acordar();
    await vi.advanceTimersByTimeAsync(0);
    await espera;

    expect(remover).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
