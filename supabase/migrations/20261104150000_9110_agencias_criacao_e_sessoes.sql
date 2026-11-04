-- manifest: Criação atômica e sessões delegadas de agência com revalidação de autoridade, separadas da administração global.
create table if not exists public.agencia_sessoes (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 agencia_id uuid not null references public.agencia_configuracoes(organization_id) on delete restrict,
 actor_user_id uuid not null references auth.users(id) on delete cascade,
 auth_session_id uuid not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now()+interval '1 hour'),
 ended_at timestamptz
);
create unique index if not exists agencia_sessoes_aberta_idx on public.agencia_sessoes(auth_session_id) where ended_at is null;
alter table public.agencia_sessoes enable row level security;
revoke all on public.agencia_sessoes from public,anon,authenticated;
grant select,insert,update,delete on public.agencia_sessoes to service_role;

-- Esta função privada NÃO usa contexto delegado; evita recursão e promoção indireta.
create or replace function public.fn_agencia_autoridade(p_actor uuid,p_agencia uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from agencia_configuracoes c
 join organizations o on o.id=c.organization_id
 join user_organizations u on u.organization_id=o.id
 where c.organization_id=p_agencia and c.habilitada and o.status='active'
 and u.user_id=p_actor and u.role='admin' and u.accepted_at is not null and u.revoked_at is null);
