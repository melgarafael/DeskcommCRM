import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { connectEventsDatabase } from './connection.mjs';

// Reclamar trabalho local é seguro: efeito e conclusão compartilham transação.
// `sending`/`uncertain` ficam fora da recuperação automática, mesmo com lease vencido.
export async function claim(client, eventId, destination, leaseMs = 200) {
  const result = await client.query(`
    with candidate as (
      select id from receipts where event_id=$1 and destination=$2
      and (state='pending' or (state='processing' and lease_until < clock_timestamp()))
      order by id for update skip locked limit 1
    ) update receipts r set state='processing', attempts=attempts+1,
      lease_token=gen_random_uuid(), lease_until=clock_timestamp()+$3*interval '1 millisecond'
    from candidate c where r.id=c.id returning r.*`, [eventId, destination, leaseMs]);
  return result.rows[0] ?? null;
}

export async function finishLocal(client, receipt) {
  await client.query('begin');
  try {
    const result = await client.query(`update receipts set state='done'
      where id=$1 and state='processing' and lease_token=$2
      and lease_until>clock_timestamp() returning id`, [receipt.id, receipt.lease_token]);
    if (result.rowCount) {
      await client.query(`insert into local_effects(receipt_id,marker) values($1,'synthetic-local')
        on conflict do nothing`, [receipt.id]);
    }
    await client.query('commit');
    return result.rowCount === 1;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once('message', async ({ context, schema, eventId, mode }) => {
    let client;
    try {
      client = await connectEventsDatabase(context,schema);
      const receipt = await claim(client, eventId, 'local-a', mode === 'crash' ? 200 : 5000);
      if (!receipt) throw new Error('Nenhum recibo disponível para o subprocesso.');
      if (mode === 'crash') {
        process.send({ receipt, phase: 'claimed' });
        // O processo pai enviará SIGKILL aqui, sem executar efeito nem ACK.
      } else {
        process.send({ receipt, phase: 'reclaimed' });
        // Pai prova a recusa do token antigo ENQUANTO o novo dono está processing.
        const [command] = await once(process, 'message', { signal: AbortSignal.timeout(5000) });
        if (command.action !== 'finish') throw new Error('Comando de conclusão experimental inválido.');
        const finished = await finishLocal(client, receipt);
        process.send({ receipt, finished, phase: 'finished' });
        await client.end();
        process.disconnect();
      }
    } catch (error) {
      process.send({ error: error.message });
      await client?.end();
      process.disconnect();
      process.exitCode = 1;
    }
  });
}
