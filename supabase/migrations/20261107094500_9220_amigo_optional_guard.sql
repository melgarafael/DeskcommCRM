-- manifest: Manter a agenda local utilizável antes de provisionar o módulo Amigo: resolver a existência da tabela antes de preparar sua consulta.
create or replace function public.fn_amigo_protect_projection() returns trigger
language plpgsql security definer set search_path='' as $body$
declare privileged boolean := coalesce(current_setting('role',true),'none') in ('service_role','none','postgres');
begin
 if not privileged then
  if tg_op='INSERT' then
   if new.authority <> 'local' then raise exception 'amigo_remote_authority_required' using errcode='42501'; end if;
   if to_regclass('public.amigo_connections') is not null then
    if exists(select 1 from public.amigo_connections where organization_id=new.organization_id and active) then
     raise exception 'amigo_main_agenda_required' using errcode='42501';
    end if;
   end if;
  elsif tg_op='DELETE' then
   if old.authority='amigo' then raise exception 'amigo_remote_authority_required' using errcode='42501';end if;
  elsif old.authority='amigo' or new.authority is distinct from old.authority or new.external_connection_id is distinct from old.external_connection_id or new.external_status is distinct from old.external_status then
   raise exception 'amigo_remote_authority_required' using errcode='42501';
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $body$;
revoke all on function public.fn_amigo_protect_projection() from public,anon,authenticated;
grant execute on function public.fn_amigo_protect_projection() to service_role;
