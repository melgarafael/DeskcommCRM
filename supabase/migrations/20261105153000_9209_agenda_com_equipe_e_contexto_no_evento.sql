-- manifest: **A agenda aceita convidados da equipe e leva o contexto do negócio ao evento do Google (#4006).** `calendar_appointments.team_guest_user_ids` (uuid[], default vazio) guarda as pessoas da ORGANIZAÇÃO convidadas além do responsável e do `guest_email`; `fn_google_projection_stamp` passa a tratá-la como campo publicável, então incluir ou tirar convidado empurra o compromisso para o worker do Google sem um segundo mecanismo de gatilho. `calendar_event_types.levar_dados_do_negocio` (boolean, default true) é o interruptor do bloco do negócio na descrição. Aditiva e sem perda: compromisso antigo carrega com a lista vazia e com o interruptor ligado, e toda linha existente já satisfaz o default.
--
-- ─── POR QUE ARRAY NA PRÓPRIA LINHA, E NÃO TABELA DE CONVIDADOS ─────────────
--
-- A proposta da issue era uma tabela `calendar_appointment_team_guests`. O que
-- decidiu contra foi o mecanismo que leva a mudança ao Google: quem publica é
-- `fn_google_projection_stamp`, um gatilho BEFORE INSERT OR UPDATE **na linha do
-- compromisso**, que compara colunas dela para incrementar `google_local_revision`
-- e agendar a escrita. Com tabela separada, incluir um convidado não muda coluna
-- nenhuma do compromisso: o worker nunca saberia que há algo a publicar, e o
-- conserto seria um segundo gatilho, um `update` artificial na linha e mais uma
-- policy de RLS para o mesmo dado que já é 1:1 do compromisso.
--
-- O conjunto é pequeno (teto de 20 na rota), sempre lido e escrito JUNTO com o
-- compromisso, e é o Google que precisa da lista inteira de uma vez — não há
-- consulta por convidado. `to_jsonb(a)` já entrega a coluna ao snapshot do
-- worker, sem view nem RPC nova. A conferência de organização mora na rota e no
-- resolvedor de e-mails (`lib/agenda/google/convidados-da-equipe.ts`), porque
-- array não aceita FK; é a mesma régua nos dois caminhos.

alter table public.calendar_appointments
  add column if not exists team_guest_user_ids uuid[] not null default '{}'::uuid[];

comment on column public.calendar_appointments.team_guest_user_ids is
  'Pessoas da ORGANIZAÇÃO convidadas para o compromisso, além do responsável (owner_user_id) e do e-mail digitado (guest_email). O convidado NÃO vira dono: carteira, distribuição e métricas continuam no owner_user_id. O worker resolve cada id no e-mail da conta Google conectada (a saudável primeiro) ou, sem conta, no e-mail de login, e entra em attendees com responseStatus=needsAction (migration 9209).';

alter table public.calendar_event_types
  add column if not exists levar_dados_do_negocio boolean not null default true;

comment on column public.calendar_event_types.levar_dados_do_negocio is
  'true = a descrição do evento no Google leva, DEPOIS do texto do compromisso, o bloco do negócio (negócio, etapa, produtos da proposta vigente, cliente, telefone e link do CRM). Ligado de fábrica; desligue quando o nome do negócio for assunto interno — com e-mail na ficha, o próprio cliente é convidado e lê a descrição. Só compromissos futuros recebem o bloco (migration 9209).';

-- A coluna nova é campo PUBLICÁVEL: sem ela nas duas comparações abaixo, mudar
-- quem participa não incrementaria `google_local_revision` e a alteração nunca
-- chegaria ao Google.
create or replace function public.fn_google_projection_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; inbound boolean; decision boolean; redacted boolean;
begin
 redacted:=new.contact_id is not null and exists(select 1 from public.contacts where organization_id=new.organization_id and id=new.contact_id and is_anonymized);
 if redacted then
  new.google_base_projection:=null;new.google_conflict:=null;new.google_pending_write:=null;new.google_claim_token:=null;new.google_claim_until:=null;new.google_etag:=null;new.guest_email:=null;
  if tg_op='UPDATE' then new.google_claim_epoch:=old.google_claim_epoch+1;new.google_local_revision:=old.google_local_revision;new.google_synced_local_revision:=old.google_local_revision;end if;
  return new;
 end if;
 if tg_op='INSERT' then
  new.google_local_revision:=1;new.google_synced_local_revision:=0;
  if auth.uid() is not null then
   new.google_base_projection:=null;new.google_etag:=null;new.google_pending_write:=null;new.google_conflict:=null;
   new.google_claim_token:=null;new.google_claim_epoch:=0;new.google_claim_until:=null;
   new.google_connection_id:=null;new.google_calendar_id:=null;new.google_event_id:=null;
  end if;
  return new;
 end if;
 decision:=public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
  and old.google_conflict is not null and new.google_conflict-'resolution'=old.google_conflict-'resolution'
  and new.google_conflict->'resolution'->>'actor_id'=auth.uid()::text
  and new.google_conflict->'resolution'->>'choice' in ('google','local','preserve_remote')
  and old.google_conflict->>'revision'=old.revision::text and old.google_conflict->>'local_revision'=old.google_local_revision::text
  and old.google_conflict->>'etag' is not distinct from old.google_etag;
 if auth.uid() is not null and (row(new.google_synced_at,new.google_sync_error) is distinct from row(old.google_synced_at,old.google_sync_error)
  or (new.google_next_attempt_at is distinct from old.google_next_attempt_at and not coalesce(public.fn_calendar_service_can_resolve(old.organization_id,old.id) and public.fn_role_at_least(new.organization_id,'agent') and public.fn_support_write_allowed(new.organization_id)
    and new.google_next_attempt_at<=clock_timestamp() and (old.google_conflict is null or decision),false))) then
  raise exception 'google_metadata_private' using errcode='42501';end if;
 if auth.uid() is not null and ((new.google_conflict is distinct from old.google_conflict and not coalesce(decision,false)) or row(new.google_base_projection,new.google_pending_write,new.google_claim_token,new.google_claim_epoch,new.google_claim_until,new.google_synced_local_revision,new.google_etag,new.google_connection_id,new.google_calendar_id,new.google_event_id)
  is distinct from row(old.google_base_projection,old.google_pending_write,old.google_claim_token,old.google_claim_epoch,old.google_claim_until,old.google_synced_local_revision,old.google_etag,old.google_connection_id,old.google_calendar_id,old.google_event_id)) then
  raise exception 'google_metadata_private' using errcode='42501';
 end if;
 changed:=row(new.starts_at,new.ends_at,new.time_zone,new.status='cancelled',new.title,new.description,new.location_kind,new.location_details,new.guest_email,new.team_guest_user_ids)
  is distinct from row(old.starts_at,old.ends_at,old.time_zone,old.status='cancelled',old.title,old.description,old.location_kind,old.location_details,old.guest_email,old.team_guest_user_ids);
 -- Única entrada que modifica base e domínio juntos é o núcleo service-only.
 -- Não há GUC ou flag no body público que suprima revisão.
 inbound:=row(new.title,new.description,new.location_kind,new.location_details,new.guest_email,new.team_guest_user_ids) is not distinct from row(old.title,old.description,old.location_kind,old.location_details,old.guest_email,old.team_guest_user_ids) and auth.uid() is null and new.google_base_projection is distinct from old.google_base_projection
  and (new.google_base_projection->'shared'->>'starts_at')::timestamptz=new.starts_at
  and (new.google_base_projection->'shared'->>'ends_at')::timestamptz=new.ends_at
  and new.google_base_projection->'shared'->>'time_zone'=new.time_zone
  and (new.google_base_projection->'shared'->>'cancelled')::boolean=(new.status='cancelled');
 new.google_local_revision:=old.google_local_revision+case when changed and not coalesce(inbound,false) then 1 else 0 end;
 if changed then new.google_next_attempt_at:=now(); end if;
 return new;
end;$$;
revoke all on function public.fn_google_projection_stamp() from public,anon,authenticated;

notify pgrst, 'reload schema';
