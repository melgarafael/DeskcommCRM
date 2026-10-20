/** Casos são a fonte de autoridade. Payload de job é somente um ponteiro. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Queryable, JobRow } from '../queue/queue';
import { parseServiceBoundary, assertCurrentServiceBoundary } from '@/lib/atendimento/fronteira';
import { readCurrentServiceBoundary } from '@/lib/atendimento/fronteira-server';

const proveniencia = z.object({
  versao: z.literal(1), origem: z.literal('case_reply_authenticated'),
  papel: z.enum(['agent', 'manager', 'admin']), job_id: z.string().uuid(),
  revoked_at: z.string().optional(), expires_at: z.string().datetime().optional(),
});
export interface DecisaoHumanaDoCaso {
  eventId: string; caseId: string; jobId: string | null;
  action: string; note: string; at: string; title: string; summary: string; blocker: string;
  requestId: string | null; request: string | null;
  provenance: 'authenticated' | 'legacy_correlated' | 'unverifiable';
  eligible: boolean;
}
export interface ContextoDeDecisaoHumana {
  versao: 1;
  fingerprint: string;
  decisions: readonly DecisaoHumanaDoCaso[];
  currentRequest: { id: string; text: string; at: string } | null;
  limited: boolean;
}
interface Linha {
  event_id: string; case_id: string; action: string; note: string; at: string;
  actor_user_id: string | null; metadata: Record<string, unknown>;
  status: string; title: string; summary: string; blocker: string;
  snapshot: Record<string, unknown>; request_id: string | null; request: string | null;
}
/** Três reads agrupados. O nono resultado detecta perda de cobertura. */
export async function carregarContextoDeDecisaoHumana(
  db: Queryable, ids: { tenantId: string; leadId: string; conversationId: string },
  options: { now?: Date; lock?: boolean; canonicalRequest?: { id: string; text: string; at: string } | null } = {},
): Promise<ContextoDeDecisaoHumana> {
  const current = await readCurrentServiceBoundary(db, ids.tenantId, ids.conversationId);
  if (current?.contact_id !== ids.leadId) throw new Error('human_decision_scope_mismatch');
  const { rows } = await db.query<Linha>(
    `select e.id as event_id, ac.id as case_id, e.human_action as action, e.body as note,
       e.created_at::text as at, e.actor_user_id, e.metadata, ac.status, ac.title, ac.summary,
       ac.blocker, ac.context_snapshot as snapshot,
       m.id as request_id, coalesce(m.media_derived_text, m.body) as request
     from agent_cases ac join conversations c on c.id=ac.conversation_id and c.organization_id=ac.organization_id
     join agent_case_events e on e.case_id=ac.id and e.organization_id=ac.organization_id
     left join messages m on m.id=(case when ac.context_snapshot->>'request_message_id' ~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       then (ac.context_snapshot->>'request_message_id')::uuid end)
       and m.organization_id=ac.organization_id and m.conversation_id=ac.conversation_id and m.direction='inbound'
     where ac.organization_id=$1 and c.contact_id=$2 and c.id=$3
       and e.kind='human_replied' and e.actor_kind='human' and e.actor_user_id is not null
       and not exists (select 1 from agent_case_events newer where newer.organization_id=e.organization_id
         and newer.case_id=e.case_id and newer.kind in ('human_replied','cancelled','escalated')
         and (newer.created_at,newer.id)>(e.created_at,e.id))
     order by e.created_at desc, e.id desc limit 9 ${options.lock ? 'for share of ac, e' : ''}`,
    [ids.tenantId, ids.leadId, ids.conversationId],
  );
  const requestRows = await db.query<{ request: { id: string; text: string; at: string } | null; policy: unknown }>(
    `select (select jsonb_build_object('id',id,'text',coalesce(media_derived_text,body),'at',created_at::text)
       from messages where organization_id=$1 and conversation_id=$2 and direction='inbound'
       order by created_at desc,id desc limit 1) as request,
     jsonb_build_object('jev',settings->'jev','bindings',
       (select jsonb_agg(jsonb_build_object('purpose',purpose,'provider',provider,'model',model_id,
         'credential',credential_id,'enabled',is_enabled,'base',base_url) order by purpose)
        from ai_purpose_bindings where organization_id=$1 and purpose in ('promise_semantic','human_return_confirmation')))
       as policy from organizations where id=$1`, [ids.tenantId, ids.conversationId],
  );
  const rawRequest = Object.hasOwn(options,'canonicalRequest') ? options.canonicalRequest ?? null : requestRows.rows[0]?.request ?? null;
  let limited = rows.length > 8 || (rawRequest?.text?.length ?? 0) > 8000;
  let chars = 0;
  const decisions: DecisaoHumanaDoCaso[] = [];
  for (const row of rows.slice(0, 8)) {
    const size = (row.note?.length ?? 0) + (row.request?.length ?? 0) + row.title.length + row.summary.length + row.blocker.length;
    // Nunca cortar uma condição da decisão e liberar sua metade restante.
    if (!row.note || row.note.length > 4000 || size > 12000 || chars + size > 12000) { limited = true; continue; }
    chars += size;
    let boundaryValid = true;
    try { assertCurrentServiceBoundary(parseServiceBoundary(row.snapshot?.service_boundary), current); }
    catch { boundaryValid = false; }
    const p = proveniencia.safeParse(row.metadata?.review_context_v1);
    const valid = p.success && !p.data.revoked_at &&
      (!p.data.expires_at || Date.parse(p.data.expires_at) > (options.now ?? new Date()).getTime());
    decisions.push({
      eventId: row.event_id, caseId: row.case_id, jobId: p.success ? p.data.job_id : null,
      action: row.action, note: row.note, at: row.at, title: row.title, summary: row.summary, blocker: row.blocker,
      requestId: row.request_id, request: row.request,
      provenance: p.success ? 'authenticated' : boundaryValid ? 'legacy_correlated' : 'unverifiable',
      eligible: !!valid && boundaryValid && row.status === 'resolved' && row.action === 'resolved' &&
        !!row.request_id && !!row.request && !!rawRequest?.text,
    });
  }
  if (limited) for (const d of decisions) d.eligible = false;
  const currentRequest = rawRequest && rawRequest.text?.length <= 8000 ? rawRequest : null;
  const fingerprint = createHash('sha256').update(JSON.stringify({ current, rows, currentRequest, limited, policy:requestRows.rows[0]?.policy,
    eligibility: decisions.map(d => d.eligible) })).digest('hex');
  return { versao: 1, fingerprint, decisions, currentRequest, limited };
}

