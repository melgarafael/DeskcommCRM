/**
 * Garantia do playbook platform para quem executa o turno SEM o boot do worker
 * (ensaio web) e para o próprio worker (um único caminho).
 *
 * Reusa `seedPlatformPlaybook`: transação + advisory lock, idempotente, não
 * move ponteiro existente. Duas chamadas concorrentes não duplicam versão.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { seedPlatformPlaybook } from './playbook-seed';

export const CODIGO_PLAYBOOK_PLATFORM_AUSENTE = 'playbook_platform_missing';

/** Falha ao garantir o playbook platform — mensagem curta, sem path nem stack. */
export class PlaybookPlatformMissingError extends Error {
  override readonly name = CODIGO_PLAYBOOK_PLATFORM_AUSENTE;
  readonly code = CODIGO_PLAYBOOK_PLATFORM_AUSENTE;
  constructor() {
    super('playbook de plataforma ausente');
  }
}

export type OrigemDoEnsure = 'boot' | 'ensaio';

/**
 * Garante que o ponteiro platform existe. Não sobrescreve versão já apontada.
 * Loga só o desfecho (`seeded`/`kept`/código), nunca conteúdo do playbook.
 */
export async function ensurePlatformPlaybook(
  pool: pg.Pool,
  log?: Logger,
  opts?: { filePath?: string; origem?: OrigemDoEnsure },
): Promise<'seeded' | 'kept'> {
  const origem = opts?.origem ?? 'ensaio';
  try {
    const result = await seedPlatformPlaybook(
      pool,
      opts?.filePath !== undefined ? { filePath: opts.filePath } : undefined,
    );
    if (result === 'seeded') {
      log?.info('playbook platform seedado', { origem });
    }
    return result;
  } catch {
    log?.error('playbook platform indisponivel', {
      code: CODIGO_PLAYBOOK_PLATFORM_AUSENTE,
      origem,
    });
    throw new PlaybookPlatformMissingError();
  }
}
