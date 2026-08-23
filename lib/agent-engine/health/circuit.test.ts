import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { evaluateSession } from './circuit';
import { HEALTH_DEFAULTS } from './defaults';

const RATES_VAZIAS = { totalSends: 0, blockedSends: 0, sentLeads: 0, respondedLeads: 0 };

/**
 * Client falso de UMA transação (begin/select for update/commit) — mesmo padrão de
 * `drain.test.ts` (mock por substring de SQL), adaptado para `harness.connect()` porque
 * `evaluateSession` roda sob `for update` explícito.
 */
function clientFalso(opts: {
  healthRow: {
    health_hold_active: boolean;
    health_released_at: Date | null;
    cooldown_elapsed: boolean;
    has_open_item: boolean;
  };
  phoneNumber: string | null;
  outraSessaoJaLiberada: boolean;
}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'begin' || s === 'commit' || s === 'rollback') return { rows: [] };
    if (s.includes('for update')) return { rows: [opts.healthRow] };
    if (s.includes('select phone_number from channel_sessions')) {
      return { rows: [{ phone_number: opts.phoneNumber }] };
    }
    if (s.includes('ja_liberado')) {
      return { rows: [{ ja_liberado: opts.outraSessaoJaLiberada }] };
    }
    if (s.includes('update channel_session_health')) return { rows: [], rowCount: 1 };
    if (s.includes('insert into agent_inbox_items')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  return { query, release: vi.fn(), chamadas };
}

function harnessFalso(client: ReturnType<typeof clientFalso>): pg.Pool {
  return { connect: vi.fn(async () => client) } as unknown as pg.Pool;
}

describe('evaluateSession — go-live entre sessões do mesmo número', () => {
  it(
    'sessão nova (health_released_at null) do MESMO phone_number de uma sessão já ' +
      'liberada não entra em hold — libera de cara, sem exigir resolução manual de novo',
    async () => {
      const client = clientFalso({
        healthRow: {
          health_hold_active: false,
          health_released_at: null,
          cooldown_elapsed: false,
          has_open_item: false,
        },
        phoneNumber: '553398590909',
        outraSessaoJaLiberada: true,
      });

      const delta = await evaluateSession(
        harnessFalso(client),
        'org-1',
        'sessao-nova',
        RATES_VAZIAS,
        HEALTH_DEFAULTS,
      );

      expect(delta).toEqual({ held: 0, released: 1, alerts: 0 });
      const inseriuInboxItem = client.chamadas.some((c) => c.sql.includes('insert into agent_inbox_items'));
      expect(inseriuInboxItem).toBe(false);
      const liberou = client.chamadas.some(
        (c) => c.sql.includes('update channel_session_health') && c.sql.includes('health_released_at = now()'),
      );
      expect(liberou).toBe(true);
    },
  );

  it('número DE VERDADE novo (nenhuma outra sessão liberada) continua nascendo em hold go_live', async () => {
    const client = clientFalso({
      healthRow: {
        health_hold_active: false,
        health_released_at: null,
        cooldown_elapsed: false,
        has_open_item: false,
      },
      phoneNumber: '553398590909',
      outraSessaoJaLiberada: false,
    });

    const delta = await evaluateSession(
      harnessFalso(client),
      'org-1',
      'sessao-nova',
      RATES_VAZIAS,
      HEALTH_DEFAULTS,
    );

    expect(delta.held).toBe(1);
    expect(delta.released).toBe(0);
    const engajouGoLive = client.chamadas.some(
      (c) => c.sql.includes('health_hold_reason = $3') && c.params[2] === 'go_live',
    );
    expect(engajouGoLive).toBe(true);
  });

  it('phone_number ainda desconhecido (QR não pareado) não casa com nada — hold normal', async () => {
    const client = clientFalso({
      healthRow: {
        health_hold_active: false,
        health_released_at: null,
        cooldown_elapsed: false,
        has_open_item: false,
      },
      phoneNumber: null,
      outraSessaoJaLiberada: true, // não deve nem ser consultado de verdade, mas garante que não vaza
    });

    const delta = await evaluateSession(
      harnessFalso(client),
      'org-1',
      'sessao-nova',
      RATES_VAZIAS,
      HEALTH_DEFAULTS,
    );

    expect(delta.held).toBe(1);
    expect(delta.released).toBe(0);
  });
});
