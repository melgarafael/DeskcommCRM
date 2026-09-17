-- A rede social não pode ser NULL: CHECK aceita UNKNOWN, por isso IN não basta.
alter table public.channel_sessions drop constraint if exists channel_sessions_social_network_required;
alter table public.channel_sessions add constraint channel_sessions_social_network_required
 check(provider <> 'socios_hub' or social_network is not null);

-- Identidade social participa da mesma transação de anonimização do contato.
-- Não se altera a função canônica de LGPD: o trigger cobre também seus chamadores.
create or replace function public.fn_redact_social_identity() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.messages set external_id=null
 where organization_id=new.organization_id and conversation_id in(
   select id from public.conversations where organization_id=new.organization_id
    and contact_id=new.id and channel in('instagram','messenger')
 );
 update public.conversations set provider_recipient_id=null,provider_conversation_id=null
 where organization_id=new.organization_id and contact_id=new.id
   and channel in('instagram','messenger');
 return new;
end; $$;
revoke execute on function public.fn_redact_social_identity() from public,anon,authenticated;
grant execute on function public.fn_redact_social_identity() to service_role;
drop trigger if exists trg_redact_social_identity on public.contacts;
create trigger trg_redact_social_identity after update of is_anonymized on public.contacts
 for each row when(new.is_anonymized and not old.is_anonymized)
 execute function public.fn_redact_social_identity();
