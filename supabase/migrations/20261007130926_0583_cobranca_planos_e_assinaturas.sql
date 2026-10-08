-- 0583 — COBRANÇA DO REVENDEDOR, PR 2: planos e limites
--        (spec docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §1.2, §2.1-§2.7, §3.1, §5)
--
-- ── A causa ───────────────────────────────────────────────────────────────────
-- O dono de uma instalação passa a poder cobrar as empresas dela. É capacidade
-- do NÚCLEO com chave da instalação (`platform_config.MODULO_COBRANCA`, só
-- `ligado` liga), desligada por padrão (ADR-0004, D-1). As travas de pessoas e de
-- números e o teste grátis moram em tabelas do núcleo e consultam as da
-- cobrança, por isso as duas tabelas vão VAZIAS para toda instalação. Com a
-- chave desligada, os gatilhos devolvem "sem limite" e nada nasce.
--
-- ── O que muda ────────────────────────────────────────────────────────────────
-- A. `cobranca_planos` (da instalação, RLS sem policy) e `cobranca_assinaturas`
--    (uma linha por org; leitura do admin da org; escrita do service_role).
--    Org SEM linha é isenta. Saem `organizations.ai_budget_cents` e `rate_limit_rps`.
-- B. `fn_cobranca_ligada()` e `fn_limite_do_plano(org, recurso)`.
-- C. Assentos: gatilho INVOKER do vínculo provisório + gatilho DEFINER do teto (PT402).
-- D. Canais: teto de números de mensagem (PT402), na trava de fn_reserve_channel_connection.
-- E. Teste grátis na criação da org; `fn_create_tenant_with_owner` aceita `plano_id`.
-- F. Suspensão por cobrança poupa a isenta; reativar zera o aviso; desligar libera.
-- G. O aviso do teto do PLANO tem índice próprio: o da 0540 deixa de calá-lo.
--
-- Idempotente: `if not exists`, `drop policy if exists` + create, `create or
-- replace`, `drop trigger if exists` + create, `drop column if exists`. Sem
-- BEGIN/COMMIT. Toda função perde EXECUTE de public, anon e authenticated.
-- PT402 = limite do plano: MENSAGEM `limite_do_plano:<recurso>:<teto>` (é o que
-- lib/cobranca/limites.ts lê; duas camadas de canal só repassam a mensagem) e
-- DETAIL {recurso, limite, em_uso}; a rota devolve 409 plan_limit_reached.
-- Gates: tests/invariants/cobranca-*.test.ts.

-- ── A. as duas tabelas, vazias; as colunas mortas saem ───────────────────────
create table if not exists public.cobranca_planos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 60),
  preco_cents bigint not null check (preco_cents >= 500),
  moeda text not null default 'BRL' check (moeda = any (array['BRL'::text])),
  intervalo text not null check (intervalo in ('mes', 'ano')),
  trial_dias integer not null default 14 check (trial_dias between 0 and 90),
  max_assentos integer check (max_assentos >= 1),
  max_canais integer check (max_canais >= 1),
  teto_ia_usd_cents integer check (teto_ia_usd_cents >= 100),
  padrao_no_cadastro boolean not null default false,
  arquivado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.cobranca_planos is
  'Planos que o dono da instalação vende às empresas dela (migration 0583). Da INSTALAÇÃO, sem organization_id: RLS ligada sem policy, só o service_role. Limite nulo = sem limite. preco_cents >= 500 (mínimo de boleto); moeda só BRL; teto_ia_usd_cents na moeda de fn_gasto_de_ia_do_mes.';

create unique index if not exists cobranca_planos_um_padrao
  on public.cobranca_planos ((true)) where padrao_no_cadastro and arquivado_em is null;

alter table public.cobranca_planos enable row level security;
revoke all on public.cobranca_planos from anon, authenticated;
grant select, insert, update, delete on public.cobranca_planos to service_role;

