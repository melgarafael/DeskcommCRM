/**
 * Templates de re-entrada versionados (F3-04; blueprint 1.3) — artefato do harness
 * carregado por PONTEIRO, espelhando a disciplina do playbook (F2-07; regra dura
 * nº 10): conteúdo IMUTÁVEL por versão (trigger no banco veta UPDATE — mudança =
 * versão nova), troca/rollback = mover o ponteiro sem restart. Cada versão guarda
 * N VARIANTES pt-br de spinning; a escolha por lead é DETERMINÍSTICA (hash do
 * lead_id % nº de variantes): mesmo lead sempre a mesma variante, leads diferentes
 * variam — o anti-template-idêntico da F2-12 no caminho $0 (sem LLM).
 *
 * O daemon NÃO cacheia em processo (como loadPlaybook): mover o ponteiro ⇒ o
 * próximo follow-up já usa a versão nova com o daemon vivo.
 */
import { createHash } from 'node:crypto';

import type pg from 'pg';

export interface ReentryTemplateVersionRow {
  id: string;
  organization_id: string;
  variants: string[];
  created_at: Date;
}

export interface LoadedReentryTemplate {
  versionId: string;
  variants: string[];
}

/** Forma da versão: >= 1 variante, nenhuma em branco (cada variante é copy pt-br pronta para envio). */
export function validateVariants(variants: string[]): void {
  if (variants.length === 0) {
    throw new Error('template de re-entrada precisa de ao menos uma variante');
  }
  for (const v of variants) {
    if (v.trim().length === 0) {
      throw new Error('variante de template de re-entrada em branco — cada variante é uma copy pt-br pronta para envio');
    }
  }
}

/** Publica uma versão nova (imutável desde o INSERT — o trigger do banco veta UPDATE). */
export async function insertReentryTemplateVersion(
  db: pg.Pool,
  input: { tenantId: string; variants: string[] },
): Promise<ReentryTemplateVersionRow> {
  validateVariants(input.variants);
  const { rows } = await db.query<ReentryTemplateVersionRow>(
    `insert into reentry_template_versions (organization_id, variants)
     values ($1, $2)
     returning *`,
    [input.tenantId, input.variants],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insert em reentry_template_versions não devolveu linha');
  }
  return row;
}

/**
 * Move o ponteiro do tenant para uma versão — é O deploy e O rollback (segundos, sem
 * restart). O tenant vem DA VERSÃO no próprio SQL (fonte confiável): apontar para
 * versão de outro tenant é impossível por construção.
 */
export async function setReentryTemplatePointer(
  db: pg.Pool,
  input: { tenantId: string; versionId: string },
): Promise<void> {
  const { rowCount } = await db.query(
    `insert into reentry_template_pointers (organization_id, version_id)
     select v.organization_id, v.id
     from reentry_template_versions v
     where v.id = $1 and v.organization_id = $2
     on conflict (organization_id) do update
       set version_id = excluded.version_id, updated_at = now()`,
    [input.versionId, input.tenantId],
  );
  if (rowCount === 0) {
    throw new Error('versão de template de re-entrada não encontrada para o tenant — ponteiro não movido');
  }
}

/**
 * Resolve o ponteiro do tenant → variantes ativas. Chamada no disparo de CADA
 * follow-up determinístico — sem cache de processo, de propósito: ponteiro movido =
 * próximo disparo já vê a versão nova (acc1). `null` = tenant sem template apontado.
 */
export async function loadReentryTemplate(db: pg.Pool, tenantId: string): Promise<LoadedReentryTemplate | null> {
  const { rows } = await db.query<{ version_id: string; variants: string[] }>(
    `select v.id as version_id, v.variants
     from reentry_template_pointers p
     join reentry_template_versions v on v.id = p.version_id
     where p.organization_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { versionId: row.version_id, variants: row.variants };
}

/**
 * Variante DETERMINÍSTICA por lead: sha256(lead_id) → uint32 → módulo nº de variantes.
 * Mesmo lead ⇒ sempre a mesma variante; leads diferentes distribuem (acc2 — dois leads
 * que caem em variantes distintas recebem copy não-idêntica). Sem estado, sem relógio.
 */
export function pickReentryVariant(leadId: string, variants: string[]): string {
  if (variants.length === 0) {
    throw new Error('sem variantes para escolher — template de re-entrada vazio');
  }
  const digest = createHash('sha256').update(leadId).digest();
  const index = digest.readUInt32BE(0) % variants.length;
  return variants[index]!;
}
