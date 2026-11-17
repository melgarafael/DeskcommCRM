-- manifest: libera o desfecho do compromisso (completed/no_show) para token de
-- API com o escopo `agenda:attendance` e grava QUAL token registrou (#4515).
-- A presença pela tela e a recusa do agente de IA continuam iguais.

-- ⚠️ POR QUE ISTO É SCHEMA E NÃO SÓ CÓDIGO. A regra "quem declara presença é uma
-- pessoa" não mora só no handler: `fn_appointment_stamp` recusa com
-- `appointment_human_confirmation_required` (42501) todo `update` que leve o
-- compromisso para `completed`/`no_show` sem `auth.uid()`. Um token entra por
-- service role, onde `auth.uid()` é nulo — sem esta migration a rota passaria a
-- aceitar o token e o banco derrubaria a escrita, devolvendo 422 no lugar do
-- desfecho.
--
-- O que a migration abre é UMA porta: o RPC `fn_appointment_record_attendance`,
-- que confere o token (organização, revogação, validade e escopo), deixa o id do
-- token numa GUC transaction-local e chama a MESMA `fn_appointment_change` da
-- tela. O carimbo revalida o token na própria linha e grava
-- `outcome_api_token_id`, então a pergunta "quem registrou?" tem resposta no
-- banco, não só no audit.
alter table public.calendar_appointments
  add column if not exists outcome_api_token_id uuid references public.api_tokens(id) on delete set null;

comment on column public.calendar_appointments.outcome_api_token_id is
  'Token de API que registrou o desfecho (#4515); nulo quando quem registrou foi uma pessoa pela Agenda.';

create or replace function public.fn_appointment_stamp()
returns trigger language plpgsql security definer set search_path=public as $fn$
declare changed boolean; actor uuid; token_do_desfecho uuid; grant_do_desfecho text;
begin
 if new.contact_id is not null and not exists(select 1 from public.contacts where id=new.contact_id and organization_id=new.organization_id) then
  raise exception 'appointment_contact_scope' using errcode='23503'; end if;
 if new.conversation_id is not null and not exists(select 1 from public.conversations where id=new.conversation_id and organization_id=new.organization_id and contact_id=new.contact_id and not is_group and (auth.uid() is null or public.fn_can_view_conversation(organization_id,assigned_to_user_id))) then
  raise exception 'appointment_conversation_scope' using errcode='23503'; end if;
 if tg_op='INSERT' then
  new.revision:=1;
  -- Legado importado sem autoria não vira fato certificado.
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null; new.outcome_api_token_id:=null;
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
 if new.status is distinct from old.status and new.status in ('completed','no_show') then
  -- 9392: autoridade externa, gravada pelo servidor — espelho, não certificação.
  -- Vem ANTES do ramo do token: o desfecho espelhado não tem autor, nem pessoa
  -- nem token, e por isso zera também `outcome_api_token_id`.
  if new.authority<>'local' and coalesce(nullif(current_setting('role',true),''),'none') not in ('authenticated','anon') then
   new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
   new.outcome_recorded_at:=null; new.outcome_api_token_id:=null;
   return new;
  end if;
  actor:=auth.uid();
  -- #4515: sem pessoa, a ÚNICA porta é um token de API desta organização que
  -- carregue `agenda:attendance` e esteja vivo. A GUC é escrita apenas por
  -- `fn_appointment_record_attendance`, mas o token é REVALIDADO aqui: a GUC
  -- sozinha não é a autorização, é o pedido.
  if actor is null then
   grant_do_desfecho:=current_setting('agenda.attendance_token',true);
   if grant_do_desfecho is not null and grant_do_desfecho<>'' then
    select t.id into token_do_desfecho from public.api_tokens t
     where t.id::text=grant_do_desfecho and t.organization_id=new.organization_id
       and t.revoked_at is null and (t.expires_at is null or t.expires_at>now())
       and t.scopes @> '["agenda:attendance"]'::jsonb;
   end if;
   if token_do_desfecho is null then
    raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  elsif not public.fn_role_at_least(new.organization_id,'agent') or not public.fn_support_write_allowed(new.organization_id) then
   raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
  new.outcome_user_id:=actor; new.outcome_recorded_at:=clock_timestamp();
  new.outcome_api_token_id:=token_do_desfecho;
  new.outcome_source_kind:=case when token_do_desfecho is not null then 'api_token' when new.outcome_message_id is null then 'user' else 'contact_message' end;
  if new.outcome_message_id is not null and not exists(
   select 1 from public.messages m join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
   where m.id=new.outcome_message_id and m.organization_id=new.organization_id and m.contact_id=new.contact_id
    and (new.conversation_id is null or m.conversation_id=new.conversation_id)
    and m.direction='inbound' and m.service_revision is not null and m.service_revision=c.service_revision
    and m.demanda_id is not distinct from c.current_demanda_id and m.created_at>=old.revision_started_at
    and not c.is_group and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
  ) then raise exception 'appointment_message_not_evidence' using errcode='42501'; end if;
 elsif changed then
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null; new.outcome_api_token_id:=null;
 else
  new.outcome_source_kind:=old.outcome_source_kind;
  -- SET NULL por retenção da FK é erosão de referência, não nova autoria.
  new.outcome_user_id:=case when new.outcome_user_id is null and not exists(select 1 from auth.users where id=old.outcome_user_id) then null else old.outcome_user_id end;
  new.outcome_message_id:=case when new.outcome_message_id is null and not exists(select 1 from public.messages where id=old.outcome_message_id and organization_id=old.organization_id) then null else old.outcome_message_id end;
  new.outcome_recorded_at:=old.outcome_recorded_at;
  new.outcome_api_token_id:=old.outcome_api_token_id;
 end if;
 return new;
end; $fn$;
revoke all on function public.fn_appointment_stamp() from public,anon,authenticated;
drop trigger if exists trg_appointment_stamp on public.calendar_appointments;
create trigger trg_appointment_stamp before insert or update on public.calendar_appointments for each row execute function public.fn_appointment_stamp();

-- O CAMINHO DA INTEGRAÇÃO. Valida o token, deixa o id na GUC transaction-local
-- e delega para `fn_appointment_change` — a MESMA função que a tela chama, com
-- a mesma revisão otimista, o mesmo recálculo de serviço e o mesmo evento
-- `appointment.outcome_confirmed` que alimenta `fn_appointment_recover`
-- (o gatilho de follow-up `appointment_no_show`).
create or replace function public.fn_appointment_record_attendance(
  p_org uuid,
  p_id uuid,
  p_revision bigint,
  p_patch jsonb,
  p_api_token uuid
) returns jsonb language plpgsql security definer set search_path=public as $fn$
declare token public.api_tokens; status_novo text;
begin
 if p_api_token is null then raise exception 'attendance_token_required' using errcode='42501'; end if;
 select * into token from public.api_tokens t
  where t.id=p_api_token and t.organization_id=p_org
    and t.revoked_at is null and (t.expires_at is null or t.expires_at>now());
 if not found or not (token.scopes @> '["agenda:attendance"]'::jsonb) then
  raise exception 'attendance_scope_required' using errcode='42501'; end if;
 -- Compromisso de autoridade externa (9392) é espelho: o desfecho dele vem do
 -- sistema que manda. Sem esta recusa, o RPC (que roda como servidor) cairia no
 -- ramo do espelho do carimbo e devolveria sucesso sem gravar quem registrou.
 if exists(select 1 from public.calendar_appointments a where a.id=p_id and a.organization_id=p_org and a.authority<>'local') then
  raise exception 'attendance_external_authority' using errcode='42501'; end if;
 status_novo:=p_patch->>'status';
 if status_novo is null or status_novo not in ('completed','no_show') then
  raise exception 'attendance_status_invalid' using errcode='22023'; end if;
 perform set_config('agenda.attendance_token',p_api_token::text,true);
 return public.fn_appointment_change(p_org,p_id,p_revision,p_patch);
end; $fn$;
revoke all on function public.fn_appointment_record_attendance(uuid,uuid,bigint,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.fn_appointment_record_attendance(uuid,uuid,bigint,jsonb,uuid) to service_role;