drop trigger if exists trg_cobranca_planos_touch on public.cobranca_planos;
create trigger trg_cobranca_planos_touch
  before update on public.cobranca_planos
  for each row execute function public.fn_touch_updated_at();

create table if not exists public.cobranca_assinaturas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  plano_id uuid not null references public.cobranca_planos(id) on delete restrict,
  plano_agendado_id uuid references public.cobranca_planos(id) on delete restrict,
  estado text not null default 'trial' check (estado in ('trial', 'ativa', 'em_atraso', 'cancelada')),
  trial_ate timestamptz,
  provedor text check (provedor in ('stripe', 'asaas')),
  modo text check (modo in ('teste', 'producao')),
  provedor_cliente_id text,
  provedor_assinatura_id text,
  vencida_desde timestamptz,
  proximo_vencimento timestamptz,
  cancela_no_fim boolean not null default false,
  prazo_extra_ate timestamptz,
  ultimo_aviso text check (ultimo_aviso in ('trial_acabando', 'venceu', 'suspende_em_breve', 'suspensa')),
  ultimo_aviso_em timestamptz,
  checkout_url text,
  checkout_expira_em timestamptz,
  relida_em timestamptz,
  assinaturas_vivas integer not null default 0,
  ultimo_erro text check (ultimo_erro in ('credencial_invalida', 'provedor_fora', 'pagamento_de_assinatura_cancelada', 'leitura_invalida')),
  ultimo_erro_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cobranca_assinaturas_provedor_e_cliente_juntos
    check ((provedor is null) = (provedor_cliente_id is null))
);

comment on table public.cobranca_assinaturas is
  'Assinatura de cada empresa da instalação (migration 0583): uma linha por org; SEM linha = isenta de cobrança, limite e régua. estado vem da releitura do provedor, nunca do corpo do webhook; suspensa NÃO é estado daqui (fonte: organizations.status/suspended_kind). CPF/CNPJ nunca é guardado. Leitura: admin da própria org; escrita: só service_role.';
comment on column public.cobranca_assinaturas.vencida_desde is
  'Início da dívida corrente. MONOTÔNICO: só recua (least) ou zera quando o estado volta a ativa/trial; cancelar e reassinar não reinicia o relógio.';
comment on column public.cobranca_assinaturas.proximo_vencimento is
  'Fim do período pago. Só é sobrescrito por valor lido NÃO nulo.';

create unique index if not exists cobranca_assinaturas_cliente
  on public.cobranca_assinaturas (provedor, provedor_cliente_id) where provedor is not null;

alter table public.cobranca_assinaturas enable row level security;
drop policy if exists tenant_isolation_cobranca_assinaturas_select on public.cobranca_assinaturas;
create policy tenant_isolation_cobranca_assinaturas_select on public.cobranca_assinaturas
  for select to authenticated using (public.fn_role_at_least(organization_id, 'admin'));
revoke all on public.cobranca_assinaturas from anon, authenticated;
grant select on public.cobranca_assinaturas to authenticated;
grant select, insert, update, delete on public.cobranca_assinaturas to service_role;

drop trigger if exists trg_cobranca_assinaturas_touch on public.cobranca_assinaturas;
create trigger trg_cobranca_assinaturas_touch
  before update on public.cobranca_assinaturas
  for each row execute function public.fn_touch_updated_at();

-- Zero leitores em app, lib, workers, components, hooks e scripts (só os tipos);
-- nenhuma view nem função do baseline as cita (só o CREATE TABLE do dump); a
-- imagem anterior não as lê, então o rollback pelo agent.sh segue de pé.
alter table public.organizations
  drop column if exists ai_budget_cents,
  drop column if exists rate_limit_rps;

