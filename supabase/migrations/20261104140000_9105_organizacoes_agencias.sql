-- manifest: Configuração protegida de agências e vínculo exclusivo de clientes, com autorização atual e bloqueio de hierarquia e exclusão da agência com clientes.
-- Número provisório: conferir colisão com PRs abertos antes de publicar.
create table if not exists public.agencia_configuracoes (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  habilitada boolean not null default false,
  limite_clientes integer not null default 0 check (limite_clientes between 0 and 10000)
);
create table if not exists public.agencia_clientes (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  agencia_id uuid not null references public.agencia_configuracoes(organization_id) on delete restrict,
  created_at timestamptz not null default now(),
  check (organization_id <> agencia_id)
);
create index if not exists agencia_clientes_agencia_idx on public.agencia_clientes(agencia_id);
alter table public.agencia_configuracoes enable row level security;
alter table public.agencia_clientes enable row level security;
revoke all on public.agencia_configuracoes, public.agencia_clientes from public, anon, authenticated;
grant select, insert, update, delete on public.agencia_configuracoes, public.agencia_clientes to service_role;

-- Só vínculo humano direto e aceito da agência dá autoridade. Suporte e tokens
-- não se tornam administradores de agência através do papel efetivo do cliente.
create or replace function public.fn_agencia_pode_gerir(p_agencia uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.agencia_configuracoes c
    join public.organizations o on o.id = c.organization_id
    join public.user_organizations u on u.organization_id = c.organization_id
    where c.organization_id = p_agencia and c.habilitada and o.status = 'active'
      and u.user_id = auth.uid() and u.role = 'admin'
      and u.revoked_at is null and u.accepted_at is not null
      and public.fn_support_context() is null
  );
$$;
revoke execute on function public.fn_agencia_pode_gerir(uuid) from public, anon;
grant execute on function public.fn_agencia_pode_gerir(uuid) to authenticated, service_role;
grant select on public.agencia_configuracoes, public.agencia_clientes to authenticated;
drop policy if exists agencia_configuracoes_leitura on public.agencia_configuracoes;
create policy agencia_configuracoes_leitura on public.agencia_configuracoes for select to authenticated
  using (public.fn_agencia_pode_gerir(organization_id));
drop policy if exists agencia_clientes_leitura on public.agencia_clientes;
create policy agencia_clientes_leitura on public.agencia_clientes for select to authenticated
  using (public.fn_agencia_pode_gerir(agencia_id));

-- Serializa alterações da hierarquia inteira, inclusive duas transações tentando
-- promover/vincular simultaneamente. Configuração e vínculos são pouco frequentes.
create or replace function public.fn_agencia_validar_hierarquia()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_config public.agencia_configuracoes;
begin
  perform pg_advisory_xact_lock(739021, 1);
  if tg_table_name = 'agencia_configuracoes' then
    if exists (select 1 from public.agencia_clientes where organization_id = new.organization_id) then
      raise exception 'agencia_cliente_nao_pode_ser_agencia' using errcode = '23514';
    end if;
  else
    if tg_op = 'UPDATE' then
      if new.organization_id is distinct from old.organization_id or new.agencia_id is distinct from old.agencia_id then
        raise exception 'agencia_transferencia_nao_permitida' using errcode = '23514';
      end if;
      return new;
    end if;
    select * into v_config from public.agencia_configuracoes where organization_id = new.agencia_id for update;
    if not found or not v_config.habilitada
      or not exists(select 1 from public.organizations where id = new.agencia_id and status = 'active') then
      raise exception 'agencia_indisponivel' using errcode = '23514';
    end if;
    if exists(select 1 from public.agencia_configuracoes where organization_id = new.organization_id) then
      raise exception 'agencia_nao_pode_ser_cliente' using errcode = '23514';
    end if;
    if (select count(*) from public.agencia_clientes where agencia_id = new.agencia_id) >= v_config.limite_clientes then
      raise exception 'agencia_limite_atingido' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_agencia_validar_hierarquia() from public, anon, authenticated;
grant execute on function public.fn_agencia_validar_hierarquia() to service_role;
drop trigger if exists agencia_configuracao_hierarquia on public.agencia_configuracoes;
create trigger agencia_configuracao_hierarquia before insert or update on public.agencia_configuracoes
  for each row execute function public.fn_agencia_validar_hierarquia();
drop trigger if exists agencia_cliente_hierarquia on public.agencia_clientes;
create trigger agencia_cliente_hierarquia before insert or update on public.agencia_clientes
  for each row execute function public.fn_agencia_validar_hierarquia();
