-- Membros ativos ganham uma linha de disponibilidade sem publicar horários.
-- O escritório define jornada/fuso antes de oferecer horários aos clientes.
create or replace function public.fn_ensure_attendant_availability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.attendant_availability (organization_id, user_id, is_available, schedule)
  values (
    new.organization_id,
    new.user_id,
    false,
    '{}'::jsonb
  )
  on conflict (organization_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_user_organizations_attendant_availability on public.user_organizations;
create trigger trg_user_organizations_attendant_availability
  after insert or update of accepted_at, revoked_at on public.user_organizations
  for each row
  when (new.accepted_at is not null and new.revoked_at is null)
  execute function public.fn_ensure_attendant_availability();

insert into public.attendant_availability (organization_id, user_id, is_available, schedule)
select
  uo.organization_id,
  uo.user_id,
  false,
  '{}'::jsonb
from public.user_organizations uo
where uo.accepted_at is not null
  and uo.revoked_at is null
on conflict (organization_id, user_id) do nothing;