-- ── B. a chave e o limite ────────────────────────────────────────────────────
-- A régua SQL de "a cobrança está ligada": só `ligado` liga, como em
-- lib/instalacao/modulos.ts (linha ausente ou outro valor = desligada).
create or replace function public.fn_cobranca_ligada()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_config c
     where c.chave = 'MODULO_COBRANCA' and c.valor = 'ligado'
  );
$$;

revoke execute on function public.fn_cobranca_ligada() from public, anon, authenticated;
grant execute on function public.fn_cobranca_ligada() to service_role;

-- O limite do plano para um recurso. NULL = sem limite: chave desligada, org sem
-- assinatura (isenta) ou plano sem teto. O recurso é conferido ANTES da chave,
-- para um literal errado estourar em qualquer instalação. Vale o plano_id, nunca
-- o agendado (D-3). Os literais são RECURSOS_DO_PLANO (lib/cobranca/vocabulario.ts).
create or replace function public.fn_limite_do_plano(p_org uuid, p_recurso text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plano public.cobranca_planos%rowtype;
begin
  if p_recurso is null or p_recurso not in ('assentos', 'canais', 'ia_usd_cents') then
    raise exception 'recurso_do_plano_invalido' using errcode = '22023';
  end if;
  if not public.fn_cobranca_ligada() then
    return null;
  end if;
  select p.* into v_plano
    from public.cobranca_assinaturas a
    join public.cobranca_planos p on p.id = a.plano_id
   where a.organization_id = p_org;
  if not found then
    return null;
  end if;
  return case p_recurso
    when 'assentos' then v_plano.max_assentos
    when 'canais' then v_plano.max_canais
    else v_plano.teto_ia_usd_cents
  end;
end;
$$;

revoke execute on function public.fn_limite_do_plano(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_limite_do_plano(uuid, text) to service_role;

-- ── C. assentos: provisório só pelo servidor, e o teto de pessoas ────────────
-- O vínculo provisório (0237) não ocupa vaga, e fn_user_org_ids o trata como
-- membro pleno. Sem esta trava, um admin de tenant inseriria provisórios pelo
-- PostgREST (user_orgs_insert aceita admin), e cada um entraria sem contar no
-- plano. O único escritor legítimo é fn_create_tenant_with_owner.
-- INVOKER e separado do gatilho de assentos DE PROPÓSITO: numa definer,
-- current_user é o dono da função e "quem escreve?" responderia sempre postgres
-- (molde: fn_organizacao_estado_so_pelo_servidor, 0501). A sessão ainda revoga e
-- reativa o provisório existente (rotas de Equipe, cliente da sessão); o que ela
-- não faz é CRIAR um.
create or replace function public.fn_membro_provisorio_so_pelo_servidor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cria_provisorio boolean;
begin
  if current_user not in ('authenticated', 'anon') or not new.provisional_until_handover then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_cria_provisorio := true;
  else
    v_cria_provisorio := not old.provisional_until_handover
                         or new.organization_id is distinct from old.organization_id;
  end if;
  if v_cria_provisorio then
    raise exception 'membro_provisorio_so_pelo_servidor'
      using errcode = '42501',
            detail = 'Vínculo provisório nasce só por fn_create_tenant_with_owner, nunca pela sessão.';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_membro_provisorio_so_pelo_servidor() from public, anon, authenticated;

-- A coluna é da 0237. No baseline ela só é acrescentada DEPOIS da VARREDURA anon,
-- e `create trigger ... update of provisional_until_handover` exige a coluna: sem
-- esta linha a instalação nova para aqui com ON_ERROR_STOP. Idempotente.
alter table public.user_organizations
  add column if not exists provisional_until_handover boolean not null default false;

drop trigger if exists trg_membro_provisorio_so_pelo_servidor on public.user_organizations;
create trigger trg_membro_provisorio_so_pelo_servidor
  before insert or update of revoked_at, provisional_until_handover, organization_id
  on public.user_organizations
  for each row execute function public.fn_membro_provisorio_so_pelo_servidor();

-- O teto de pessoas. Conta ativo (sem revoked_at) e não provisório; convite
-- pendente não conta (D-10). Só confere quem PASSA a ocupar vaga: INSERT ativo,
-- revoked_at que volta a nulo, provisório que vira definitivo, troca de org de um
-- ativo. A trava consultiva faz duas entradas simultâneas não verem o mesmo
-- "cabe mais um". PT402; a MENSAGEM `limite_do_plano:assentos:<teto>` é o
-- contrato com lib/cobranca/limites.ts; DETAIL {recurso, limite, em_uso}.
create or replace function public.fn_trava_assentos_do_plano()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite integer;
  v_em_uso integer;
begin
  if new.revoked_at is not null or new.provisional_until_handover then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.revoked_at is null
       and not old.provisional_until_handover
       and new.organization_id is not distinct from old.organization_id then
      return new;
    end if;
  end if;

  v_limite := public.fn_limite_do_plano(new.organization_id, 'assentos');
  if v_limite is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2282));

  select count(*) into v_em_uso
    from public.user_organizations uo
   where uo.organization_id = new.organization_id
     and uo.revoked_at is null
     and not uo.provisional_until_handover
     and uo.user_id <> new.user_id;

  if v_em_uso >= v_limite then
    raise exception 'limite_do_plano:assentos:%', v_limite
      using errcode = 'PT402',
            detail = jsonb_build_object('recurso', 'assentos', 'limite', v_limite, 'em_uso', v_em_uso)::text;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_trava_assentos_do_plano() from public, anon, authenticated;

