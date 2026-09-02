/**
 * Invariante 3 de `docs/doctrine/restricao-de-canal.md` — "cortesia não é anti-ban".
 *
 * Horário comercial / domingo / fuso existem para NÃO INCOMODAR o cliente: valem em todo
 * canal. Throttle, jitter, warm-up e cap diário existem para NÃO SER BANIDO: só armam onde
 * há risco de ban. Desarmar o segundo grupo não pode levar o primeiro junto — senão a IA
 * passa a acordar cliente às 3h da manhã quando a API oficial entrar.
 */
import { describe, expect, it } from 'vitest';
import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';

const MADRUGADA = new Date('2026-07-28T01:00:00Z'); // 03h em Africa/Maputo (UTC+2) — fora da janela 7h-22h
const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h BRT — terça, dentro da janela

function input(over: { now: Date; banRisk?: boolean; sentToday?: number }) {
  return {
    now: over.now,
    knobs: PACING_DEFAULTS,
    banRisk: over.banRisk,
    state: {
      lastSentAt: null,
      sentToday: over.sentToday ?? 0,
      numberActivatedAt: null, // idade 0 = degrau mais conservador (cap 20)
    },
    crmDailyLimit: null,
    rng: () => 0,
  };
}

describe('cortesia não é anti-ban', () => {
  it('sem risco de ban, o horário comercial CONTINUA armado', () => {
    const d = decidePacing(input({ now: MADRUGADA, banRisk: false }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável'); // estreita o tipo p/ ler .code
    expect(d.code).toBe('outside_window');
  });

  it('sem risco de ban, o cap de warm-up DESARMA', () => {
    const d = decidePacing(input({ now: COMERCIAL, banRisk: false, sentToday: 999 }));
    expect(d.allow).toBe(true);
  });

  it('COM risco de ban, o cap de warm-up continua vetando (comportamento atual)', () => {
    const d = decidePacing(input({ now: COMERCIAL, banRisk: true, sentToday: 999 }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('omitir banRisk preserva o comportamento atual (default = true)', () => {
    const d = decidePacing(input({ now: COMERCIAL, sentToday: 999 }));
    expect(d.allow).toBe(false); // nenhum chamador existente muda de resultado
  });
});
