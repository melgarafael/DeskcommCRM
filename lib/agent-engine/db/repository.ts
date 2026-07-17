/**
 * Acesso tipado às tabelas núcleo do harness (0001_core.sql). SQL cru, sem ORM.
 *
 * Regra de isolamento (F2-02): toda função recebe `tenantId` obrigatório e toda
 * query filtra `tenant_id` — nenhuma função devolve linha de outro tenant.
 */
import type pg from 'pg';

export interface TenantRow {
  id: string;
  name: string;
  crm_organization_id: string;
  settings: Record<string, unknown>;
  created_at: Date;
}

export interface LeadRow {
  id: string;
  tenant_id: string;
  crm_organization_id: string;
  crm_contact_id: string;
  crm_conversation_id: string | null;
  channel_session_id: string | null;
  is_opted_out: boolean;
  created_at: Date;
}

export type InboxKind =
  | 'qr_rescan'
  | 'job_dead'
  | 'event_dead'
  | 'budget_exceeded'
  | 'handoff'
  | 'promotion_review'
  | 'other';

export interface InboxItemRow {
  id: string;
  tenant_id: string | null;
  kind: InboxKind;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  body: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  status: 'open' | 'ack' | 'resolved';
  created_at: Date;
}

export interface EventInboxRow {
  id: string;
  tenant_id: string;
  crm_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`esperava uma linha de ${what}, veio nenhuma`);
  }
  return row;
}

export async function createTenant(
  db: pg.Pool,
  input: { name: string; crmOrganizationId: string },
): Promise<TenantRow> {
  const { rows } = await db.query<TenantRow>(
    `insert into tenants (name, crm_organization_id)
     values ($1, $2)
     returning *`,
    [input.name, input.crmOrganizationId],
  );
  return one(rows, 'tenants');
}

/**
 * Upsert do espelho do contato (edge-contract §1). O `crm_organization_id` é copiado
 * DE `tenants` no próprio SQL — fonte confiável (pareamento), nunca payload.
 */
export async function upsertLead(
  db: pg.Pool,
  tenantId: string,
  input: { crmContactId: string; crmConversationId?: string | null; channelSessionId?: string | null },
): Promise<LeadRow> {
  const { rows } = await db.query<LeadRow>(
    `insert into leads (tenant_id, crm_organization_id, crm_contact_id, crm_conversation_id, channel_session_id)
     select t.id, t.crm_organization_id, $2, $3, $4
     from tenants t
     where t.id = $1
     on conflict (tenant_id, crm_contact_id) do update
       set crm_conversation_id = excluded.crm_conversation_id,
           channel_session_id  = excluded.channel_session_id
     returning *`,
    [tenantId, input.crmContactId, input.crmConversationId ?? null, input.channelSessionId ?? null],
  );
  return one(rows, `leads (tenant desconhecido?)`);
}

export async function getLead(db: pg.Pool, tenantId: string, leadId: string): Promise<LeadRow | null> {
  const { rows } = await db.query<LeadRow>(
    'select * from leads where tenant_id = $1 and id = $2',
    [tenantId, leadId],
  );
  return rows[0] ?? null;
}

export async function listLeads(db: pg.Pool, tenantId: string): Promise<LeadRow[]> {
  const { rows } = await db.query<LeadRow>(
    'select * from leads where tenant_id = $1 order by created_at',
    [tenantId],
  );
  return rows;
}

export async function insertInboxItem(
  db: pg.Pool,
  tenantId: string | null, // null = plataforma (ex.: infra)
  input: { kind: InboxKind; title: string; severity?: InboxItemRow['severity']; body?: string; refKind?: string; refId?: string },
): Promise<InboxItemRow> {
  const { rows } = await db.query<InboxItemRow>(
    `insert into inbox_items (tenant_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [tenantId, input.kind, input.severity ?? 'warn', input.title, input.body ?? null, input.refKind ?? null, input.refId ?? null],
  );
  return one(rows, 'inbox_items');
}

export async function listOpenInboxItems(db: pg.Pool, tenantId: string): Promise<InboxItemRow[]> {
  const { rows } = await db.query<InboxItemRow>(
    `select * from inbox_items
     where tenant_id = $1 and status = 'open'
     order by created_at desc`,
    [tenantId],
  );
  return rows;
}

/**
 * Registra um evento drenado do CRM. O handoff é at-least-once: re-entrega viola a
 * unique (tenant_id, crm_event_id) → captura do 23505 devolve a linha existente com
 * `deduped: true` (CLAUDE.md regra dura nº 14) — nunca um segundo efeito.
 */
export async function ingestCrmEvent(
  db: pg.Pool,
  tenantId: string,
  input: { crmEventId: string; eventType: string; payload?: Record<string, unknown> },
): Promise<{ event: EventInboxRow; deduped: boolean }> {
  try {
    const { rows } = await db.query<EventInboxRow>(
      `insert into event_inbox (tenant_id, crm_event_id, event_type, payload)
       values ($1, $2, $3, $4)
       returning *`,
      [tenantId, input.crmEventId, input.eventType, input.payload ?? {}],
    );
    return { event: one(rows, 'event_inbox'), deduped: false };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const { rows } = await db.query<EventInboxRow>(
      'select * from event_inbox where tenant_id = $1 and crm_event_id = $2',
      [tenantId, input.crmEventId],
    );
    return { event: one(rows, 'event_inbox (dedup)'), deduped: true };
  }
}

export async function listCrmEvents(db: pg.Pool, tenantId: string): Promise<EventInboxRow[]> {
  const { rows } = await db.query<EventInboxRow>(
    'select * from event_inbox where tenant_id = $1 order by created_at',
    [tenantId],
  );
  return rows;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
