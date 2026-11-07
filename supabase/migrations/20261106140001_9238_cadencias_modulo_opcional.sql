-- manifest: Cadências de e-mail do PR1738 entram como módulo opcional oficial (doc75B, ADR0002), desligadas até instalação e escolha da empresa; tabelas nascem só na provisionadora fixa, com RLS/grants e LGPD, abertura com consentimento e descadastro sem sessão. Crédito: Marcelo (@lmarceloc).
-- A migration entrega funções, não tabelas para toda instalação. Não modifica MANIFEST histórico.
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

-- ═══ RLS ═══
-- Policy e ON em linhas distintas: compatibilidade real com update.sh<=v1.63.0
-- (mesmo contrato da provisionadora0619, issue1906); RLS será provada instalada.
-- SELECT aberto ao tenant; escrita só pelo servidor (service_role), que filtra
-- `organization_id` manualmente a partir de `requireRole()`.
alter table public.email_cadences enable row level security;
alter table public.email_cadence_enrollments enable row level security;
alter table public.email_cadence_events enable row level security;

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
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists email_cadence_events_select on public.email_cadence_events;
create policy email_cadence_events_select
  on public.email_cadence_events
  for select to authenticated using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

revoke all on public.email_cadences from anon, authenticated;
revoke all on public.email_cadence_enrollments from anon, authenticated;
revoke all on public.email_cadence_events from anon, authenticated;
grant select on public.email_cadences to authenticated;
grant select on public.email_cadence_enrollments to authenticated;
grant select on public.email_cadence_events to authenticated;
grant all on public.email_cadences to service_role;
grant all on public.email_cadence_enrollments to service_role;
grant all on public.email_cadence_events to service_role;

  -- Reaplicar restaura todas as proteções na mesma transação da instalação.
  perform public.fn_proteger_modulo_provisionado();

end;
$f$;
revoke execute on function public.fn_cadencias_provisionar() from public, anon, authenticated;
grant execute on function public.fn_cadencias_provisionar() to service_role;

-- Registro declarativo existe sem instalar as tabelas (D8/0619). A cascata
-- consulta to_regclass e só alcança o módulo quando ele está instalado.
insert into public.modulo_secoes_lgpd (modulo,tabela,ligacao,colunas,colunas_rotulo)
  values
    ('cadencias','email_cadence_enrollments','organization_id = $1 and contact_id = $2',array['ultimo_erro'],'{}'::text[]),
    ('cadencias','email_cadence_events','organization_id = $1 and enrollment_id in (select id from public.email_cadence_enrollments where organization_id = $1 and contact_id = $2)',array['metadata'],'{}'::text[])
  on conflict (modulo,tabela) do update set ligacao=excluded.ligacao,colunas=excluded.colunas,colunas_rotulo=excluded.colunas_rotulo;

-- Escrita atômica da chave da empresa; não sobrescreve routing/branding etc.
create or replace function public.fn_cadencias_configurar(p_organization_id uuid,p_enabled boolean)
returns boolean language plpgsql set search_path=public,pg_temp as $configurar$
begin
  if p_enabled is null then raise exception 'cadencia_invalid_configuration'; end if;
  update public.organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{cadencias}',
    (case when jsonb_typeof(settings->'cadencias')='object' then settings->'cadencias' else '{}'::jsonb end)
      || jsonb_build_object('enabled',p_enabled),true)
    where id=p_organization_id;
  return found;
end $configurar$;
revoke execute on function public.fn_cadencias_configurar(uuid,boolean) from public,anon,authenticated;
grant execute on function public.fn_cadencias_configurar(uuid,boolean) to service_role;

-- Inscrição e descadastro serializam pela linha CANÔNICA do contato. Assim a
-- supressão não é uma leitura solta antes de um INSERT em outra transação.
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
  if exists(select 1 from public.email_cadence_enrollments where organization_id=p_organization_id
    and contact_id=v_contato.id and motivo_parada='descadastro') then raise exception 'cadencia_descadastrado'; end if;
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

