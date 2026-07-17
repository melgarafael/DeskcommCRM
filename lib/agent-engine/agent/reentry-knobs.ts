/**
 * Knobs de re-entrada versionados por PONTEIRO (F5-10; blueprint 4.7) — o primeiro
 * alvo concreto do flywheel: TIMING de follow-up e SEGMENTAÇÃO viram config
 * otimizável, não constante. Espelha a disciplina do playbook (F2-07) e dos
 * templates de re-entrada (F3-04; regra dura nº 10): conteúdo IMUTÁVEL por versão
 * (trigger no banco veta UPDATE — mudança = versão nova), troca/rollback = mover o
 * ponteiro sem restart.
 *
 * O otimizador (scripts/flywheel/reentry-knobs-core.ts) propõe uma mudança de timing
 * como DELTA, o merge determinístico gera os knobs novos, e o insert aqui publica a
 * versão nova. Mover o ponteiro para frente = deploy; para trás = rollback — o knob
 * efetivo lido em `loadReentryKnobs` acompanha o ponteiro.
 *
 * O daemon NÃO cacheia em processo (como loadPlaybook/loadReentryTemplate): mover o
 * ponteiro ⇒ o próximo follow-up já resolve a versão nova com o daemon vivo.
 */
import type pg from 'pg';
import { z } from 'zod';

// Schema dos knobs INLINE (o otimizador do Vendaval — scripts/flywheel/ — entra na
// Fase 3; até lá este é o dono do shape). Revalidado no insert E na leitura.
export const reentryKnobsSchema = z
  .object({
    /** janela de follow-up em horas (>0) — o timing otimizável do flywheel. */
    follow_up_window_hours: z.number().positive(),
    /** segmentos habilitados para re-entrada (vazio = nenhum). */
    enabled_segments: z.array(z.string()),
  })
  .strict();
export type ReentryKnobs = z.infer<typeof reentryKnobsSchema>;

export interface ReentryKnobVersionRow {
  id: string;
  organization_id: string;
  knobs: ReentryKnobs;
  created_at: Date;
}

/** Publica uma versão nova (imutável desde o INSERT — o trigger do banco veta UPDATE). */
export async function insertReentryKnobVersion(
  db: pg.Pool,
  input: { tenantId: string; knobs: ReentryKnobs },
): Promise<ReentryKnobVersionRow> {
  const knobs = reentryKnobsSchema.parse(input.knobs);
  const { rows } = await db.query<ReentryKnobVersionRow>(
    `insert into reentry_knob_versions (organization_id, knobs)
     values ($1, $2)
     returning *`,
    [input.tenantId, JSON.stringify(knobs)],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insert em reentry_knob_versions não devolveu linha');
  }
  return row;
}

/**
 * Move o ponteiro do tenant para uma versão — é O deploy e O rollback (segundos, sem
 * restart). O tenant vem DA VERSÃO no próprio SQL (fonte confiável): apontar para
 * versão de outro tenant é impossível por construção.
 */
export async function setReentryKnobPointer(
  db: pg.Pool,
  input: { tenantId: string; versionId: string },
): Promise<void> {
  const { rowCount } = await db.query(
    `insert into reentry_knob_pointers (organization_id, version_id)
     select v.organization_id, v.id
     from reentry_knob_versions v
     where v.id = $1 and v.organization_id = $2
     on conflict (organization_id) do update
       set version_id = excluded.version_id, updated_at = now()`,
    [input.versionId, input.tenantId],
  );
  if (rowCount === 0) {
    throw new Error('versão de knobs de re-entrada não encontrada para o tenant — ponteiro não movido');
  }
}

/**
 * Resolve o ponteiro do tenant → knobs efetivos. Sem cache de processo, de propósito:
 * ponteiro movido = próxima leitura já vê a versão nova (acc 2). `null` = tenant sem
 * knobs apontados (o caller usa o default env — F3-02 FollowupWindowKnobs).
 */
export async function loadReentryKnobs(
  db: pg.Pool,
  tenantId: string,
): Promise<{ versionId: string; knobs: ReentryKnobs } | null> {
  const { rows } = await db.query<{ version_id: string; knobs: ReentryKnobs }>(
    `select v.id as version_id, v.knobs
     from reentry_knob_pointers p
     join reentry_knob_versions v on v.id = p.version_id
     where p.organization_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { versionId: row.version_id, knobs: reentryKnobsSchema.parse(row.knobs) };
}