$$;
revoke all on function public.fn_agencia_autoridade(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_agencia_autoridade(uuid,uuid) to service_role;

create or replace function public.fn_platform_support_context()
returns jsonb language sql stable security definer set search_path = public as $f$
 select jsonb_build_object('id', s.id, 'organization_id', s.organization_id,
 'actor_user_id', s.actor_user_id, 'auth_session_id', s.auth_session_id,
 'previous_organization_id', s.previous_organization_id, 'expires_at', s.expires_at,
 'name', o.display_name, 'locale', o.locale,
 'access_mode', case when s.access_mode = 'support_readonly' or p.scope <> 'full'
 then 'support_readonly' else 'full' end,
 'status', case when s.expires_at <= now() then 'expired'
 when p.user_id is null or a.id is null or (a.not_after is not null and a.not_after <= now())
 or o.status <> 'active' then 'revoked'
 when (p.mfa_required or exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified'))
 and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then 'revoked'
 else 'active' end)
 from public.platform_support_sessions s
 join public.organizations o on o.id=s.organization_id
 left join public.platform_admins p on p.user_id=s.actor_user_id and p.revoked_at is null
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 where s.actor_user_id=auth.uid()
 and s.auth_session_id=nullif(auth.jwt()->>'session_id','')::uuid and s.ended_at is null
 limit 1;
$f$;
revoke all on function public.fn_platform_support_context() from public,anon,authenticated;
grant execute on function public.fn_platform_support_context() to service_role;

create or replace function public.fn_support_context()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(public.fn_platform_support_context(),(
 select jsonb_build_object('id',s.id,'organization_id',s.organization_id,'agency_id',s.agencia_id,
 'actor_user_id',s.actor_user_id,'auth_session_id',s.auth_session_id,
 'previous_organization_id',s.agencia_id,'expires_at',s.expires_at,'name',o.display_name,
 'locale',o.locale,'access_mode','full','status',case
 when s.expires_at<=now() then 'expired'
 when not public.fn_agencia_autoridade(s.actor_user_id,s.agencia_id)
 or a.id is null or (a.not_after is not null and a.not_after<=now()) or o.status<>'active'
 or not exists(select 1 from agencia_clientes c where c.organization_id=s.organization_id and c.agencia_id=s.agencia_id)
 or (exists(select 1 from auth.mfa_factors f where f.user_id=s.actor_user_id and f.status='verified') and coalesce(auth.jwt()->>'aal','aal1')<>'aal2')
 then 'revoked' else 'active' end)
 from agencia_sessoes s join organizations o on o.id=s.organization_id
 left join auth.sessions a on a.id=s.auth_session_id and a.user_id=s.actor_user_id
 where s.actor_user_id=auth.uid() and s.auth_session_id=nullif(auth.jwt()->>'session_id','')::uuid
 and s.ended_at is null limit 1));
$$;
revoke all on function public.fn_support_context() from public,anon;
grant execute on function public.fn_support_context() to authenticated,service_role;

create or replace function public.fn_agencia_abrir_cliente(p_agencia uuid,p_cliente uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
begin
 perform 1 from auth.sessions where id=v_session and user_id=auth.uid()
 and (not_after is null or not_after>now()) for update;
 if not found or not public.fn_agencia_autoridade(auth.uid(),p_agencia) then
 raise exception 'agencia_acesso_negado' using errcode='42501'; end if;
 if public.fn_support_context() is not null then raise exception 'encerre_acompanhamento' using errcode='PT409'; end if;
 if exists(select 1 from auth.mfa_factors where user_id=auth.uid() and status='verified')
 and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required' using errcode='42501'; end if;
 if not exists(select 1 from agencia_clientes c join organizations o on o.id=c.organization_id
 where c.agencia_id=p_agencia and c.organization_id=p_cliente and o.status='active') then
 raise exception 'agencia_cliente_indisponivel' using errcode='42501'; end if;
 insert into agencia_sessoes(organization_id,agencia_id,actor_user_id,auth_session_id)
 values(p_cliente,p_agencia,auth.uid(),v_session) returning id into v_id;
 return v_id;
end; $$;
revoke all on function public.fn_agencia_abrir_cliente(uuid,uuid) from public,anon;
grant execute on function public.fn_agencia_abrir_cliente(uuid,uuid) to authenticated;

create or replace function public.fn_agencia_encerrar_sessao()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.agencia_sessoes;
begin
 update agencia_sessoes set ended_at=now() where actor_user_id=auth.uid()
 and auth_session_id=nullif(auth.jwt()->>'session_id','')::uuid and ended_at is null returning * into s;
 return to_jsonb(s);
end; $$;
revoke all on function public.fn_agencia_encerrar_sessao() from public,anon;
grant execute on function public.fn_agencia_encerrar_sessao() to authenticated;

-- Nunca transformar o acesso delegado em convite, membership ou credencial permanente.
create or replace function public.fn_agencia_barrar_acesso_permanente()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if public.fn_support_context()->>'agency_id' is not null then
 raise exception 'agencia_acesso_permanente_recusado' using errcode='42501'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;
revoke all on function public.fn_agencia_barrar_acesso_permanente() from public,anon,authenticated;
grant execute on function public.fn_agencia_barrar_acesso_permanente() to service_role;
do $guard$
declare t text;
begin
 foreach t in array array['user_organizations','team_invites','api_tokens','platform_admins'] loop
 if to_regclass('public.'||t) is not null then
 execute format('drop trigger if exists agencia_acesso_permanente on public.%I',t);
 execute format('create trigger agencia_acesso_permanente before insert or update or delete on public.%I for each row execute function public.fn_agencia_barrar_acesso_permanente()',t);
 end if;
 end loop;
end; $guard$;
-- Recibo exclusivo da agência: a chave nunca cruza organizações nem pessoas.
create table if not exists public.agencia_criacoes (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 actor_user_id uuid not null references auth.users(id) on delete cascade,
 chave uuid not null,
 pedido jsonb not null,
 cliente_id uuid not null references public.organizations(id) on delete restrict,
 primary key(organization_id,actor_user_id,chave)
);
alter table public.agencia_criacoes enable row level security;
revoke all on public.agencia_criacoes from public,anon,authenticated;
grant select,insert on public.agencia_criacoes to service_role;
create or replace function public.fn_agencia_criar_cliente(p_agencia uuid,p_chave uuid,p_nome text,p_slug text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_recibo public.agencia_criacoes; v_pedido jsonb;
begin
 -- Mesma ordem de lock da hierarquia; habilitação, cota e criação se serializam.
 perform pg_advisory_xact_lock(739021,1);
 perform 1 from agencia_configuracoes where organization_id=p_agencia for update;
 if not public.fn_agencia_pode_gerir(p_agencia) then raise exception 'agencia_acesso_negado' using errcode='42501'; end if;
 if p_chave is null or p_nome is null or length(btrim(p_nome)) not between 2 and 120
 or p_slug is null or length(p_slug) not between 2 and 40 or p_slug !~ '^[a-z0-9-]+$' then
 raise exception 'agencia_cadastro_invalido' using errcode='22023'; end if;
 if exists(select 1 from auth.mfa_factors where user_id=auth.uid() and status='verified')
 and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'mfa_required' using errcode='42501'; end if;
 v_pedido:=jsonb_build_object('display_name',btrim(p_nome),'slug',p_slug);
 select * into v_recibo from agencia_criacoes where organization_id=p_agencia and actor_user_id=auth.uid() and chave=p_chave;
 if found then
 if v_recibo.pedido<>v_pedido then raise exception 'agencia_chave_divergente' using errcode='PT409'; end if;
 return jsonb_build_object('id',v_recibo.cliente_id,'created',false);
 end if;
 -- Cliente gerido pela agência não ganha assinatura/isencão por escolha de usuário.
 -- Até existir política comercial explícita, cobrança ativa exige criação pela plataforma.
 if public.fn_cobranca_ligada() then raise exception 'agencia_cobranca_exige_plataforma' using errcode='PT409'; end if;
 insert into organizations(display_name,legal_name,slug,status,settings,created_by)
 values(btrim(p_nome),btrim(p_nome),p_slug,'active','{}'::jsonb,auth.uid()) returning id into v_id;
 insert into agencia_clientes(organization_id,agencia_id) values(v_id,p_agencia);
 insert into agencia_criacoes values(p_agencia,auth.uid(),p_chave,v_pedido,v_id);
 return jsonb_build_object('id',v_id,'created',true);
end; $$;
revoke all on function public.fn_agencia_criar_cliente(uuid,uuid,text,text) from public,anon;
grant execute on function public.fn_agencia_criar_cliente(uuid,uuid,text,text) to authenticated;
