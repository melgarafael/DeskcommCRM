import {assertCurrentServiceBoundary,parseServiceBoundary,type CurrentServiceBoundary} from '@/lib/atendimento/fronteira';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

export type EstadoDaComunicacao = 'pending'|'queued'|'sent'|'deferred'|'vetoed'|'failed'|'cancelled_or_stale'|'unknown_legacy';
export interface ComunicacaoDoEvento {
  event_id: string; job_id: string | null; state: EstadoDaComunicacao;
  delivery: 'sent'|'delivered'|'read'|null; partial: boolean;
  reason: string; next_step: string; can_retry: boolean; can_rectify: boolean;
  manual_retries: number; trace_id: string|null; message_ids: string[];
}
interface FonteDaComunicacao {
  snapshot?:Record<string,unknown>; current_boundary?:CurrentServiceBoundary;
  event_id: string; job_id: string|null; authenticated: boolean; invalidated: boolean;
  job_status: string|null; deferred: boolean; manual_retries: number;
  trace_id: string|null; vetoed_code: string|null;
  ledger: {status:string; message_status:string|null; message_id:string|null}[];
}
export function projetarComunicacao(r: FonteDaComunicacao): ComunicacaoDoEvento {
  const accepted=r.ledger.filter(l=>['sent','delivered','read'].includes(l.message_status??''));
  const uncertain=r.ledger.some(l=>!['sent','delivered','read','queued'].includes(l.message_status??''));
  let state: EstadoDaComunicacao;
  if (r.invalidated) state='cancelled_or_stale';
  else if (!r.authenticated || !r.job_id) state='unknown_legacy';
  else if (r.ledger.some(l=>l.message_status==='queued')) state='queued';
  else if (r.job_status==='running') state='queued';
  else if (r.job_status==='pending') state=r.deferred?'deferred':'queued';
  else if (r.vetoed_code) state='vetoed';
  else if (accepted.length>0 && accepted.length===r.ledger.length) state='sent';
  else if (r.job_status==='dead'||r.job_status==='failed'||uncertain) state='failed';
  else state='pending';
  const stopped=['done','dead','failed'].includes(r.job_status??'');
  const retry=stopped && r.ledger.length===0 && r.authenticated && !r.invalidated && r.manual_retries<3;
  const copy: Record<EstadoDaComunicacao,[string,string]>={
    pending:['A decisão está registrada; não há comprovação de envio.','Revise a comunicação neste Caso.'],
    queued:['A comunicação está na fila ou em processamento.','A fila é responsável pela próxima tentativa.'],
    deferred:['A tentativa foi adiada pelo atendimento.','Aguarde a fila; revise a condição que adiou o envio.'],
    sent:['Há mensagem efetivamente enviada.','Confira abaixo o estado informado pelo canal.'],
    vetoed:['O envio foi recusado pelas regras do atendimento.','Revise ou retifique a decisão no mesmo Caso.'],
    failed:['A tentativa falhou ou o envio precisa de reconciliação.','Confira a conversa antes de retificar; não reenvie uma entrega ambígua.'],
    cancelled_or_stale:['A decisão foi substituída, revogada ou ficou fora do atendimento.','Não reutilize esta decisão para um novo pedido.'],
    unknown_legacy:['O registro antigo não comprova a comunicação.','Confira a conversa e registre uma retificação pertinente.'],
  };
  const delivery=accepted.length===0?null:accepted.every(l=>l.message_status==='read')?'read':
    accepted.every(l=>['delivered','read'].includes(l.message_status??''))?'delivered':'sent';
  return {event_id:r.event_id,job_id:r.job_id,state,delivery,partial:accepted.length>0&&(accepted.length<r.ledger.length||!!r.vetoed_code),
    reason:copy[state][0],next_step:copy[state][1],can_retry:retry,
    can_rectify:!r.invalidated && (stopped||r.job_id===null),manual_retries:r.manual_retries,
    trace_id:r.trace_id,message_ids:accepted.flatMap(l=>l.message_id?[l.message_id]:[])};
}

