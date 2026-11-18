/**
 * O teto do dia (warm-up e `daily_message_limit`) mede quantas pessoas o número
 * ABORDA. Resposta a quem escreveu não é barrada por ele — medido em produção:
 * número com 20/20 no 4º dia de warm-up segurou até o dia seguinte a resposta a
 * dois leads que tinham acabado de escrever (migration 9061).
 */
import { describe, expect, it } from 'vitest';
import { decidePacing } from '@/lib/agent-engine/pacing/engine';
import { PACING_DEFAULTS } from '@/lib/agent-engine/pacing/defaults';

const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h BRT, terça
const MADRUGADA = new Date('2026-07-28T06:00:00Z'); // 03h BRT

function input(over: {
  now?: Date;
  resposta?: boolean;
  sentToday?: number;
  lastSentAt?: Date | null;
  crmDailyLimit?: number | null;
}) {
  return {
    now: over.now ?? COMERCIAL,
    knobs: PACING_DEFAULTS,
    resposta: over.resposta,
    state: {
      lastSentAt: over.lastSentAt ?? null,
      sentToday: over.sentToday ?? 0,
      numberActivatedAt: null, // idade 0: cap de warm-up 20
    },
    crmDailyLimit: over.crmDailyLimit ?? null,
    rng: () => 0,
  };
}

describe('resposta não é barrada pelo teto do dia', () => {
  it('disparo com o warm-up batido continua vetado', () => {
    const d = decidePacing(input({ sentToday: 20 }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('resposta com o warm-up batido sai', () => {
    expect(decidePacing(input({ sentToday: 20, resposta: true })).allow).toBe(true);
  });

  it('resposta com o limite do CRM batido sai', () => {
    const d = decidePacing(input({ sentToday: 999, crmDailyLimit: 10, resposta: true }));
    expect(d.allow).toBe(true);
  });

  it('resposta continua respeitando o espaçamento entre mensagens', () => {
    const d = decidePacing(
      input({ sentToday: 20, resposta: true, lastSentAt: new Date(COMERCIAL.getTime() - 200) }),
    );
    expect(d).toEqual({ allow: true, waitMs: PACING_DEFAULTS.throttleMs - 200 });
  });

  it('prospecção prevalece: abordagem fria nunca abre o teto, mesmo declarando resposta', () => {
    const d = decidePacing({ ...input({ sentToday: 20, resposta: true }), prospeccao: true });
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('warmup_cap');
  });

  it('resposta continua respeitando a janela de resposta', () => {
    const d = decidePacing(input({ now: MADRUGADA, resposta: true }));
    expect(d.allow).toBe(false);
    if (d.allow) throw new Error('inalcançável');
    expect(d.code).toBe('outside_window');
  });
});
