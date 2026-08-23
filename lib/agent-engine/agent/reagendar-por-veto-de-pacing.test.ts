import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { reagendarTurnoPorVetoDePacing } from './inbound-turn';
import type { Logger } from '../obs/logger';

/**
 * Bug medido em produção (instalação MKT, 2026-08-22): o `send_message` do turno
 * só ENSINAVA o modelo quando o gate `pacing` vetava (warmup_cap/daily_cap/
 * outside_window) — o run fechava "concluído" com 0 mensagens enviadas e NADA
 * reagendava. O cliente ficava sem resposta até mandar outra mensagem por conta
 * própria. `reagendarTurnoPorVetoDePacing` fecha esse buraco reusando o
 * `followup_turn` como "volte e tente de novo".
 */
function logFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function poolFalso(opts: { jaReagendado: boolean; falharNoInsert?: boolean }) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('select 1 from cron_jobs')) {
      return { rows: opts.jaReagendado ? [{ '?column?': 1 }] : [], rowCount: opts.jaReagendado ? 1 : 0 };
    }
    if (s.startsWith('insert into cron_jobs')) {
      if (opts.falharNoInsert) throw new Error('conexão caiu');
      return { rows: [{ id: 'cron-novo' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, chamadas } as unknown as pg.Pool & { chamadas: typeof chamadas };
}

const INPUT = {
  tenantId: 'org-1',
  leadId: 'lead-1',
  jobId: 'job-vetado-1',
  at: new Date('2026-08-23T10:00:00.000Z'),
};

describe('reagendarTurnoPorVetoDePacing', () => {
  it('sem reagendamento prévio: cria followup_turn no instante do veto (nextAllowedAt)', async () => {
    const pool = poolFalso({ jaReagendado: false });
    const log = logFalso();

    await reagendarTurnoPorVetoDePacing(pool, log, INPUT);

    const insert = pool.chamadas.find((c) => c.sql.includes('insert into cron_jobs'));
    expect(insert).toBeDefined();
    // (organization_id, contact_id, kind, interval_ms, cron_expr, tz, job_kind, payload, next_run_at, max_attempts)
    expect(insert?.params[0]).toBe('org-1'); // organization_id
    expect(insert?.params[1]).toBe('lead-1'); // contact_id
    expect(insert?.params[2]).toBe('at'); // kind do cron spec
    expect(insert?.params[6]).toBe('followup_turn'); // job_kind
    expect(insert?.params[7]).toEqual({ reschedule_of: 'job-vetado-1' }); // payload
    expect(insert?.params[8]).toEqual(INPUT.at); // next_run_at (staggerWindowMs 0 = sem deslocamento)
    expect(log.info).toHaveBeenCalled();
  });

  it('já existe followup_turn reagendado para este job — não duplica (idempotência)', async () => {
    const pool = poolFalso({ jaReagendado: true });
    const log = logFalso();

    await reagendarTurnoPorVetoDePacing(pool, log, INPUT);

    expect(pool.chamadas.some((c) => c.sql.includes('insert into cron_jobs'))).toBe(false);
  });

  it('falha no banco não lança — best-effort, turno segue com o erro de ensino que já tinha', async () => {
    const pool = poolFalso({ jaReagendado: false, falharNoInsert: true });
    const log = logFalso();

    await expect(reagendarTurnoPorVetoDePacing(pool, log, INPUT)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