drop trigger if exists trg_trava_assentos_do_plano on public.user_organizations;
create trigger trg_trava_assentos_do_plano
  before insert or update of revoked_at, provisional_until_handover, organization_id
  on public.user_organizations
  for each row execute function public.fn_trava_assentos_do_plano();

-- ── D. canais de mensagem: o teto de números conectados ──────────────────────
-- Conta canal NÃO arquivado que não seja `wacalls` (voz; a lista de mensagem é
-- PROVIDERS_DE_MENSAGEM em lib/channels/capabilities.ts). A trava consultiva é
-- a MESMA de fn_reserve_channel_connection (hashtextextended(org, 2281)):
-- reserva e inserção direta nunca contam ao mesmo tempo. Dentro da reserva a
-- trava já é da própria transação, e travas consultivas são reentrantes.
-- Um UPDATE que regrava archived_at = null num canal JÁ ativo (a reconexão de
-- savePartnerSession/reactivateChannelSession) sai na guarda de transição.
-- Essa guarda NÃO é intercambiável com o `cs.id <> new.id` da contagem: numa
-- org que já está ACIMA do teto (chave ligada sobre orgs existentes, ou
-- downgrade), os OUTROS canais já somam o teto, e só a guarda impede que a
-- reconexão de um número no ar vire PT402. O `cs.id <> new.id` serve a quem
-- entra de verdade (desarquivar, trocar provider ou org): não conta o próprio.
create or replace function public.fn_trava_canais_do_plano()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite integer;
  v_em_uso integer;
begin
  if new.archived_at is not null or new.provider = 'wacalls' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.archived_at is null
       and old.provider <> 'wacalls'
       and new.organization_id is not distinct from old.organization_id then
      return new;
    end if;
  end if;

  v_limite := public.fn_limite_do_plano(new.organization_id, 'canais');
  if v_limite is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2281));

  select count(*) into v_em_uso
    from public.channel_sessions cs
   where cs.organization_id = new.organization_id
     and cs.archived_at is null
     and cs.provider <> 'wacalls'
     and cs.id <> new.id;

  if v_em_uso >= v_limite then
    raise exception 'limite_do_plano:canais:%', v_limite
      using errcode = 'PT402',
            detail = jsonb_build_object('recurso', 'canais', 'limite', v_limite, 'em_uso', v_em_uso)::text;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_trava_canais_do_plano() from public, anon, authenticated;