-- Claim do lote com snapshot DEVOLVIDO PELO UPDATE, não o SELECT anterior do
-- chamador. SKIP LOCKED e ordem estável seguem as filas canônicas do produto.
-- Empresas/cadências desligadas saem ANTES do LIMIT: não tomam o lugar das ativas.
create or replace function public.fn_cadencias_reivindicar(p_agora timestamptz)
returns jsonb language plpgsql set search_path=public,pg_temp as $reivindicar$
declare v_lote jsonb;
begin
  if p_agora is null then raise exception 'cadencia_invalid_clock'; end if;
  if to_regclass('public.email_cadence_enrollments') is null
    or not exists(select 1 from public.modulos_instalados where modulo='cadencias' and estado='ativo') then return '[]'::jsonb; end if;
  with prontas as materialized (
    select e.id from public.email_cadence_enrollments e
      join public.email_cadences c on c.id=e.cadence_id and c.organization_id=e.organization_id
      join public.organizations o on o.id=e.organization_id
      where e.status='ativa' and e.proximo_em<=p_agora
        and (e.processando_ate is null or e.processando_ate<p_agora)
        and c.status='ativa' and public.fn_org_operante(o.id)
        and o.settings->'cadencias'->'enabled'='true'::jsonb
      order by e.proximo_em,e.id limit 50 for update of e skip locked
  ), tomadas as (
    update public.email_cadence_enrollments e set processando_ate=p_agora+interval '3 minutes',processamento_id=gen_random_uuid()
      from prontas p where e.id=p.id returning e.*
  ) select coalesce(jsonb_agg(to_jsonb(tomadas)),'[]'::jsonb) into v_lote from tomadas;
  return v_lote;
end $reivindicar$;
revoke execute on function public.fn_cadencias_reivindicar(timestamptz) from public,anon,authenticated;
grant execute on function public.fn_cadencias_reivindicar(timestamptz) to service_role;

-- Última autorização do efeito: mesma trava de contato do descadastro e da
-- inscrição, supressão global revalidada e propriedade do claim comparada.
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
  if exists(select 1 from public.email_cadence_enrollments where organization_id=p_organization_id
    and contact_id=v_contato.id and motivo_parada='descadastro') then raise exception 'cadencia_descadastrado'; end if;
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

