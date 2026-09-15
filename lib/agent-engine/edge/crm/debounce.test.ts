// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { EnqueueInput, JobRow } from '../../queue/queue';
import { enfileirarComDebounce } from './debounce';

/** Simula apenas o contrato SQL. Locks/isolamento reais exigem test:db no CI. */
function bancoFalso() {
  const jobs: JobRow[] = [];
  const feitos = new Set<string>();
  const locks = new Map<string, Promise<void>>();
  const calls: string[] = [];
  let failAck = false;
  const connect = vi.fn(async () => {
    let unlock: (() => void) | undefined;
    let snapshot: JobRow[] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) {
        const key = String(values[0]);
        const anterior = locks.get(key) ?? Promise.resolve();
        locks.set(key, new Promise<void>((resolve) => { unlock = resolve; }));
        await anterior;
        snapshot = structuredClone(jobs);
      }
      if (sql.includes('source_event_id = $2'))
        return { rows: jobs.filter(j => j.organization_id === values[0] && j.source_event_id === values[1]) };
      if (sql.includes('for update skip locked'))
        return { rows: jobs.filter(j => j.organization_id === values[0] && j.contact_id === values[1] &&
          j.status === 'pending' && j.kind === 'inbound_turn' &&
          j.payload.conversation_id === values[2] && j.payload.channel_session_id === values[3]).slice(0, 1) };
      if (sql.includes('insert into job_queue')) {
        const job = {
          id: `j${jobs.length + 1}`, organization_id: values[0], contact_id: values[1],
          kind: values[2], source_event_id: values[3], payload: values[4],
          run_after: values[6] ?? new Date(), status: 'pending',
        } as JobRow;
        jobs.push(job);
        return { rows: [job] };
      }
      if (sql.includes('update job_queue')) {
        const job = jobs.find(j => j.organization_id === values[0] && j.id === values[1])!;
        job.run_after = new Date(Math.max(+job.run_after, Date.now() + Number(values[2])));
        return { rows: [job] };
      }
      if (sql.includes('update event_log')) {
        if (failAck) throw new Error('ack indisponível');
        feitos.add(String(values[1]));
      }
      if (sql === 'rollback') jobs.splice(0, jobs.length, ...snapshot);
      if (sql === 'commit' || sql === 'rollback') unlock?.();
      return { rows: [] };
    });
    return { query, release: vi.fn() };
  });
  return { pool: { connect } as unknown as pg.Pool, jobs, feitos, calls,
    falharAck: () => { failAck = true; } };
}

function entrada(evento: string, contato = 'a', conversa = contato, canal = 'canal'): EnqueueInput {
  return { kind: 'inbound_turn', leadId: contato, sourceEventId: evento,
    payload: { conversation_id: conversa, channel_session_id: canal,
      inbound_message_id: `m-${evento}`, crm_event_id: evento } };
}

afterEach(() => vi.useRealTimers());
describe('debounce de 4 segundos', () => {
  it('1 mensagem: um job com vencimento em 4s e evento reconhecido', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const db = bancoFalso();
    await enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000);
    expect(db.jobs).toHaveLength(1);
    expect(+db.jobs[0]!.run_after).toBe(4000);
    expect(db.feitos.has('e1')).toBe(true);
    expect(db.calls.indexOf('commit')).toBeGreaterThan(db.calls.findIndex(s => s.includes('update event_log')));
  });

  it('2 mensagens rápidas: renova a janela sem criar segundo job ou trocar o pin', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const db = bancoFalso();
    await enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000);
    vi.setSystemTime(1000);
    await enfileirarComDebounce(db.pool, 'org', entrada('e2'), 4000);
    expect(db.jobs).toHaveLength(1);
    expect(+db.jobs[0]!.run_after).toBe(5000);
    expect(db.jobs[0]!.payload.inbound_message_id).toBe('m-e1');
    expect([...db.feitos]).toEqual(['e1', 'e2']);
  });

  it('rajada atravessa a janela inicial: espera silêncio, um job para todas', async () => {
    vi.useFakeTimers();
    const db = bancoFalso();
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 1000);
      await enfileirarComDebounce(db.pool, 'org', entrada(`e${i}`), 4000);
    }
    expect(db.jobs).toHaveLength(1);
    expect(+db.jobs[0]!.run_after).toBe(13000);
    expect(db.feitos.size).toBe(10);
  });

  it('2 contatos simultâneos: um job independente para cada contato', async () => {
    const db = bancoFalso();
    await Promise.all(['a', 'b'].flatMap(c => [1, 2].map(n =>
      enfileirarComDebounce(db.pool, 'org', entrada(`${c}${n}`, c), 4000))));
    expect(db.jobs.map(j => j.contact_id).sort()).toEqual(['a', 'b']);
    expect(db.feitos.size).toBe(4);
  });

  it('dois produtores da mesma conversa serializam procurar + inserir', async () => {
    const db = bancoFalso();
    await Promise.all([1, 2, 3].map(n => enfileirarComDebounce(db.pool, 'org', entrada(`e${n}`), 4000)));
    expect(db.jobs).toHaveLength(1);
  });

  it('replay do evento original após done devolve o mesmo job', async () => {
    const db = bancoFalso();
    await enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000);
    db.jobs[0]!.status = 'done';
    const result = await enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000);
    expect(result.deduped).toBe(true);
    expect(db.jobs).toHaveLength(1);
  });

  it('running não absorve nova mensagem: cria sucessor na mesma lane', async () => {
    const db = bancoFalso();
    await enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000);
    db.jobs[0]!.status = 'running';
    await enfileirarComDebounce(db.pool, 'org', entrada('e2'), 4000);
    expect(db.jobs.map(j => j.status)).toEqual(['running', 'pending']);
  });

  it('não mistura organizações, conversas ou canais', async () => {
    const db = bancoFalso();
    await enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000);
    await enfileirarComDebounce(db.pool, 'org2', entrada('e2'), 4000);
    await enfileirarComDebounce(db.pool, 'org', entrada('e3', 'a', 'outra'), 4000);
    await enfileirarComDebounce(db.pool, 'org', entrada('e4', 'a', 'a', 'outro'), 4000);
    expect(db.jobs).toHaveLength(4);
  });

  it('falha ao reconhecer evento desfaz o job: retry não perde a mensagem', async () => {
    const db = bancoFalso(); db.falharAck();
    await expect(enfileirarComDebounce(db.pool, 'org', entrada('e1'), 4000)).rejects.toThrow('ack indisponível');
    expect(db.jobs).toHaveLength(0);
    expect(db.calls.at(-1)).toBe('rollback');
  });
});