drop trigger if exists trg_trava_canais_do_plano on public.channel_sessions;
create trigger trg_trava_canais_do_plano
  before insert or update of archived_at, provider, organization_id
  on public.channel_sessions
  for each row execute function public.fn_trava_canais_do_plano();

-- ── E. teste grátis na criação; plano no novo tenant ─────────────────────────
-- A org que NASCE pelo cadastro ganha trial com os dias do plano do cadastro
-- quando: chave ligada; plano do cadastro vigente; a org tem autor; o autor não
-- é platform admin ativo. Como a 0501 recusa INSERT de organização pela sessão,
-- created_by só vem de rota de servidor (lib/auth/provision.ts grava o autor).
create or replace function public.fn_trial_na_criacao_da_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plano_id   uuid;
  v_trial_dias integer;
begin
  if new.created_by is null or not public.fn_cobranca_ligada() then
    return null;
  end if;
  if exists (select 1 from public.platform_admins pa
              where pa.user_id = new.created_by and pa.revoked_at is null) then
    return null;
  end if;
  select p.id, p.trial_dias into v_plano_id, v_trial_dias
    from public.cobranca_planos p
   where p.padrao_no_cadastro and p.arquivado_em is null;
  if v_plano_id is null then
    return null;
  end if;
  insert into public.cobranca_assinaturas (organization_id, plano_id, estado, trial_ate)
  values (new.id, v_plano_id, 'trial', now() + make_interval(days => v_trial_dias))
  on conflict (organization_id) do nothing;
  return null;
end;
$$;

revoke execute on function public.fn_trial_na_criacao_da_org() from public, anon, authenticated;

drop trigger if exists trg_trial_na_criacao_da_org on public.organizations;
create trigger trg_trial_na_criacao_da_org
  after insert on public.organizations
  for each row execute function public.fn_trial_na_criacao_da_org();

-- O tenant criado pelo dono recebe o plano do formulário (plano_id). Corpo da
-- 0237 + as linhas da 0583. settings.plan segue gravado como antes.
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
  v_plano_id uuid;
  v_trial_dias integer;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;

  -- 0583: plano da cobrança do revendedor. Com a chave desligada o formulário não
  -- oferece plano; um plano_id que chegue assim é recusado, em vez de criar uma
  -- assinatura que nenhuma régua lê. Validado DEPOIS da autorização.
  v_plano_id := nullif(p_request->>'plano_id', '')::uuid;
  if v_plano_id is not null then
    if not public.fn_cobranca_ligada() then
      raise exception 'cobranca_desligada' using errcode = '22023';
    end if;
    select p.trial_dias into v_trial_dias
      from public.cobranca_planos p
     where p.id = v_plano_id and p.arquivado_em is null;
    if not found then
      raise exception 'plano_invalido' using errcode = '22023';
    end if;
  end if;

  -- A MESMA comparação que já decidia `interface_settings`, agora com nome e
  -- guardada. Era ela que sabia a resposta e não a anotava em lugar nenhum.
  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active',
      -- 0583: com a cobrança ligada a rota não manda `plan`; sem esta guarda a org
      -- nasceria com {"plan": null} e o rótulo antigo apareceria como "—".
      case when p_request ? 'plan' then jsonb_build_object('plan', p_request->>'plan') else '{}'::jsonb end,
      p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);
  -- 0583: a assinatura nasce na MESMA transação da organização.
  if v_plano_id is not null then
    insert into public.cobranca_assinaturas (organization_id, plano_id, estado, trial_ate)
      values (org.id, v_plano_id, 'trial', now() + make_interval(days => v_trial_dias));
  end if;
  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;

revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;

