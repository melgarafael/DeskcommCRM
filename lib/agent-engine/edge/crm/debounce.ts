import type pg from 'pg';
import { enqueueJob, type EnqueueInput, type JobRow } from '../../queue/queue';

/**
 * Coalescência durável: serializa produtores da mesma conversa antes de procurar
 * ou criar seu job. O claim da fila concorre pelo lock da LINHA; nunca alteramos
 * um job running. Mantém o pin original do job; o turno lê as demais mensagens
 * pelo histórico. Não usa memória do processo e não substitui a lane da fila.
 */
export async function enfileirarComDebounce(
  pool: pg.Pool,
  tenantId: string,
  input: EnqueueInput,
  debounceMs: number,
): Promise<{ job: JobRow; deduped: boolean }> {
  if (debounceMs <= 0) return enqueueJob(pool, tenantId, input);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      JSON.stringify(['inbound-debounce', tenantId, input.leadId,
        input.payload?.conversation_id, input.payload?.channel_session_id]),
    ]);
    // Replay do evento que criou o job não abre outro, mesmo após sua conclusão.
    const existing = await client.query<JobRow>(
      'select * from job_queue where organization_id = $1 and source_event_id = $2',
      [tenantId, input.sourceEventId],
    );
    if (existing.rows[0]) {
      await client.query(
        "update event_log set status = 'done', updated_at = now() where organization_id = $1 and id = $2",
        [tenantId, input.sourceEventId],
      );
      await client.query('commit');
      return { job: existing.rows[0], deduped: true };
    }
    const pending = await client.query<JobRow>(
      `select * from job_queue
       where organization_id = $1 and contact_id = $2
         and kind = 'inbound_turn' and status = 'pending'
         and payload->>'conversation_id' = $3
         and payload->>'channel_session_id' = $4
       order by run_after, id limit 1 for update skip locked`,
      [tenantId, input.leadId, input.payload?.conversation_id, input.payload?.channel_session_id],
    );
    let result: { job: JobRow; deduped: boolean };
    if (pending.rows[0]) {
      const updated = await client.query<JobRow>(
        `update job_queue set run_after = greatest(run_after,
           clock_timestamp() + make_interval(secs => $3 / 1000.0))
         where organization_id = $1 and id = $2 and status = 'pending' returning *`,
        [tenantId, pending.rows[0].id, debounceMs],
      );
      result = { job: updated.rows[0]!, deduped: true };
    } else {
      result = await enqueueJob(client, tenantId, {
        ...input, runAfter: new Date(Date.now() + debounceMs),
      });
    }
    // Coalescer e reconhecer o evento no MESMO commit: crash entre as duas
    // operações não pode transformar uma mensagem já absorvida em outro turno.
    await client.query(
      "update event_log set status = 'done', updated_at = now() where organization_id = $1 and id = $2",
      [tenantId, input.sourceEventId],
    );
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