/** Evento→job→trace→ledger→mensagem; nenhuma mudança em agent_cases.status. */
export async function lerComunicacaoDoCaso(db: Queryable, org: string, caseId: string, closingJobId?:string): Promise<ComunicacaoDoEvento[]> {
  const {rows}=await db.query<FonteDaComunicacao>(
    `select e.id as event_id,j.id as job_id,
      coalesce(e.metadata->'review_context_v1'->>'origem'='case_reply_authenticated'
        and e.metadata->'review_context_v1'->>'versao'='1'
        and e.metadata->'review_context_v1'->>'papel' in('agent','manager','admin'),false) as authenticated,
      (e.metadata->'review_context_v1'->>'revoked_at' is not null or ac.status in('cancelled','escalated')
       or (e.metadata->'review_context_v1'->>'expires_at' is not null and
         (e.metadata->'review_context_v1'->>'expires_at')::timestamptz<=now())
       or exists(select 1 from agent_case_events n where n.organization_id=e.organization_id and n.case_id=e.case_id
         and n.kind='human_replied' and (n.created_at,n.id)>(e.created_at,e.id))) as invalidated,
      ac.context_snapshot as snapshot,jsonb_build_object('organization_id',c.organization_id,'contact_id',c.contact_id,
        'conversation_id',c.id,'service_revision',c.service_revision,'demanda_id',c.current_demanda_id,
        'demanda_revision',d.revision,'status',c.status,'demanda_fechada_em',d.fechada_em) as current_boundary,
      j.status as job_status,coalesce(j.run_after>now(),false) as deferred,
      coalesce((e.metadata->'communication'->>'manual_retries')::int,0) as manual_retries,
      t.id as trace_id,t.vetoed_code,
      coalesce((select jsonb_agg(jsonb_build_object('status',l.status,'message_status',m.status,'message_id',m.id) order by l.seq)
        from send_ledger l left join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
        where l.organization_id=e.organization_id and (l.human_event_id=e.id or (l.human_event_id is null and l.job_id=j.id))), '[]'::jsonb) as ledger
      from agent_case_events e join agent_cases ac on ac.organization_id=e.organization_id and ac.id=e.case_id
      join conversations c on c.organization_id=ac.organization_id and c.id=ac.conversation_id
      left join demandas d on d.organization_id=c.organization_id and d.contact_id=c.contact_id and d.id=c.current_demanda_id
      left join job_queue j on j.organization_id=e.organization_id and
        j.id::text=coalesce(e.metadata->'review_context_v1'->>'job_id',e.metadata->>'legacy_reply_job_id')
      left join lateral(select id,vetoed_code from before_send_traces b where b.organization_id=e.organization_id
        and b.job_id=j.id order by b.created_at desc,b.id desc limit 1)t on true
      where e.organization_id=$1 and e.case_id=$2 and e.kind='human_replied' and e.actor_kind='human'
        and e.actor_user_id is not null and e.human_action in('resolved','need_lead_info')
      order by e.created_at desc,e.id desc limit 20`, [org,caseId]);
  return rows.map(r=>{
    if(r.snapshot)try { assertCurrentServiceBoundary(parseServiceBoundary(r.snapshot.service_boundary),r.current_boundary??null); }
    catch { r={...r,invalidated:true}; }
    return projetarComunicacao(closingJobId && r.job_id===closingJobId && r.job_status==='running'?{...r,job_status:'done'}:r);
  });
}

export async function avisarComunicacaoPendente(db: Queryable,org:string,caseId:string,closingJobId?:string): Promise<void> {
  const states=await lerComunicacaoDoCaso(db,org,caseId,closingJobId);
  const latest=states[0];
  if (!latest)return;
  if(latest.state==='sent'||(latest.delivery&&!latest.partial&&latest.state==='cancelled_or_stale')) {
    await db.query(`update agent_inbox_items set status='resolved',resolved_at=now() where organization_id=$1
      and kind='other' and ref_kind='agent_case' and ref_id=$2 and title='Comunicação de Caso pendente' and status='open'`,[org,caseId]);
    return;
  }
  if(['queued','deferred'].includes(latest.state))return;
  await db.query(`with notice as (
    insert into agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
    select $1,'other','warn','Comunicação de Caso pendente',$3,'agent_case',$2
    where not exists(select 1 from agent_inbox_items where organization_id=$1 and ref_kind='agent_case' and ref_id=$2
      and title='Comunicação de Caso pendente' and status='open')
      and not exists(select 1 from agent_case_events where organization_id=$1 and id=$4
        and metadata->'communication'->>'notice_recorded'='true') on conflict do nothing returning id)
    update agent_case_events set metadata=jsonb_set(metadata,'{communication}',
      coalesce(metadata->'communication','{}'::jsonb)||jsonb_build_object('notice_recorded',true))
    where organization_id=$1 and id=$4 and (exists(select 1 from notice) or exists(select 1 from agent_inbox_items
      where organization_id=$1 and ref_kind='agent_case' and ref_id=$2 and title='Comunicação de Caso pendente' and status='open'))`,
    [org,caseId,latest.reason+' '+latest.next_step,latest.event_id]);
}

/** Varredura limitada: avisos persistidos não monopolizam a próxima rodada. */
export async function reconciliarComunicacoesPendentes(db:Queryable):Promise<number>{
  const {rows}=await db.query<{organization_id:string;case_id:string}>(`with candidatos as (
    select e.organization_id,e.case_id,e.created_at,coalesce(e.metadata->'communication'->>'notice_recorded'='true',false) as notice_recorded,
      exists(select 1 from agent_inbox_items i where i.organization_id=e.organization_id
        and i.ref_kind='agent_case' and i.ref_id=e.case_id and i.title='Comunicação de Caso pendente' and i.status='open') as avisado,
      exists(select 1 from send_ledger l join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
        where l.organization_id=e.organization_id and (l.human_event_id=e.id or (l.human_event_id is null and l.job_id=j.id))
          and m.status in('sent','delivered','read'))
      and not exists(select 1 from send_ledger l left join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
        where l.organization_id=e.organization_id and (l.human_event_id=e.id or (l.human_event_id is null and l.job_id=j.id))
          and (m.status is null or m.status not in('sent','delivered','read'))) as enviado
    from agent_case_events e join job_queue j on j.organization_id=e.organization_id
      and j.id::text=coalesce(e.metadata->'review_context_v1'->>'job_id',e.metadata->>'legacy_reply_job_id')
    where e.kind='human_replied' and e.actor_kind='human' and j.status in('done','dead','failed')
      and not exists(select 1 from agent_case_events n where n.organization_id=e.organization_id and n.case_id=e.case_id
        and n.kind='human_replied' and (n.created_at,n.id)>(e.created_at,e.id)))
    select organization_id,case_id from candidatos where (avisado and enviado) or (not avisado and not enviado and not notice_recorded)
      order by created_at,case_id limit 200`);
  for(const row of rows)await avisarComunicacaoPendente(db,row.organization_id,row.case_id);
  return rows.length;
}
