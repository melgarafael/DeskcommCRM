import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import {
  intervaloEfetivo,
  runAfterComIntervalo,
  TETO_INTERVALO_ENTRE_RESPOSTAS_MS,
  ultimaRespostaDaIa,
} from './intervalo-entre-respostas';

const AGORA = Date.parse('2026-11-03T12:00:00Z');
const em = (ms: number) => new Date(AGORA + ms);

describe('intervaloEfetivo', () => {
  it('ausente, nulo ou inválido = sem intervalo', () => {
    expect(intervaloEfetivo(null)).toBe(0);
    expect(intervaloEfetivo(undefined)).toBe(0);
    expect(intervaloEfetivo(Number.NaN)).toBe(0);
    expect(intervaloEfetivo(-5)).toBe(0);
  });

  it('respeita o valor configurado e clampa no teto de 10 min', () => {
    expect(intervaloEfetivo(30_000)).toBe(30_000);
    expect(intervaloEfetivo(TETO_INTERVALO_ENTRE_RESPOSTAS_MS + 1)).toBe(TETO_INTERVALO_ENTRE_RESPOSTAS_MS);
    expect(intervaloEfetivo(10 ** 9)).toBe(600_000);
  });
});

describe('runAfterComIntervalo', () => {
  it('sem intervalo, nada muda (regressão zero)', () => {
    expect(runAfterComIntervalo(undefined, em(-1_000), 0, AGORA)).toBeUndefined();
    const rajada = em(8_000);
    expect(runAfterComIntervalo(rajada, em(-1_000), 0, AGORA)).toBe(rajada);
  });

  it('a IA nunca respondeu nesta conversa: nada a adiar', () => {
    expect(runAfterComIntervalo(undefined, null, 60_000, AGORA)).toBeUndefined();
  });

  it('o intervalo já passou: nada a adiar', () => {
    expect(runAfterComIntervalo(undefined, em(-61_000), 60_000, AGORA)).toBeUndefined();
    const rajada = em(8_000);
    expect(runAfterComIntervalo(rajada, em(-61_000), 60_000, AGORA)).toBe(rajada);
  });

  it('respondeu há 20 s com intervalo de 60 s: o turno espera 40 s', () => {
    expect(runAfterComIntervalo(undefined, em(-20_000), 60_000, AGORA)?.getTime()).toBe(AGORA + 40_000);
  });

  it('o intervalo vence a rajada menor, mas nunca encurta a rajada maior', () => {
    expect(runAfterComIntervalo(em(8_000), em(-20_000), 60_000, AGORA)?.getTime()).toBe(AGORA + 40_000);
    const rajadaMaior = em(50_000);
    expect(runAfterComIntervalo(rajadaMaior, em(-20_000), 60_000, AGORA)).toBe(rajadaMaior);
  });
});

describe('ultimaRespostaDaIa', () => {
  const poolCom = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows }) }) as unknown as pg.Pool;
  const alvo = { organizationId: 'org-1', conversationId: 'conv-1' };

  it('devolve null quando a IA nunca respondeu', async () => {
    expect(await ultimaRespostaDaIa(poolCom([{ em: null }]), alvo)).toBeNull();
    expect(await ultimaRespostaDaIa(poolCom([]), alvo)).toBeNull();
  });

  it('devolve a data da última resposta e filtra por organização, conversa, IA e não-falha', async () => {
    const pool = poolCom([{ em: '2026-11-03T11:59:00.000Z' }]);
    const r = await ultimaRespostaDaIa(pool, alvo);
    expect(r?.toISOString()).toBe('2026-11-03T11:59:00.000Z');
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1', 'conv-1']);
    expect(sql).toMatch(/organization_id = \$1/);
    expect(sql).toMatch(/sent_via = 'ai'/);
    expect(sql).toMatch(/status <> 'failed'/);
  });
});
