/**
 * Template de disclosure "assistente virtual" versionado com carga por ponteiro (F4-05;
 * blueprint 5.7 — disclosure by design; CLAUDE.md regra dura nº 10). ESPELHA o padrão de
 * `promise/table.ts`: conteúdo em `disclosure_template_versions` (imutável — trigger no
 * banco veta UPDATE; mudança = versão nova); ponteiro ativo em
 * `disclosure_template_pointers`; trocar versão/rollback = mover o ponteiro, sem restart.
 *
 * O template é por TENANT e carregado de fonte confiável (tenant_id do contexto do turno,
 * nunca do body — regra dura nº 1). Sem ponteiro = tenant não configurou disclosure (o gate
 * vira no-op) — opt-in por publicar um template.
 */
import type pg from 'pg';
import type { Queryable } from '../../queue/queue';

/** Modo do gate quando a 1ª mensagem sai sem disclosure (knob, DISCLOSURE_MODE). */
export type DisclosureMode = 'inject' | 'veto';

export interface LoadedDisclosureTemplate {
  /** texto pt-br do disclosure (injetado no modo inject, exigido do modelo no modo veto). */
  body: string;
  /** versão ativa no momento da carga (auditoria/telemetria). */
  versionId: string;
}

/** Publica uma versão nova (imutável desde o INSERT — o trigger do banco veta UPDATE). */
export async function insertDisclosureTemplateVersion(
  db: pg.Pool,
  input: { tenantId: string; body: string },
): Promise<{ id: string }> {
  const body = input.body.trim();
  if (body.length === 0) throw new Error('template de disclosure vazio: informe o texto do disclosure');
  const { rows } = await db.query<{ id: string }>(
    `insert into disclosure_template_versions (tenant_id, body) values ($1, $2) returning id`,
    [input.tenantId, body],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('insert em disclosure_template_versions não devolveu linha');
  return row;
}

/**
 * Move o ponteiro do tenant para uma versão — é O deploy e O rollback (sem restart). O
 * tenant vem DA VERSÃO no próprio SQL (fonte confiável): apontar para versão de outro tenant
 * é impossível por construção.
 */
export async function setDisclosureTemplatePointer(
  db: pg.Pool,
  input: { tenantId: string; versionId: string },
): Promise<void> {
  const { rowCount } = await db.query(
    `insert into disclosure_template_pointers (tenant_id, version_id)
     select v.tenant_id, v.id
     from disclosure_template_versions v
     where v.id = $1 and v.tenant_id = $2
     on conflict (tenant_id) do update
       set version_id = excluded.version_id, updated_at = now()`,
    [input.versionId, input.tenantId],
  );
  if (rowCount === 0) {
    throw new Error('versão de template de disclosure não encontrada para o tenant — ponteiro não movido');
  }
}

/**
 * Resolve o ponteiro do tenant. Chamada sob o lock de cada tentativa de envio (sem cache de
 * processo): ponteiro movido = próxima tentativa já vê a versão nova. Sem ponteiro → null
 * (tenant não configurou disclosure; o gate vira no-op).
 */
export async function loadDisclosureTemplate(db: Queryable, tenantId: string): Promise<LoadedDisclosureTemplate | null> {
  const { rows } = await db.query<{ version_id: string; body: string }>(
    `select v.id as version_id, v.body
     from disclosure_template_pointers p
     join disclosure_template_versions v on v.id = p.version_id
     where p.tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { body: row.body, versionId: row.version_id };
}

/**
 * "PRIMEIRO outbound ao lead": conta envios `accepted` prévios (send_ledger, F2-06) deste
 * lead. 0 → é o primeiro (o disclosure precisa estar na mensagem). Só sends CONFIRMADOS
 * contam: um 'queued'/'failed' não alcançou o lead, então a próxima tentativa ainda é a
 * primeira e leva o disclosure. tenant_id/lead_id de fonte confiável (row do job — regra dura nº 1).
 */
export async function countPriorAcceptedSends(db: Queryable, tenantId: string, leadId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from send_ledger
     where tenant_id = $1 and lead_id = $2 and status = 'accepted'`,
    [tenantId, leadId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * O corpo candidato JÁ contém o disclosure? Match por substring normalizada (lowercase +
 * colapso de espaços): no modo veto o modelo cola o template ensinado (casa); no modo inject
 * evita duplicar quando o modelo já se apresentou. ponytail: substring do template inteiro —
 * suficiente no MVP; upgrade path é matching semântico se o modelo parafrasear o disclosure.
 */
export function bodyContainsDisclosure(body: string, template: string): boolean {
  return normalize(body).includes(normalize(template));
}

/** Prepend do disclosure ao corpo (modo inject) — o disclosure abre a 1ª mensagem. */
export function prependDisclosure(body: string, template: string): string {
  return `${template.trim()}\n\n${body}`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
