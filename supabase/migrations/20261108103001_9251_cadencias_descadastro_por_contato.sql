-- manifest: Cadências: o descadastro vale por contato, numa tabela própria que sobrevive ao negócio e à cadência apagados (com backfill), e a leitura das inscrições e dos eventos segue a visibilidade do negócio. Crédito: Marcelo (@lmarceloc).
-- Redefine a provisionadora inteira (o corpo é o schema do módulo, ADR-0002 D2)
-- e as três funções que gravam ou conferem a supressão. Quem já instalou o
-- módulo recebe a tabela e as policies novas pela chamada do fim do arquivo.

create or replace function public.fn_cadencias_provisionar()
returns void language plpgsql security definer set search_path = public, pg_temp as $f$
begin
create table if not exists public.email_cadences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  status text not null default 'rascunho',
  configuracao jsonb not null default '{}'::jsonb,
  passos jsonb not null default '[]'::jsonb,
  -- Revisão monotônica compartilhada por conteúdo/configuração/status. A API
  -- compara esta revisão ao editar/ativar: uma leitura velha não grava depois.
  versao integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_cadences_status_check check (status in ('rascunho','ativa','pausada')),
  constraint email_cadences_name_check check (btrim(name) <> ''),
  constraint email_cadences_passos_array check (jsonb_typeof(passos) = 'array'),
  constraint email_cadences_config_object check (jsonb_typeof(configuracao) = 'object')
);

create index if not exists idx_email_cadences_org_status
  on public.email_cadences (organization_id, status, updated_at desc);

comment on table public.email_cadences is
  'Cadência de e-mail (sequência por lead). configuracao/passos seguem o schema de lib/cadencias/schemas.ts.';

create table if not exists public.email_cadence_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cadence_id uuid not null references public.email_cadences(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status text not null default 'ativa',
  motivo_parada text,
  origem text not null default 'manual',
  inscrito_por uuid references auth.users(id) on delete set null,
  rastreio_consentido boolean not null default false,
  consentimento_em timestamptz,
  envio_pendente_passo_id text,
  -- Id do PRÓXIMO passo a executar (null = não há mais passos: conclui).
  passo_atual_id text,
  proximo_em timestamptz not null default now(),
  -- Trava otimista da rodada: quem reivindica a linha grava até quando é dono.
  processando_ate timestamptz,
  processamento_id uuid,
  ultimo_email_em timestamptz,
  ultimo_email_passo_id text,
  emails_enviados integer not null default 0,
  aberturas integer not null default 0,
  aberturas_ultimo_email integer not null default 0,
  cliques integer not null default 0,
  primeira_abertura_em timestamptz,
  ultima_abertura_em timestamptz,
  ultimo_clique_em timestamptz,
  tentativas integer not null default 0,
  ultimo_erro text,
  concluida_em timestamptz,
  parada_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_cadence_enrollments_status_check check (status in ('ativa','concluida','parada')),
  constraint email_cadence_enrollments_origem_check check (origem in ('manual','tag')),
  constraint email_cadence_enrollments_motivo_check check (
    motivo_parada is null or motivo_parada in (
      'respondeu','bounce','descadastro','ganho_ou_perdido','manual','sem_email','falha'
    )
  ),
  constraint email_cadence_enrollments_parada_consistente check (
    (status = 'parada') = (motivo_parada is not null)
  ),
  constraint email_cadence_enrollments_unica unique (cadence_id, lead_id)
);

alter table public.email_cadence_enrollments add column if not exists rastreio_consentido boolean not null default false;
alter table public.email_cadence_enrollments add column if not exists consentimento_em timestamptz;
alter table public.email_cadence_enrollments add column if not exists envio_pendente_passo_id text;
alter table public.email_cadence_enrollments add column if not exists aberturas_ultimo_email integer not null default 0;
alter table public.email_cadence_enrollments add column if not exists processamento_id uuid;

-- A pergunta do worker: quais inscrições ativas já venceram.
create index if not exists idx_email_cadence_enrollments_vencidas
  on public.email_cadence_enrollments (proximo_em)
  where status = 'ativa';
create index if not exists idx_email_cadence_enrollments_lead
  on public.email_cadence_enrollments (organization_id, lead_id);
