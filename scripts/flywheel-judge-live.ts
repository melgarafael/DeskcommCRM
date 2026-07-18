/**
 * Flywheel vivo — wrapper one-shot do módulo lib/agent-engine/flywheel/live.
 * Rodar: pnpm flywheel:judge [-- --limit N]
 * (o loop agendado roda no worker via FLYWHEEL_INTERVAL_MS; este script é o
 * gatilho manual/CI — mesma lógica, mesmo gate humano.)
 */
import { createPool } from '@/lib/agent-engine/db/pool';
import { loadEnv } from '@/lib/agent-engine/env';
import { createLogger } from '@/lib/agent-engine/obs/logger';
import { llmEdgeConfigFromEnv } from '@/lib/agent-engine/edge/llm/run-model-call';
import { runFlywheelOnce } from '@/lib/agent-engine/flywheel/live';

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 5;
  const env = loadEnv();
  const log = createLogger();
  const pool = createPool(env.SUPABASE_DB_URL);
  const result = await runFlywheelOnce(pool, llmEdgeConfigFromEnv(env), { limit, log });
  log.info('flywheel: rodada concluída', result as unknown as Record<string, unknown>);
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`flywheel falhou: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
