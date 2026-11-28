-- manifest: Registra o setor de entrada do canal e aplica o vínculo ao criar a conversa.
alter table public.channel_routing_policies
  add column if not exists sector_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_routing_policies'::regclass
       and conname = 'channel_routing_policies_sector_fkey'
  ) then
    alter table public.channel_routing_policies
      add constraint channel_routing_policies_sector_fkey
      foreign key (organization_id, sector_id)
      references public.attendant_sectors (organization_id, id)
      on delete set null (sector_id);
  end if;
end;
$$;

create or replace function public.fn_conversation_apply_channel_sector()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select p.sector_id into new.sector_id
    from public.channel_routing_policies p
   where p.organization_id = new.organization_id
     and p.channel_session_id = new.channel_session_id
     and p.sector_id is not null;
  return new;
end;
$$;

revoke execute on function public.fn_conversation_apply_channel_sector() from public, anon, authenticated;
grant execute on function public.fn_conversation_apply_channel_sector() to service_role;

drop trigger if exists trg_conversation_apply_channel_sector on public.conversations;
create trigger trg_conversation_apply_channel_sector
before insert on public.conversations
for each row
when (new.sector_id is null and new.channel_session_id is not null)
execute function public.fn_conversation_apply_channel_sector();

create or replace function public.fn_set_channel_routing_with_sector(
  p_org uuid, p_channel uuid, p_users uuid[], p_mode text,
  p_default_assignee uuid, p_sector uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := public.fn_set_channel_routing(
    p_org, p_channel, p_users, false, p_mode, p_default_assignee
  );

  if p_sector is not null and not exists (
    select 1 from public.attendant_sectors
     where organization_id = p_org and id = p_sector
  ) then
    raise exception 'routing_invalid_sector' using errcode = '22023';
  end if;

  update public.channel_routing_policies
     set sector_id = p_sector
   where organization_id = p_org and channel_session_id = p_channel;

  return result || jsonb_build_object('sector_id', p_sector);
end;
$$;

revoke all on function public.fn_set_channel_routing_with_sector(uuid, uuid, uuid[], text, uuid, uuid) from public, anon;
grant execute on function public.fn_set_channel_routing_with_sector(uuid, uuid, uuid[], text, uuid, uuid) to authenticated;