create index if not exists idx_email_cadence_enrollments_cadencia
  on public.email_cadence_enrollments (cadence_id, status, created_at desc);

create table if not exists public.email_cadence_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cadence_id uuid not null references public.email_cadences(id) on delete cascade,
  enrollment_id uuid not null references public.email_cadence_enrollments(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  tipo text not null,
  passo_id text,
  ator_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint email_cadence_events_tipo_check check (tipo in (
    'inscrito','reinscrito','email_enviado','email_falhou','aberto','clicado',
    'descadastrou','ramo_sim','ramo_nao','tarefa_criada','parada','concluida','limite_diario_atingido'
  ))
);

alter table public.email_cadence_events alter column metadata drop not null;

create index if not exists idx_email_cadence_events_cadencia
  on public.email_cadence_events (cadence_id, created_at desc);
create index if not exists idx_email_cadence_events_inscricao
  on public.email_cadence_events (enrollment_id, created_at desc);

-- Supressão do descadastro por CONTATO, fora da inscrição: a inscrição cai em
-- cascata com o negócio e com a cadência, e a recusa da pessoa não pode cair
-- junto. Por isso nenhuma FK para crm_leads nem para email_cadences. Cascata
-- só de quem a torna sem sentido: a organização apagada, e o próprio contato
-- apagado — sem titular não há para quem enviar, e a FK não guarda ponteiro
-- órfão. Anonimizar não apaga o contato, então a supressão sobrevive à LGPD.
create table if not exists public.email_cadence_suppressions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  origem text not null,
  created_at timestamptz not null default now(),
  constraint email_cadence_suppressions_pkey primary key (organization_id, contact_id),
  constraint email_cadence_suppressions_origem_check check (origem in ('link','backfill'))
);

comment on table public.email_cadence_suppressions is
  'Contato que pediu para não receber cadências desta organização. Escrita só por fn_cadencia_descadastrar; lida por fn_cadencia_inscrever e fn_cadencia_reservar_envio.';

-- Backfill idempotente: descadastros gravados só na linha da inscrição viram
-- supressão do contato. Reaplicar não duplica (chave primária).
insert into public.email_cadence_suppressions (organization_id, contact_id, origem, created_at)
  select e.organization_id, e.contact_id, 'backfill', min(coalesce(e.parada_em, e.updated_at))
    from public.email_cadence_enrollments e
   where e.motivo_parada = 'descadastro'
   group by e.organization_id, e.contact_id
  on conflict (organization_id, contact_id) do nothing;

-- ═══ RLS ═══
-- Policy e ON em linhas distintas: compatibilidade real com update.sh<=v1.63.0
-- (mesmo contrato da provisionadora0619, issue1906); RLS será provada instalada.
-- SELECT das inscrições e dos eventos segue a visibilidade do NEGÓCIO
-- (fn_can_view_lead, como crm_lead_activities); a sequência, ao tenant.
-- Escrita só pelo servidor (service_role), que filtra `organization_id`
-- manualmente a partir de `requireRole()`.
alter table public.email_cadences enable row level security;
alter table public.email_cadence_enrollments enable row level security;
alter table public.email_cadence_events enable row level security;
-- Sem policy: só o servidor (service_role) lê e grava a supressão.
alter table public.email_cadence_suppressions enable row level security;

drop policy if exists email_cadences_select on public.email_cadences;
create policy email_cadences_select
  on public.email_cadences
  for select to authenticated using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists email_cadence_enrollments_select on public.email_cadence_enrollments;