-- Efeito de tarefa e recibo do passo na MESMA transação. Repetir após perder
-- o retorno/avanço devolve a tarefa já criada; não grava outra no CRM.
create or replace function public.fn_cadencia_criar_tarefa(p_organization_id uuid,p_enrollment_id uuid,p_processamento_id uuid,p_passo_id text,p_titulo text,p_due_date timestamptz,p_assigned_to uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $tarefa$
declare v_inscricao record; v_task_id uuid; v_tarefa record;
begin
  if to_regclass('public.email_cadence_enrollments') is null then raise exception 'cadencia_modulo_indisponivel'; end if;
  select * into v_inscricao from public.email_cadence_enrollments where organization_id=p_organization_id
    and id=p_enrollment_id and processamento_id=p_processamento_id and status='ativa' for update;
  if not found then raise exception 'cadencia_claim_lost'; end if;
  select (metadata->>'task_id')::uuid into v_task_id from public.email_cadence_events
    where organization_id=p_organization_id and enrollment_id=p_enrollment_id and passo_id=p_passo_id and tipo='tarefa_criada' limit 1;
  if found then
    select id,title,due_date,priority,lead_id,contact_id into v_tarefa from public.crm_tasks where organization_id=p_organization_id and id=v_task_id;
    return jsonb_build_object('criada_agora',false,'tarefa',case when found then to_jsonb(v_tarefa) else null end);
  end if;
  insert into public.crm_tasks(organization_id,title,due_date,priority,status,lead_id,contact_id,assigned_to,created_by)
    values(p_organization_id,p_titulo,p_due_date,'medium','pending',v_inscricao.lead_id,v_inscricao.contact_id,p_assigned_to,null)
    returning id,title,due_date,priority,lead_id,contact_id into v_tarefa;
  insert into public.email_cadence_events(organization_id,cadence_id,enrollment_id,lead_id,tipo,passo_id,metadata)
    values(p_organization_id,v_inscricao.cadence_id,p_enrollment_id,v_inscricao.lead_id,'tarefa_criada',p_passo_id,jsonb_build_object('task_id',v_tarefa.id));
  return jsonb_build_object('criada_agora',true,'tarefa',to_jsonb(v_tarefa));
end $tarefa$;
revoke execute on function public.fn_cadencia_criar_tarefa(uuid,uuid,uuid,text,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.fn_cadencia_criar_tarefa(uuid,uuid,uuid,text,text,timestamptz,uuid) to service_role;

-- Funções compilam mesmo antes da instalação (ADR0002 D7).
create or replace function public.fn_cadencia_registrar_abertura(p_enrollment_id uuid,p_organization_id uuid,p_passo_id text)
returns boolean language plpgsql set search_path = public,pg_temp as $abertura$
declare v_inscricao record;
begin
  if to_regclass('public.email_cadence_enrollments') is null then return false; end if;
  if not exists(select 1 from public.modulos_instalados where modulo='cadencias' and estado='ativo')
    or not exists(select 1 from public.organizations where id=p_organization_id and public.fn_org_operante(id) and settings->'cadencias'->'enabled'='true'::jsonb) then return false; end if;
  update public.email_cadence_enrollments e set aberturas=e.aberturas+1,
    aberturas_ultimo_email=e.aberturas_ultimo_email+case when e.ultimo_email_passo_id=p_passo_id then 1 else 0 end,
    primeira_abertura_em=coalesce(e.primeira_abertura_em,now()),ultima_abertura_em=now()
  where e.id=p_enrollment_id and e.organization_id=p_organization_id and e.rastreio_consentido
    and e.motivo_parada is distinct from 'descadastro'
    and exists(select 1 from public.contacts c where c.id=e.contact_id and c.organization_id=p_organization_id and not c.is_anonymized)
  returning * into v_inscricao;
  if not found then return false; end if;
  insert into public.email_cadence_events(organization_id,cadence_id,enrollment_id,lead_id,tipo,passo_id)
  values(p_organization_id,v_inscricao.cadence_id,v_inscricao.id,v_inscricao.lead_id,'aberto',p_passo_id);
  return true;
end $abertura$;
revoke execute on function public.fn_cadencia_registrar_abertura(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_cadencia_registrar_abertura(uuid,uuid,text) to service_role;

-- O link continua válido depois de concluir/pausar/desligar: registra a supressão
-- na própria inscrição de origem e interrompe as outras ativas do mesmo contato.
-- Contagem + eventos em uma transação; clique repetido não cria evento extra.
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

-- A anonimização revoga rastreio e encerra filas antes do próximo envio.
create or replace function public.fn_cadencias_redigir_titular()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $redacao$
begin
  if new.is_anonymized and not old.is_anonymized and to_regclass('public.email_cadence_enrollments') is not null then
    update public.email_cadence_enrollments set status='parada',motivo_parada='sem_email',
      rastreio_consentido=false,ultimo_erro=null,processando_ate=null,processamento_id=null,parada_em=now()
    where organization_id=new.organization_id and contact_id=new.id;
  end if;
  return new;
end $redacao$;
revoke execute on function public.fn_cadencias_redigir_titular() from public,anon,authenticated,service_role;
drop trigger if exists trg_cadencias_redigir_titular on public.contacts;
create trigger trg_cadencias_redigir_titular after update of is_anonymized on public.contacts
for each row execute function public.fn_cadencias_redigir_titular();

do $reaplicar$ begin
  if exists(select 1 from public.modulos_instalados where modulo='cadencias') then
    perform public.fn_cadencias_provisionar();
  end if;
end $reaplicar$;
