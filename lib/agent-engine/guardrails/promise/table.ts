/**
 * Tabela de preços/promessas versionada com carga por ponteiro (F4-01; blueprint
 * 6.4/6.5, anti-"vendo por R$1"; CLAUDE.md regra dura nº 10). ESPELHA o padrão de
 * `agent/playbook.ts`: conteúdo em `promise_table_versions` (imutável — trigger no
 * banco veta UPDATE; mudança = versão nova); ponteiro ativo em
 * `promise_table_pointers`; trocar versão/rollback = mover o ponteiro, sem restart.
 *
 * A tabela é por ORG e carregada de fonte confiável (organization_id do contexto do
 * turno, nunca do body — regra dura nº 1). Sem ponteiro = org não fiscaliza
 * promessa (gate no-op) — opt-in por publicar uma tabela.
 */
import type pg from 'pg';
import type { Queryable } from '../../queue/queue';

/**
 * Valores estruturados PERMITIDOS. Cada campo é uma dimensão de risco comercial;
 * campo ausente = dimensão não fiscalizada (o operador liga o que importa à org).
 * knobs versionados, não constantes: moram no DB, trocam com o ponteiro.
 */
export interface PromiseTable {
  /** Piso de preço em centavos: preço candidato ABAIXO disso → veto (anti-"R$1"). */
  minPriceCents?: number;
  /** Teto de desconto %: desconto candidato ACIMA disso → veto. */
  maxDiscountPercent?: number;
  /** Teto de parcelas: parcelamento candidato ACIMA disso → veto. */
  maxInstallments?: number;
}

export interface LoadedPromiseTable {
  table: PromiseTable;
  /** Versão ativa no momento da carga (auditoria/telemetria). */
  versionId: string;
}

/** Valida o shape do jsonb antes de publicar: só números finitos ≥ 0 nos campos conhecidos. */
export function validatePromiseTable(values: unknown): PromiseTable {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('tabela de promessa inválida: esperado objeto de valores permitidos');
  }
  const o = values as Record<string, unknown>;
  const table: PromiseTable = {};
  for (const key of ['minPriceCents', 'maxDiscountPercent', 'maxInstallments'] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`tabela de promessa inválida: '${key}' deve ser número finito ≥ 0`);
    }
    table[key] = v;
  }
  return table;
}

/** Publica uma versão nova (imutável desde o INSERT — o trigger do banco veta UPDATE). */
export async function insertPromiseTableVersion(
  db: pg.Pool,
  input: { tenantId: string; values: PromiseTable },
): Promise<{ id: string }> {
  const table = validatePromiseTable(input.values);
  const { rows } = await db.query<{ id: string }>(
    `insert into promise_table_versions (organization_id, values) values ($1, $2) returning id`,
    [input.tenantId, JSON.stringify(table)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insert em promise_table_versions não devolveu linha');
  return row;
}

/**
 * Move o ponteiro da org para uma versão — é O deploy e O rollback (sem restart).
 * A org vem DA VERSÃO no próprio SQL (fonte confiável): apontar para versão de
 * outra org é impossível por construção.
 */
export async function setPromiseTablePointer(
  db: pg.Pool,
  input: { tenantId: string; versionId: string },
): Promise<void> {
  const { rowCount } = await db.query(
    `insert into promise_table_pointers (organization_id, version_id)
     select v.organization_id, v.id
     from promise_table_versions v
     where v.id = $1 and v.organization_id = $2
     on conflict (organization_id) do update
       set version_id = excluded.version_id, updated_at = now()`,
    [input.versionId, input.tenantId],
  );
  if (rowCount === 0) {
    throw new Error('versão de tabela de promessa não encontrada para a org — ponteiro não movido');
  }
}

/**
 * Resolve o ponteiro da org. Chamada sob o lock de cada tentativa de envio
 * (sem cache de processo): ponteiro movido = próxima tentativa já vê a versão nova.
 * Sem ponteiro → null (org não fiscaliza promessa; o gate vira no-op).
 */
export async function loadPromiseTable(db: Queryable, tenantId: string): Promise<LoadedPromiseTable | null> {
  const { rows } = await db.query<{ version_id: string; values: unknown }>(
    `select v.id as version_id, v.values
     from promise_table_pointers p
     join promise_table_versions v on v.id = p.version_id
     where p.organization_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { table: validatePromiseTable(row.values), versionId: row.version_id };
}
