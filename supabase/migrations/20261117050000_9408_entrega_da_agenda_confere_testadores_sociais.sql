-- manifest: **O link de reunião que a IA envia também confere a lista de testadores por identidade social (Instagram/Facebook) do canal em pré-go-live (issue #4701, depois do #4690).** `fn_meet_delivery_policy` passa a devolver `ai_test_social_identities` (do `metadata` do canal, migration 9394) e `contact_social_identity` (`contacts.social_identity`), e `lib/agenda/meet-delivery.ts` passa as duas ao gate como `aiTestSocialIdentities` e `contactSocialIdentity`, como `consulta-pg.ts` já faz. Corpo copiado da 9399, só com essas duas chaves. Gate: `tests/invariants/pre-go-live-no-envio-da-agenda.test.ts` e `tests/unit/meet-delivery-pre-go-live.test.ts`.

-- ---- o envio do link da agenda confere também os testadores por identidade social (migration 9408, #4701) ----
-- A 9394 deu ao canal em modo de teste a lista `ai_test_social_identities`, que os
-- outros caminhos da IA já leem. A política da entrega do link (9399) devolvia só a
-- lista de telefones: o testador de Instagram/Facebook, que não tem telefone, ficava
-- de fora do link de reunião (falha fechada). Só a política muda; o settle é o da 9399.
create or replace function public.fn_meet_delivery_policy(p_org uuid,p_job uuid,p_worker text,p_acquired_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r record;
begin
 select a.meeting_delivery,a.contact_id,v.channel_session_id,c.is_blocked,c.is_anonymized,c.force_human,c.ai_opt_out,c.ai_authorized_at,c.phone_number,c.social_identity,v.assignee_kind,v.bot_silenced_until,cs.metadata,cs.archived_at,
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
  'force_human',r.force_human,'ai_opt_out',r.ai_opt_out,'ai_gate',r.metadata->>'ai_gate','ai_gate_mode',r.metadata->>'ai_gate_mode','ai_test_phone_numbers',r.metadata->'ai_test_phone_numbers','contact_phone_number',r.phone_number,'ai_test_social_identities',r.metadata->'ai_test_social_identities','contact_social_identity',r.social_identity,'ai_authorized_at',r.ai_authorized_at,'assignee_kind',r.assignee_kind,'bot_silenced_until',r.bot_silenced_until);
end;$$;
revoke all on function public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meet_delivery_policy(uuid,uuid,text,timestamptz) to service_role;
