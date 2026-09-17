import { connectBenchDatabase } from '../common.mjs';

// Toda conexão física é atestada antes de selecionar o schema ou executar a fixture.
export async function connectEventsDatabase(context, schema, statementTimeoutMs = 5000) {
  if (!/^bench_events_[a-f0-9]{32}$/.test(schema)) {
    throw new Error('Schema inválido para a bancada de eventos.');
  }
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
    throw new Error('Tempo de SQL inválido para a bancada de eventos.');
  }
  const client = await connectBenchDatabase(context);
  try {
    await client.query(`select set_config('search_path',$1,false),
      set_config('statement_timeout',$2,false)`, [`${schema},pg_catalog`, String(statementTimeoutMs)]);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}
