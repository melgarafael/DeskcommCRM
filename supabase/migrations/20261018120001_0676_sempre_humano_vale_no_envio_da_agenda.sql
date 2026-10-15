-- manifest: **A marca "sempre atendimento humano" passa a valer também no envio da agenda.** `fn_meet_delivery_policy` devolve `contacts.ai_opt_out` no payload e `lib/agenda/meet-delivery.ts` passa a lê-lo, em vez de assumir que `force_human` já estaria ligado; `fn_meet_delivery_settle` aceita o motivo `ai_opt_out` (sem isso, a recusa nova estouraria `meet_reason_invalid` e o compromisso ficaria preso). Corpos copiados da ÚLTIMA definição no baseline (0226/0528), só com essas duas diferenças. Gate: `tests/invariants/sempre-humano-no-envio-da-agenda.test.ts` (marca ligada com `force_human` desligado) e `tests/unit/meet-delivery-sempre-humano.test.ts`.

-- ---- a marca "sempre atendimento humano" vale no envio da agenda (migration 0676) ----
-- O envio do link de reunião decidia a elegibilidade com `aiOptOut: false` fixo,
-- confiando que ligar `contacts.ai_opt_out` também deixa `force_human` ligado.
-- Agora a política devolve a marca e quem decide a lê. O settle precisa aceitar
-- o motivo novo, senão a recusa vira exceção e o job fica sem acerto.
create or replace function public.fn_meet_delivery_policy(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r record;
begin
 select a.meeting_delivery,a.contact_id,v.channel_session_id,c.is_blocked,c.is_anonymized,c.force_human,c.ai_opt_out,c.ai_authorized_at,v.assignee_kind,v.bot_silenced_until,cs.metadata,cs.archived_at,
  public.fn_meet_delivery_current(p_org,p_job,p_worker,p_acquired_at) as current
 into r from public.job_queue j join public.calendar_appointments a on a.organization_id=j.organization_id and a.id::text=j.payload->>'appointment_id'
 join public.contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
 join public.conversations v on v.organization_id=a.organization_id and v.contact_id=a.contact_id and v.id::text=j.payload->'service_boundary'->>'conversation_id'
 join public.channel_sessions cs on cs.organization_id=v.organization_id and cs.id=v.channel_session_id
 where j.organization_id=p_org and j.id=p_job and j.kind='transactional_delivery' and j.status='running' and j.locked_by=p_worker and j.locked_at=p_acquired_at
  and a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation';
 if not found then return jsonb_build_object('current',false,'reason','stale');end if;
 if not r.current then return jsonb_build_object('current',false,'reason',case when r.is_anonymized then 'lgpd' when r.is_blocked then 'opt_out' when r.archived_at is not null then 'channel' else 'access_or_stale' end);end if;
 return jsonb_build_object('current',true,'contact_id',r.contact_id,'channel_session_id',r.channel_session_id,'human_command',r.meeting_delivery->'authorized_by'->>'kind'='user',
  'force_human',r.force_human,'ai_opt_out',r.ai_opt_out,'ai_gate',r.metadata->>'ai_gate','ai_authorized_at',r.ai_authorized_at,'assignee_kind',r.assignee_kind,'bot_silenced_until',r.bot_silenced_until);
end;$$;
revoke all on function public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz) to service_role;

create or replace function public.fn_meet_delivery_settle(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz,p_state text,p_retry_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.job_queue; a public.calendar_appointments; contact uuid; current_intent boolean; reason text;
begin
 select contact_id into contact from public.job_queue where organization_id=p_org and id=p_job;
 if contact is null then return false;end if;
 perform public.fn_service_lock(p_org,contact);
 select * into j from public.job_queue where organization_id=p_org and id=p_job for update;
 if not found or j.kind<>'transactional_delivery' or j.status<>'running' or j.locked_by is distinct from p_worker or j.locked_at is distinct from p_acquired_at then return false;end if;
 select * into a from public.calendar_appointments where organization_id=p_org and id::text=j.payload->>'appointment_id' for update;
 current_intent:=a.meeting_delivery_job_id=j.id and a.meeting_delivery->>'generation'=j.payload->>'delivery_generation';
 if p_state like 'blocked:%' then
  reason:=substring(p_state from 9);
  if reason not in ('opt_out','lgpd','channel','access_or_stale','force_human','conversa_silenciada','conversa_de_humano','sem_autorizacao','autorizacao_expirada','ai_opt_out','limits','guardrail') then raise exception 'meet_reason_invalid' using errcode='22023';end if;
  p_state:='blocked';
 end if;
 if p_state not in ('sent','queued','retry','failed','blocked','stale') then raise exception 'meet_state_invalid' using errcode='22023';end if;
 if p_state in ('sent','queued','retry') and not public.fn_meet_delivery_current(p_org,p_job,p_worker,p_acquired_at) then p_state:='stale';end if;
 if p_state='sent' and not exists(select 1 from public.send_ledger where organization_id=p_org and job_id=p_job and seq=1 and status='accepted') then raise exception 'meet_delivery_not_accepted' using errcode='PT409';end if;
 if p_state='retry' and j.attempts>=j.max_attempts then p_state:='failed';end if;
 if p_state in ('queued','retry') then
  update public.job_queue set status='pending',locked_by=null,locked_at=null,attempts=case when p_state='queued' then greatest(0,attempts-1) else attempts end,run_after=coalesce(p_retry_at,now()+interval '1 minute'),last_error='meet_delivery_waiting' where id=p_job and organization_id=p_org;
 else
  update public.job_queue set status=case when p_state='sent' then 'done' else 'failed' end,locked_by=null,locked_at=null,last_error=case when p_state='sent' then null else coalesce(reason,'meet_delivery_'||p_state) end where id=p_job and organization_id=p_org;
  if current_intent then
   update public.calendar_appointments set meeting_delivery=meeting_delivery||jsonb_build_object('state',p_state,'error',case when p_state='sent' then null else coalesce(reason,'meet_delivery_'||p_state) end,'settled_at',now()) where id=a.id and organization_id=p_org;
   if p_state<>'sent' then perform public.fn_meet_notice(p_org,a.id,p_state);
   else update public.agent_inbox_items set status='resolved',resolved_at=now() where organization_id=p_org and ref_kind='appointment' and ref_id=a.id and kind='other' and status='open';end if;
  end if;
 end if;
 return true;
end;$$;
revoke all on function public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_settle(uuid,uuid,text,timestamptz,text,timestamptz) to service_role;
