import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ligarEventoAoJob } from '@/lib/agent-engine/agent/contexto-de-decisao-humana';
import { enqueueJob } from '@/lib/agent-engine/queue/queue';
import { requireCurrentServiceBoundary } from '@/lib/atendimento/fronteira-server';
import { parseServiceBoundary } from '@/lib/atendimento/fronteira';
import { lerComunicacaoDoCaso } from './comunicacao-do-caso';

export class ComunicacaoConflict extends Error {}
/** Mesma decisão/job no retry; retificação cria evento humano novo no MESMO Caso. */
export async function recuperarComunicacao(pool:pg.Pool,ids:{org:string;caseId:string;eventId:string;actor:string;role:'agent'|'manager'|'admin';support?:{session_id:string;access_mode:string}|null},
  action:'retry'|'rectify',note?:string):Promise<{job_id:string;event_id:string;reused:boolean}> {
  const client=await pool.connect();let failure:Error|undefined;
  try {
    await client.query('begin');
    const {rows}=await client.query<{context_snapshot:Record<string,unknown>;contact_id:string;human_action:string;metadata:Record<string,unknown>}>(
      `select ac.context_snapshot,c.contact_id,e.human_action,e.metadata from agent_cases ac
        join conversations c on c.organization_id=ac.organization_id and c.id=ac.conversation_id
        join agent_case_events e on e.organization_id=ac.organization_id and e.case_id=ac.id and e.id=$3
        where ac.organization_id=$1 and ac.id=$2 and ac.status in('resolved','awaiting_lead')
        and e.kind='human_replied' and e.actor_kind='human' and e.actor_user_id is not null
        and e.human_action in('resolved','need_lead_info') for update of ac,e`,[ids.org,ids.caseId,ids.eventId]);
    const row=rows[0];if(!row)throw new ComunicacaoConflict('Decisão indisponível para recuperação.');
    const boundary=parseServiceBoundary(row.context_snapshot.service_boundary);
    if(!boundary||boundary.organization_id!==ids.org||boundary.contact_id!==row.contact_id)
      throw new ComunicacaoConflict('O registro não comprova a fronteira do atendimento.');
    await requireCurrentServiceBoundary(client,boundary);
    const current=(await lerComunicacaoDoCaso(client,ids.org,ids.caseId))[0];
    if(!current||current.event_id!==ids.eventId||current.state==='cancelled_or_stale')
      throw new ComunicacaoConflict('A decisão mudou; releia o Caso.');
    if(action==='retry') {
      if(!current.can_retry||!current.job_id)throw new ComunicacaoConflict(current.next_step);
      // Reusa identidade de ledger e limites do dono da fila. Não existe outro worker de retry.
      const changed=await client.query(`update job_queue set status='pending',attempts=0,run_after=now(),
        locked_by=null,locked_at=null,last_error=null where organization_id=$1 and id=$2 and status in('done','dead','failed') returning id`,[ids.org,current.job_id]);
      if(!changed.rows[0])throw new ComunicacaoConflict('A fila já retomou esta comunicação.');
      await client.query(`update agent_case_events set metadata=jsonb_set(metadata,'{communication}',
        jsonb_build_object('manual_retries',$3::int,'retried_by',$4::text,'retried_at',now())) where organization_id=$1 and id=$2`,
        [ids.org,ids.eventId,current.manual_retries+1,ids.actor]);
      await client.query(`insert into api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
        values($1,$2,'ai.case_communication_retried','agent_case',$3,jsonb_build_object('event_id',$4::text,'job_id',$5::text,'support',$6::jsonb))`,
        [ids.org,ids.actor,ids.caseId,ids.eventId,current.job_id,JSON.stringify(ids.support??null)]);
      await client.query('commit');return {job_id:current.job_id,event_id:ids.eventId,reused:true};
    }
    if(!current.can_rectify||!note?.trim()||note.trim().length>4000)
      throw new ComunicacaoConflict('Retificação exige nota e tentativa encerrada; aguarde a fila.');
    const eventId=randomUUID();
    await client.query(`update agent_case_events set metadata=jsonb_set(metadata,'{review_context_v1}',
      coalesce(metadata->'review_context_v1','{}'::jsonb)||jsonb_build_object('revoked_at',now(),'superseded_by',$3::text))
      where organization_id=$1 and id=$2`,[ids.org,ids.eventId,eventId]);
    if(current.job_id)await client.query(`update job_queue set status='dead',locked_by=null,locked_at=null,
      last_error='case_decision_rectified' where organization_id=$1 and id=$2 and status in('pending','running','failed')`,[ids.org,current.job_id]);
    await client.query(`insert into agent_case_events(id,organization_id,case_id,kind,actor_kind,actor_user_id,human_action,body,metadata)
      values($1,$2,$3,'human_replied','human',$4,$5,$6,jsonb_build_object('rectifies_event_id',$7::text))`,
      [eventId,ids.org,ids.caseId,ids.actor,row.human_action,note.trim(),ids.eventId]);
    const {job}=await enqueueJob(client,ids.org,{kind:'case_reply_turn',leadId:row.contact_id,
      payload:{case_id:ids.caseId,action:row.human_action,human_event_id:eventId}});
    await ligarEventoAoJob(client,{tenantId:ids.org,caseId:ids.caseId,eventId,jobId:job.id,role:ids.role});
    await client.query(`insert into api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
      values($1,$2,'ai.case_decision_rectified','agent_case',$3,jsonb_build_object('event_id',$4::text,'previous_event_id',$5::text,'support',$6::jsonb))`,
      [ids.org,ids.actor,ids.caseId,eventId,ids.eventId,JSON.stringify(ids.support??null)]);
    await client.query('commit');return {job_id:job.id,event_id:eventId,reused:false};
  }catch(e){failure=e instanceof Error?e:new Error('communication_failed');await client.query('rollback');throw e;}
  finally{client.release(failure);}
}
