-- manifest: Ativacao isolada do nascimento Meta por organizacao, com corte no relogio do banco. Coluna propria impede que outros escritores de organizations.settings restaurem uma ativacao antiga.
-- Null significa desligado. Nenhum dado antigo recebe backfill.
alter table public.organizations
  add column if not exists meta_lead_birth_enabled_at timestamptz;
comment on column public.organizations.meta_lead_birth_enabled_at is
  'Null desliga LeadSubmitted causal. Cada ativacao troca o corte pelo horario do banco; reativar nao envia cliques antigos.';

create or replace function public.fn_definir_meta_lead_birth(p_org uuid, p_enabled boolean)
returns timestamptz language plpgsql set search_path = '' as $$
declare
  v_ativada_em timestamptz;
begin
  if p_org is null or p_enabled is null then
    raise exception 'meta_lead_birth_invalid_input' using errcode = '22023';
  end if;

  update public.organizations
     set meta_lead_birth_enabled_at = case when p_enabled then clock_timestamp() else null end
   where id = p_org
   returning meta_lead_birth_enabled_at into v_ativada_em;
  if not found then
    raise exception 'meta_lead_birth_org_not_found' using errcode = '22023';
  end if;
  return v_ativada_em;
end;
$$;
revoke execute on function public.fn_definir_meta_lead_birth(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_definir_meta_lead_birth(uuid, boolean) to service_role;
notify pgrst, 'reload schema';