create policy email_cadence_enrollments_select
  on public.email_cadence_enrollments
  for select to authenticated using (
    ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
    and exists (
      select 1 from public.crm_leads l
       where l.id = email_cadence_enrollments.lead_id
         and l.organization_id = email_cadence_enrollments.organization_id
         and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

drop policy if exists email_cadence_events_select on public.email_cadence_events;
create policy email_cadence_events_select
  on public.email_cadence_events
  for select to authenticated using (
    ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
    and exists (
      select 1 from public.crm_leads l
       where l.id = email_cadence_events.lead_id
         and l.organization_id = email_cadence_events.organization_id
         and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

revoke all on public.email_cadences from anon, authenticated;
revoke all on public.email_cadence_enrollments from anon, authenticated;
revoke all on public.email_cadence_events from anon, authenticated;
revoke all on public.email_cadence_suppressions from anon, authenticated;
grant select on public.email_cadences to authenticated;
grant select on public.email_cadence_enrollments to authenticated;
grant select on public.email_cadence_events to authenticated;
grant all on public.email_cadences to service_role;
grant all on public.email_cadence_enrollments to service_role;
grant all on public.email_cadence_events to service_role;
grant all on public.email_cadence_suppressions to service_role;

  -- Reaplicar restaura todas as proteções na mesma transação da instalação.
  perform public.fn_proteger_modulo_provisionado();

end;
$f$;
revoke execute on function public.fn_cadencias_provisionar() from public, anon, authenticated;
grant execute on function public.fn_cadencias_provisionar() to service_role;

-- Inscrição e descadastro serializam pela linha CANÔNICA do contato; a
-- supressão é conferida na tabela do contato, não nas inscrições.
create or replace function public.fn_cadencia_inscrever(p_organization_id uuid,p_cadence_id uuid,p_lead_id uuid,p_actor uuid,p_rastreio_consentido boolean)
returns jsonb language plpgsql set search_path=public,pg_temp as $inscrever$
declare v_status text; v_contato record; v_inscricao record;
begin
  if to_regclass('public.email_cadence_enrollments') is null then raise exception 'cadencia_modulo_indisponivel'; end if;
  if not exists(select 1 from public.modulos_instalados where modulo='cadencias' and estado='ativo')
    or not exists(select 1 from public.organizations where id=p_organization_id and public.fn_org_operante(id) and settings->'cadencias'->'enabled'='true'::jsonb)
    then raise exception 'cadencia_modulo_indisponivel'; end if;
  -- A pausa/exclusão espera o INSERT terminar; uma inscrição não passa pela
  -- leitura de "ativa" e só nasce depois de a pausa já ter concluído.
  select status into v_status from public.email_cadences
    where organization_id=p_organization_id and id=p_cadence_id for share;
  if not found then raise exception 'cadencia_nao_encontrada'; end if;
  if v_status <> 'ativa' then raise exception 'cadencia_estado_invalido'; end if;
  select c.* into v_contato from public.contacts c join public.crm_leads l
    on l.contact_id=c.id and l.organization_id=c.organization_id
    where l.id=p_lead_id and l.organization_id=p_organization_id and c.organization_id=p_organization_id
    for update of c;
  if not found then raise exception 'cadencia_lead_indisponivel'; end if;
  if v_contato.email is null or btrim(v_contato.email)='' then raise exception 'cadencia_sem_email'; end if;
  -- Mesmos vetos da guarda canônica: ausência de grant NÃO é recusa. Os
  -- valores não verdadeiros de JSON seguem a leitura de recusouMarketing().
  if v_contato.is_anonymized or v_contato.is_blocked or v_contato.is_personal
    or coalesce(v_contato.consent->'marketing'->'declined_at','null'::jsonb)
      not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
    then raise exception 'cadencia_contato_restrito'; end if;
  if exists(select 1 from public.email_cadence_suppressions where organization_id=p_organization_id
    and contact_id=v_contato.id) then raise exception 'cadencia_descadastrado'; end if;
  insert into public.email_cadence_enrollments(organization_id,cadence_id,lead_id,contact_id,status,origem,inscrito_por,rastreio_consentido,consentimento_em)
    values(p_organization_id,p_cadence_id,p_lead_id,v_contato.id,'ativa','manual',p_actor,coalesce(p_rastreio_consentido,false),case when p_rastreio_consentido then now() else null end)
    returning * into v_inscricao;
  insert into public.email_cadence_events(organization_id,cadence_id,enrollment_id,lead_id,tipo,ator_user_id)
    values(p_organization_id,p_cadence_id,v_inscricao.id,p_lead_id,'inscrito',p_actor);
  return jsonb_build_object('id',v_inscricao.id,'lead_id',v_inscricao.lead_id,'contact_id',v_inscricao.contact_id,
    'status',v_inscricao.status,'origem',v_inscricao.origem,'proximo_em',v_inscricao.proximo_em,'created_at',v_inscricao.created_at);
end $inscrever$;
revoke execute on function public.fn_cadencia_inscrever(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.fn_cadencia_inscrever(uuid,uuid,uuid,uuid,boolean) to service_role;

-- Última autorização do efeito: mesma trava de contato, supressão do contato
-- revalidada e propriedade do claim comparada.
create or replace function public.fn_cadencia_reservar_envio(p_organization_id uuid,p_enrollment_id uuid,p_processamento_id uuid,p_passo_id text)
returns boolean language plpgsql set search_path=public,pg_temp as $reservar$
declare v_contato record;
begin
  if to_regclass('public.email_cadence_enrollments') is null then raise exception 'cadencia_modulo_indisponivel'; end if;
  select c.* into v_contato from public.contacts c join public.email_cadence_enrollments e
    on e.contact_id=c.id and e.organization_id=c.organization_id
    where e.organization_id=p_organization_id and e.id=p_enrollment_id for update of c;
  if not found then raise exception 'cadencia_contato_restrito'; end if;
  if v_contato.is_anonymized or v_contato.is_blocked or v_contato.is_personal
    or coalesce(v_contato.consent->'marketing'->'declined_at','null'::jsonb)
      not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
    then raise exception 'cadencia_contato_restrito'; end if;
  if exists(select 1 from public.email_cadence_suppressions where organization_id=p_organization_id
    and contact_id=v_contato.id) then raise exception 'cadencia_descadastrado'; end if;
  if not exists(select 1 from public.modulos_instalados where modulo='cadencias' and estado='ativo')
    or not exists(select 1 from public.organizations where id=p_organization_id and public.fn_org_operante(id) and settings->'cadencias'->'enabled'='true'::jsonb)
    then raise exception 'cadencia_modulo_indisponivel'; end if;
  update public.email_cadence_enrollments e set envio_pendente_passo_id=p_passo_id
    where e.organization_id=p_organization_id and e.id=p_enrollment_id and e.status='ativa'
      and e.processamento_id=p_processamento_id and e.envio_pendente_passo_id is null
      and exists(select 1 from public.email_cadences c where c.organization_id=p_organization_id and c.id=e.cadence_id and c.status='ativa');
  if not found then raise exception 'cadencia_claim_lost'; end if;
  return true;
end $reservar$;
revoke execute on function public.fn_cadencia_reservar_envio(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_cadencia_reservar_envio(uuid,uuid,uuid,text) to service_role;

-- Grava a supressão do CONTATO e interrompe as inscrições ativas dele.
-- Clique repetido não cria evento nem supressão extra.
create or replace function public.fn_cadencia_descadastrar(p_enrollment_id uuid,p_organization_id uuid)
returns integer language plpgsql set search_path=public,pg_temp as $descadastro$
declare v_contato uuid; v_linha record; v_total integer := 0;
begin
  if to_regclass('public.email_cadence_enrollments') is null then return 0; end if;
  select contact_id into v_contato from public.email_cadence_enrollments
    where id=p_enrollment_id and organization_id=p_organization_id;
  if not found then return 0; end if;
  -- Mesma trava da inscrição, e da anonimização canônica do contato.
  perform 1 from public.contacts where organization_id=p_organization_id and id=v_contato for update;
  if not found then return 0; end if;
  insert into public.email_cadence_suppressions(organization_id,contact_id,origem)
    values(p_organization_id,v_contato,'link') on conflict (organization_id,contact_id) do nothing;
  for v_linha in
    update public.email_cadence_enrollments set status='parada',motivo_parada='descadastro',
      rastreio_consentido=false,processando_ate=null,processamento_id=null,parada_em=now(),updated_at=now()
    where organization_id=p_organization_id and contact_id=v_contato
      and (status='ativa' or id=p_enrollment_id) and motivo_parada is distinct from 'descadastro'
    returning id,cadence_id,lead_id
  loop
    insert into public.email_cadence_events(organization_id,cadence_id,enrollment_id,lead_id,tipo)
      values(p_organization_id,v_linha.cadence_id,v_linha.id,v_linha.lead_id,'descadastrou');
    v_total := v_total+1;
  end loop;
  return v_total;
end $descadastro$;
revoke execute on function public.fn_cadencia_descadastrar(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_cadencia_descadastrar(uuid,uuid) to service_role;

do $reaplicar$ begin
  if exists(select 1 from public.modulos_instalados where modulo='cadencias') then
    perform public.fn_cadencias_provisionar();
  end if;
end $reaplicar$;
