/**
 * Seed da camada PLATFORM do playbook no boot do worker — destrava o primeiro
 * turno de um self-host limpo (sem ele, todo job inbound_turn morre em
 * "ponteiro da camada plataforma ausente").
 *
 * Respeita a regra dura nº 10: se JÁ existe ponteiro global (org null, layer
 * platform), o seed NÃO toca em nada — nem quando o arquivo git diverge do
 * conteúdo apontado. Mover ponteiro é ato deliberado, nunca automático.
 *
 * Concorrência-safe: transação + pg_advisory_xact_lock — dois workers subindo
 * ao mesmo tempo produzem exatamente 1 versão + 1 ponteiro.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type pg from 'pg';

import { validatePlaybookLayerContent } from './playbook';

/** Fonte canônica versionada em git (copiada pro container via `COPY . .`). */
export const PLATFORM_PLAYBOOK_PATH = path.join(
  process.cwd(),
  'lib',
  'agent-engine',
  'playbooks',
  'platform.md',
);

export async function seedPlatformPlaybook(
  pool: pg.Pool,
  opts?: { filePath?: string },
): Promise<'seeded' | 'kept'> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('playbook_platform_seed'))");
    const existing = await client.query(
      `select 1 from playbook_pointers where organization_id is null and layer = 'platform' limit 1`,
    );
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('commit');
      return 'kept';
    }
    // Arquivo só é lido quando vamos seedar de fato: ponteiro existente não
    // depende da presença do arquivo no ambiente.
    const content = readFileSync(opts?.filePath ?? PLATFORM_PLAYBOOK_PATH, 'utf8');
    validatePlaybookLayerContent(content);
    const { rows } = await client.query<{ id: string }>(
      `insert into playbook_versions (organization_id, layer, content)
       values (null, 'platform', $1)
       returning id`,
      [content],
    );
    const versionId = rows[0]?.id;
    if (versionId === undefined) {
      throw new Error('seed: insert em playbook_versions não devolveu linha');
    }
    await client.query(
      `insert into playbook_pointers (organization_id, layer, version_id)
       values (null, 'platform', $1)`,
      [versionId],
    );
    await client.query('commit');
    return 'seeded';
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