/** Reentrada: um único evento e um único job canônico, inclusive após retry. */
export async function resolverEventoDoJob(db: Queryable, job: JobRow): Promise<{
  eventId: string; note: string; conversationId: string; channelSessionId: string;
} | null> {
  const p = job.payload;
  const result = await db.query<{
    id: string; body: string; conversation_id: string; channel_session_id: string;
    metadata: Record<string, unknown>; context_snapshot: Record<string, unknown>;
  }>(
    `select e.id,e.body,c.id as conversation_id,c.channel_session_id,e.metadata,ac.context_snapshot
     from agent_case_events e join agent_cases ac on ac.id=e.case_id and ac.organization_id=e.organization_id
     join conversations c on c.id=ac.conversation_id and c.organization_id=ac.organization_id
     where e.organization_id=$1 and e.case_id=$2 and c.contact_id=$3 and c.channel_session_id is not null
       and e.kind='human_replied' and e.actor_kind='human' and e.actor_user_id is not null
       and e.human_action=$4 and ac.status=$5
       and (($6::uuid is not null and e.id=$6) or ($6 is null and e.body=$7))
       and ($6::uuid is null or not exists (select 1 from agent_case_events n where n.organization_id=e.organization_id and n.case_id=e.case_id
         and n.kind='human_replied' and (n.created_at,n.id)>(e.created_at,e.id))) limit 2`,
    [job.organization_id,p.case_id,job.contact_id,p.action,p.action==='resolved'?'resolved':'awaiting_lead',p.human_event_id ?? null,p.body ?? null],
  );
  if (result.rows.length !== 1) return null;
  const e = result.rows[0]!;
  try { assertCurrentServiceBoundary(parseServiceBoundary(e.context_snapshot?.service_boundary),
    await readCurrentServiceBoundary(db, job.organization_id, e.conversation_id)); } catch { return null; }
  const provenance = proveniencia.safeParse(e.metadata.review_context_v1);
  if (p.human_event_id) {
    if (!provenance.success || provenance.data.job_id !== job.id || provenance.data.revoked_at ||
      (provenance.data.expires_at && Date.parse(provenance.data.expires_at) <= Date.now())) return null;
  } else {
    // Legado inequivocamente correlacionado: reservar o evento por CAS, sem inventar autoria histórica.
    const claim = await db.query(`update agent_case_events set metadata=jsonb_set(metadata,'{legacy_reply_job_id}',to_jsonb($3::text))
      where organization_id=$1 and id=$2 and (metadata->>'legacy_reply_job_id' is null or metadata->>'legacy_reply_job_id'=$3)
      and not (metadata ? 'review_context_v1') returning id`, [job.organization_id,e.id,job.id]);
    if (claim.rowCount !== 1) return null;
  }
  return { eventId:e.id,note:e.body,conversationId:e.conversation_id,channelSessionId:e.channel_session_id };
}

/** Rodar com o MESMO cliente da transição e do enqueue. Falha aborta a transação inteira. */
export async function ligarEventoAoJob(db: Queryable, args: {
  tenantId: string; caseId: string; eventId: string; jobId: string; role: string;
}): Promise<void> {
  const metadata = proveniencia.parse({ versao:1,origem:'case_reply_authenticated',papel:args.role,job_id:args.jobId });
  const r = await db.query(`update agent_case_events set metadata=jsonb_set(metadata,'{review_context_v1}',$4::jsonb)
    where organization_id=$1 and case_id=$2 and id=$3 and kind='human_replied' and actor_kind='human'
      and not (metadata ? 'review_context_v1') returning id`,
    [args.tenantId,args.caseId,args.eventId,JSON.stringify(metadata)]);
  if (r.rowCount !== 1) throw new Error('human_event_link_failed');
}