-- ── F. suspensão por cobrança: isenta não é suspensa; reativar zera o aviso ─
-- create or replace das duas funções da 0501 (corpo VIGENTE da 0501 + linhas
-- 0583). Na PR 1 elas não citavam cobranca_assinaturas, que ainda não existia
-- (plpgsql resolve a relação ao executar: 42P01 em toda chamada). A reativação
-- também passa a contar, no aviso e no evento, o que a suspensão parou sem
-- avisar (acabamento 22 da PR 1). fn_org_parada_descarta_fila e a C0a
-- (fn_followup_turno_descartado) seguem as da 0501.
create or replace function public.fn_suspender_organizacao(
  p_org uuid, p_kind text, p_motivo text, p_ator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_kind   text;
begin
  if p_kind is null or p_kind not in ('administrativa', 'cobranca') then
    raise exception 'tipo_de_suspensao_invalido' using errcode = '22023';
  end if;

  select o.status, coalesce(o.suspended_kind, 'administrativa')
    into v_status, v_kind
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if v_status = 'suspended' then
    if v_kind = p_kind then
      return jsonb_build_object('changed', false, 'motivo', 'ja_suspensa');
    end if;
    if p_kind = 'cobranca' then
      return jsonb_build_object('changed', false, 'motivo', 'administrativa_prevalece');
    end if;
    -- cobranca → administrativa: troca o tipo e mantém o início da suspensão.
    update public.organizations
       set suspended_kind = 'administrativa',
           suspended_reason = p_motivo,
           suspended_by = p_ator
     where id = p_org;
  elsif v_status = 'active' then
    -- 0583: org sem assinatura é isenta; a régua nunca a suspende por cobrança.
    if p_kind = 'cobranca'
       and not exists (select 1 from public.cobranca_assinaturas a where a.organization_id = p_org) then
      return jsonb_build_object('changed', false, 'motivo', 'org_isenta');
    end if;
    update public.organizations
       set status = 'suspended',
           suspended_kind = p_kind,
           suspended_reason = p_motivo,
           suspended_at = now(),
           suspended_by = p_ator
     where id = p_org;
  else
    -- redacted / archived: inalterados, já não operam.
    return jsonb_build_object('changed', false, 'motivo', 'org_encerrada');
  end if;

  perform public.fn_org_parada_descarta_fila(p_org);

  update public.messages
     set status = 'failed', error_code = 'org_suspensa'
   where organization_id = p_org and status = 'queued';

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (p_org, 'tenant.suspended', 'organization', p_org,
          jsonb_build_object('tenant_id', p_org, 'kind', p_kind,
                             'suspended_by', p_ator, 'reason', p_motivo));

  return jsonb_build_object('changed', true);
end;
$$;

revoke execute on function public.fn_suspender_organizacao(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_suspender_organizacao(uuid, text, text, uuid) to service_role;

create or replace function public.fn_reativar_organizacao(
  p_org uuid, p_kind_exigido text, p_ator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status    text;
  v_kind      text;
  v_desde     timestamptz;
  v_conversas integer := 0;
  -- 0583 (acabamento 22 da PR 1): o que a suspensão parou sem avisar ninguém.
  v_ultima_volta timestamptz;
  v_agendamentos integer := 0;
  v_passos       integer := 0;
begin
  if p_kind_exigido is null or p_kind_exigido not in ('administrativa', 'cobranca') then
    raise exception 'tipo_de_suspensao_invalido' using errcode = '22023';
  end if;

  select o.status, coalesce(o.suspended_kind, 'administrativa'), o.suspended_at
    into v_status, v_kind, v_desde
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if v_status <> 'suspended' then
    return jsonb_build_object('changed', false, 'motivo', 'nao_suspensa');
  end if;
  if v_kind <> p_kind_exigido then
    return jsonb_build_object('changed', false, 'motivo',
      case v_kind when 'cobranca' then 'suspensao_de_cobranca' else 'suspensao_administrativa' end);
  end if;

  update public.organizations
     set status = 'active',
         suspended_kind = null,
         suspended_at = null,
         suspended_reason = null,
         suspended_by = null
   where id = p_org;

  perform public.fn_org_parada_descarta_fila(p_org);

  if v_desde is not null then
    select count(*) into v_conversas
      from public.conversations c
     where c.organization_id = p_org
       and not c.is_group
       and c.last_inbound_at >= v_desde;

    -- 0583: disparo único que venceu com a org parada e que o scheduler
    -- DESLIGOU (lib/agent-engine/cron/scheduler.ts: `enabled = false,
    -- last_error = 'org_nao_operante'`). O recorrente só é adiado e segue vivo.
    -- Só `followup_turn`: é o mesmo recorte da fila de IA › Follow-ups
    -- (app/api/v1/ai/followups/queue/route.ts), para onde o aviso manda; um
    -- disparo único de outro job_kind seria contado e não apareceria em tela.
    select count(*) into v_agendamentos
      from public.cron_jobs cj
     where cj.organization_id = p_org
       and cj.kind = 'at'
       and cj.job_kind = 'followup_turn'
       and not cj.enabled
       and cj.last_error = 'org_nao_operante'
       and cj.updated_at >= v_desde;
  end if;

  -- 0583: turno de follow-up falhado pela parada SEM `turn_discarded`. O de
  -- envio com o evento o motor refaz sozinho (C0a); classificar resposta e
  -- planejar horário não têm evento, e o efeito depende do nó. `job_queue` não
  -- tem `updated_at`: a janela é "criado depois da volta anterior", porque o que
  -- estava na fila numa volta anterior já foi falhado e contado nela. Lido ANTES
  -- de gravar o `tenant.reactivated` desta volta.
  select max(e.created_at) into v_ultima_volta
    from public.event_log e
   where e.organization_id = p_org and e.event_type = 'tenant.reactivated';
  select count(*) into v_passos
    from public.job_queue j
   where j.organization_id = p_org
     and j.kind = 'followup_turn'
     and j.status = 'failed'
     and j.last_error = 'org_nao_operante'
     and j.created_at > coalesce(v_ultima_volta, '-infinity'::timestamptz)
     and not exists (
       select 1 from public.followup_enrollment_events ev
        where ev.organization_id = p_org
          and ev.event_type = 'turn_discarded'
          and ev.payload->>'job_id' = j.id::text);

  if v_conversas + v_agendamentos + v_passos > 0 then
    insert into public.agent_inbox_items (organization_id, kind, severity, title, body)
    values (p_org, 'org_reativada', 'warn',
            -- 0583: sem conversa, o título não promete conversa.
            case when v_conversas > 0
              then 'A conta foi reativada — há conversas para revisar'
              else 'A conta foi reativada — há agendamentos e follow-ups para revisar'
            end,
            -- Só o fato: o que fazer é a orientação do aviso na tela
            -- (lib/ai/inbox-destino.ts, org_reativada), que sabe das abas.
            -- 0583: concat_ws pula o nulo; só conversas = o texto da 0501, byte a byte.
            concat_ws(' ',
              case when v_conversas = 1
                then '1 conversa recebeu mensagem enquanto a conta estava suspensa.'
                when v_conversas > 1
                then format('%s conversas receberam mensagem enquanto a conta estava suspensa.', v_conversas)
              end,
              case when v_agendamentos = 1
                then '1 agendamento de disparo único venceu durante a suspensão e não foi disparado.'
                when v_agendamentos > 1
                then format('%s agendamentos de disparo único venceram durante a suspensão e não foram disparados.', v_agendamentos)
              end,
              case when v_passos = 1
                then '1 passo de follow-up foi descartado durante a suspensão; confira o follow-up do contato.'
                when v_passos > 1
                then format('%s passos de follow-up foram descartados durante a suspensão; confira o follow-up dos contatos.', v_passos)
              end));
  end if;

  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload)
  values (p_org, 'tenant.reactivated', 'organization', p_org,
          jsonb_build_object('tenant_id', p_org, 'kind', v_kind,
                             'reactivated_by', p_ator, 'conversas_com_mensagem', v_conversas,
                             -- 0583
                             'agendamentos_desligados', v_agendamentos, 'passos_descartados', v_passos));

  -- 0583, passo 7: a régua recomeça; um aviso da dívida anterior não vale para a próxima.
  update public.cobranca_assinaturas
     set ultimo_aviso = null, ultimo_aviso_em = null
   where organization_id = p_org;

  return jsonb_build_object('changed', true);
end;
$$;

revoke execute on function public.fn_reativar_organizacao(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_reativar_organizacao(uuid, text, uuid) to service_role;

-- Desligar a chave (§7h) libera toda org suspensa por cobrança pela MESMA porta
-- de reativação: item na Central, evento e aviso zerado. Nada é cancelado no
-- provedor. Devolve quantas reativou. E fecha o aviso do teto de IA do PLANO de
-- toda org: com a chave desligada o gate do LLM nem lê o teto, então ninguém mais
-- o fecharia, e ele afirmaria uma parada que não existe mais.
create or replace function public.fn_cobranca_liberar_suspensoes(p_ator uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org       uuid;
  v_liberadas integer := 0;
begin
  for v_org in
    select o.id from public.organizations o
     where o.status = 'suspended' and o.suspended_kind = 'cobranca'
     order by o.id
  loop
    if (public.fn_reativar_organizacao(v_org, 'cobranca', p_ator)->>'changed')::boolean then
      v_liberadas := v_liberadas + 1;
    end if;
  end loop;
  update public.agent_inbox_items set status = 'resolved'
   where kind = 'budget_exceeded' and ref_kind = 'plano' and status = 'open';
  return v_liberadas;
end;
$$;

revoke execute on function public.fn_cobranca_liberar_suspensoes(uuid) from public, anon, authenticated;
grant execute on function public.fn_cobranca_liberar_suspensoes(uuid) to service_role;

-- ── G. o aviso do teto do plano não é calado pelo do orçamento ────────────────
-- A 0540 pôs um índice único parcial em (organization_id, kind) para os dois
-- kinds de orçamento. O teto do PLANO abre o MESMO kind `budget_exceeded`, com
-- `ref_kind = 'plano'` (lib/agent-engine/edge/llm/orcamento.ts): com aquele
-- índice, o aviso do plano e o do orçamento da org se excluíam — quem chegasse
-- primeiro calava o outro (o insert do engine é `on conflict do nothing`), e a
-- Central explicava a parada da IA pela causa errada, com o remédio errado.
--
-- Duas famílias, dois índices: o da 0540 passa a excluir `ref_kind = 'plano'`
-- (o resto — `ai_budget` e o nulo das linhas antigas — é a família do
-- orçamento, a mesma régua de SQL_ORCAMENTO), e o do plano é um por org. Nada
-- a deduplicar antes: com o índice da 0540 no lugar, nenhum par de linhas
-- abertas do mesmo kind existe, e as do plano só nascem depois desta migration.
-- O `do` troca o índice só quando a definição ainda é a da 0540: reaplicar não
-- derruba nada.
do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'agent_inbox_budget_aberto_unico'
       and indexdef not like '%plano%'
  ) then
    drop index public.agent_inbox_budget_aberto_unico;
  end if;
end $$;

create unique index if not exists agent_inbox_budget_aberto_unico
  on public.agent_inbox_items (organization_id, kind)
  where status = 'open' and kind in ('budget_exceeded','budget_warning')
    and ref_kind is distinct from 'plano';

create unique index if not exists agent_inbox_budget_do_plano_aberto_unico
  on public.agent_inbox_items (organization_id)
  where status = 'open' and kind = 'budget_exceeded' and ref_kind = 'plano';
