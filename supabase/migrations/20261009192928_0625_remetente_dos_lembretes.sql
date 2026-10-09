-- manifest: remetente opcional por tipo de agendamento e avisos deduplicados de canal
-- Sem backfill: nulo preserva o automático; nunca se adivinha um número legado.
alter table public.calendar_event_types add column if not exists reminder_channel_session_id uuid;
-- Substitui também a FK da prévia deste PR em uma reaplicação.
-- A exclusão limpa só o canal: organization_id permanece obrigatório.
do $$ begin
  alter table public.calendar_event_types
    drop constraint if exists calendar_event_types_reminder_channel_org_fkey;
  alter table public.calendar_event_types add constraint calendar_event_types_reminder_channel_org_fkey
    foreign key (organization_id, reminder_channel_session_id)
    references public.channel_sessions(organization_id, id)
    on delete set null (reminder_channel_session_id) deferrable initially deferred;
end $$;
comment on column public.calendar_event_types.reminder_channel_session_id is
  'Remetente explícito dos lembretes. Nulo: conversa da reserva ou único canal elegível. Nunca troca de número se o indicado estiver indisponível.';

-- Auto-cura antes do índice em uma reaplicação após deploy parcial.
with repetidos as (
 select id, row_number() over(partition by organization_id, ref_id order by created_at, id) as n
 from public.agent_inbox_items where ref_kind='agenda_reminder_sender' and status='open'
) update public.agent_inbox_items set status='resolved', resolved_at=now()
where id in(select id from repetidos where n>1);
create unique index if not exists agent_inbox_reminder_sender_open_unique
  on public.agent_inbox_items(organization_id, ref_id)
  where ref_kind='agenda_reminder_sender' and status='open';

-- O cron fecha também o que já não entra na varredura: cancelado, vencido,
-- apagado ou com lembretes desligados. Só service_role pode fazer a limpeza global.
create or replace function public.fn_resolver_avisos_de_lembrete_expirados()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
 update public.agent_inbox_items i set status='resolved', resolved_at=now()
 where i.ref_kind='agenda_reminder_sender' and i.status='open' and not exists(
   select 1 from public.calendar_appointments a
   join public.calendar_event_types t on t.id=a.event_type_id and t.organization_id=a.organization_id
   where a.id=i.ref_id and a.organization_id=i.organization_id
     and a.status='confirmed' and a.starts_at>now() and t.reminder_enabled
 );
 get diagnostics n=row_count;
 return n;
end $$;
revoke execute on function public.fn_resolver_avisos_de_lembrete_expirados() from public, anon, authenticated;
grant execute on function public.fn_resolver_avisos_de_lembrete_expirados() to service_role;


-- A referência nova participa da anonimização sem substituir o catálogo LGPD.
create or replace function public.fn_anonimizar_aviso_de_remetente()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.agent_inbox_items set status='resolved',resolved_at=now(),body='Contato anonimizado.',ref_id=null
 where organization_id=new.organization_id and ref_kind='agenda_reminder_sender'
   and ref_id in(select id from public.calendar_appointments
     where organization_id=new.organization_id and contact_id=new.id);
 return new;
end $$;
revoke execute on function public.fn_anonimizar_aviso_de_remetente() from public, anon, authenticated, service_role;
drop trigger if exists trg_anonimizar_aviso_de_remetente on public.contacts;
create trigger trg_anonimizar_aviso_de_remetente after update of is_anonymized on public.contacts
 for each row when(new.is_anonymized and not old.is_anonymized)
 execute function public.fn_anonimizar_aviso_de_remetente();
notify pgrst,'reload schema';
