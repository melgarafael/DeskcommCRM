-- manifest: O escopo de leitura do negócio é resolvido UMA VEZ por consulta (`fn_lead_scope()`) em vez de uma vez por linha (`fn_can_view_lead`), e as quatro filhas herdam o MESMO conjunto: o funil deixa de pagar 3 a 7 ms por negócio no RLS (#4323)
--
-- 9313 — escopo de leitura do negócio (#4323). Espelha a 0726 (#3090), que fez
-- isto para `conversations` com `fn_conversation_scope()`.
--
-- ═══ O DEFEITO, MEDIDO ═══
--
-- A policy `crm_leads_select` chamava `fn_can_view_lead(organization_id,
-- owner_user_id)` em TODA linha candidata, recebendo as colunas da própria linha
-- por argumento. A função é `stable security definer set search_path = public` e
-- o Postgres não a inlina: o corpo é reavaliado por linha, e dentro dele rodam
-- `fn_is_platform_admin()` e até duas vezes `fn_user_role_in_org(p_org)` — esta
-- última refaz `fn_support_context()` (join de 4 tabelas + `auth.jwt()` +
-- subconsulta de MFA em `auth.mfa_factors`). Medido pelo autor da issue: 3 a 7 ms
-- por linha, ~3,8 s num funil de 3.901 negócios.
--
-- As quatro filhas repetiam o mesmo custo dentro de `EXISTS` sobre `crm_leads`:
-- `crm_lead_activities_select`, `crm_lead_links_select`,
-- `email_cadence_enrollments_select` e `email_cadence_events_select`.
--
-- ═══ O CONSERTO: o que é da SESSÃO sai do caminho por linha ═══
--
-- `fn_lead_scope()` devolve, por organização a que o usuário tem acesso
-- (`fn_user_org_ids()`, a MESMA fonte que `fn_user_role_in_org` usa para dizer
-- "não é membro"), duas respostas:
--
--   · `org_wide_read` — enxerga a organização inteira (papel viewer/manager/admin
--     ou `visibility_mode = 'all'`);
--   · `sees_unassigned` — enxerga a fila sem responsável (`own_and_unassigned`).
--
-- A policy compara a LINHA com esse conjunto, e o ramo de plataforma vira um
-- InitPlan sem argumento. A subconsulta `(select ... from public.fn_lead_scope())`
-- é o que faz o planejador avaliar o conjunto uma vez por disjunção, não por
-- linha (o mesmo desenho da `conversations_select`, 0726).
--
-- ═══ VISIBILIDADE IDÊNTICA (a policy não afrouxa nem aperta) ═══
--
-- A escada da 0036 é preservada cláusula por cláusula:
--
--   1. `fn_is_platform_admin()` ⇒ tudo (primeira disjunção);
--   2. não é membro da organização ⇒ nada. `fn_user_org_ids()` devolve
--      exatamente as organizações em que `fn_user_role_in_org(org)` NÃO é nulo
--      (as `user_organizations` não revogadas MAIS a organização da sessão de
--      suporte ativa) — quem não está no conjunto não casa com nenhuma disjunção,
--      nem quando o negócio está atribuído a ele. É por isso que o
--      `and organization_id in (...)` acompanha o ramo do responsável: sem ele,
--      um negócio de organização alheia atribuído ao usuário vazaria;
--   3. papel viewer/manager/admin ⇒ tudo (dobrado em `org_wide_read`);
--   4. responsável = `auth.uid()` ⇒ vê, em qualquer organização em que seja
--      membro;
--   5. resto ⇒ `visibility_mode`: `'all'` entra em `org_wide_read`;
--      `'own_and_unassigned'` é o ÚNICO valor que entra em `sees_unassigned`
--      (um valor inválido no JSON não abre a fila — `sees_unassigned` NÃO é
--      `mode <> 'own'`); qualquer outro valor, inclusive `'own'`, fica nas duas
--      colunas como falso. A chave ausente cai no default `own_and_unassigned`
--      (G1-06a), pelo `coalesce` idêntico ao da 0036.
--
-- O invariante `tests/invariants/escopo-de-leitura-do-negocio.test.ts` roda as
-- DUAS formulações (a antiga, `fn_can_view_lead` linha a linha, e a nova, por
-- conjunto) sobre a MESMA fixture e compara o conjunto linha a linha em seis
-- combinações de papel e `visibility_mode` — plataforma, admin da organização,
-- agent em `own`, agent em `own_and_unassigned`, membro com vínculo revogado
-- (papel nulo) e organização alheia.
--
-- ═══ O QUE NÃO MUDOU, E POR QUÊ ═══
--
-- · `fn_can_view_lead` CONTINUA existindo com o MESMO contrato e os MESMOS
--   grants: ela é chamada pela criação/movimentação de negócio, pelos comandos de
--   transferência e pelo push da etapa (fn_push_inscricoes_que_veem_o_negocio).
--   Esta migration troca QUEM a policy usa, não a régua: mudar as duas coisas na
--   mesma fatia esconderia a regressão de uma delas.
-- · As policies de ESCRITA de `crm_leads` (insert/update/delete) continuam
--   chamando `fn_can_view_lead` — escrever é caminho de uma linha só (o comando
--   toca um negócio por vez), e é ali que o piso de papel mora. O custo por linha
--   que a issue mede é o da LEITURA do funil.
-- · As policies de `conversations` e `fn_conversation_scope()` não são tocadas.

-- O escopo por organização, resolvido uma vez por consulta.
--
-- `stable` + `security definer` + search_path blindado, como as irmãs
-- `fn_conversation_scope`/`fn_can_view_lead`: o corpo lê `user_organizations` e
-- `organizations` (a RLS de ambas mostra só o que é do próprio usuário, mas o
-- definer mantém o comportamento independente de quem chama) e o EXECUTE fica
-- com authenticated/service_role.
create or replace function public.fn_lead_scope()
returns table (organization_id uuid, org_wide_read boolean, sees_unassigned boolean)
language sql stable security definer
set search_path = public
as $$
  select o.organization_id,
         public.fn_user_role_in_org(o.organization_id) in ('viewer','manager','admin')
           or coalesce((select z.settings->>'visibility_mode' from public.organizations z
                        where z.id = o.organization_id), 'own_and_unassigned') = 'all',
         coalesce((select z.settings->>'visibility_mode' from public.organizations z
                   where z.id = o.organization_id), 'own_and_unassigned') = 'own_and_unassigned'
  from public.fn_user_org_ids() as o(organization_id);
$$;

revoke all on function public.fn_lead_scope() from public, anon;
grant execute on function public.fn_lead_scope() to authenticated, service_role;

-- A policy de leitura do negócio: a linha comparada com o conjunto.
--
-- `create policy` e `drop policy` no MESMO bloco: se a criação falhasse depois do
-- drop, `crm_leads` ficaria sem policy de leitura no `update.sh` (que roda sem
-- ON_ERROR_STOP).
do $crm_leads_select$ begin
  drop policy if exists "crm_leads_select" on public.crm_leads;
  create policy "crm_leads_select" on public.crm_leads
    for select using (
      (select public.fn_is_platform_admin())
      or organization_id in (
           select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
         )
      or (
           owner_user_id = auth.uid()
           and organization_id in (select s.organization_id from public.fn_lead_scope() s)
         )
      or (
           owner_user_id is null
           and organization_id in (
                select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
              )
         )
    );
end $crm_leads_select$;

-- As filhas seguem o MESMO conjunto, cada uma dentro do `EXISTS` no lead-pai.
-- A estrutura é a de hoje (nada de escalar de `owner_user_id`: o `EXISTS` é o que
-- fecha o caso do lead oculto — lição G4-01), só a régua dentro dele muda.
do $crm_lead_activities_select$ begin
  drop policy if exists "crm_lead_activities_select" on public.crm_lead_activities;
  create policy "crm_lead_activities_select" on public.crm_lead_activities
    for select using (
      exists (
        select 1 from public.crm_leads l
        where l.id = crm_lead_activities.lead_id
          and (
            (select public.fn_is_platform_admin())
            or l.organization_id in (
                 select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
               )
            or (
                 l.owner_user_id = auth.uid()
                 and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
               )
            or (
                 l.owner_user_id is null
                 and l.organization_id in (
                      select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                    )
               )
          )
      )
    );
end $crm_lead_activities_select$;

do $crm_lead_links_select$ begin
  drop policy if exists "crm_lead_links_select" on public.crm_lead_links;
  create policy "crm_lead_links_select" on public.crm_lead_links
    for select using (
      exists (
        select 1 from public.crm_leads l
        where l.id = crm_lead_links.lead_id
          and (
            (select public.fn_is_platform_admin())
            or l.organization_id in (
                 select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
               )
            or (
                 l.owner_user_id = auth.uid()
                 and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
               )
            or (
                 l.owner_user_id is null
                 and l.organization_id in (
                      select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                    )
               )
          )
      )
    );
end $crm_lead_links_select$;

-- ── Módulo OPCIONAL de cadências (9249): as tabelas só existem depois de
-- `fn_cadencias_provisionar()`. Instalação sem o módulo não tem o que reescrever
-- (o `to_regclass` é null), e a que já provisionou entra aqui. Sem esta guarda o
-- `update.sh` desta migration quebraria toda instalação que não usa cadências.
do $cadencia_escopo$ begin
  if to_regclass('public.email_cadence_enrollments') is null then
    return;
  end if;

  drop policy if exists email_cadence_enrollments_select on public.email_cadence_enrollments;
  create policy email_cadence_enrollments_select
    on public.email_cadence_enrollments
    for select to authenticated using (
      ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
      and exists (
        select 1 from public.crm_leads l
         where l.id = email_cadence_enrollments.lead_id
           and l.organization_id = email_cadence_enrollments.organization_id
           and (
             (select public.fn_is_platform_admin())
             or l.organization_id in (
                  select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
                )
             or (
                  l.owner_user_id = auth.uid()
                  and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
                )
             or (
                  l.owner_user_id is null
                  and l.organization_id in (
                       select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                     )
                )
           )
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
           and (
             (select public.fn_is_platform_admin())
             or l.organization_id in (
                  select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
                )
             or (
                  l.owner_user_id = auth.uid()
                  and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
                )
             or (
                  l.owner_user_id is null
                  and l.organization_id in (
                       select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                     )
                )
           )
      )
    );
end $cadencia_escopo$;

-- ── O provisionador do módulo RECRIA as duas policies a cada instalação do
-- módulo, então ele também passa a nascer na forma nova: sem isto, quem
-- instalasse as cadências DEPOIS desta migration voltaria ao custo por linha. É
-- a última definição de `fn_cadencias_provisionar()` (cópia da 9251), e as duas
-- únicas linhas que mudam são o `EXISTS` de `email_cadence_enrollments` e o de
-- `email_cadence_events` — o resto do corpo é byte a byte o vigente.
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

-- Supressão do descadastro fora da inscrição, pelo ENDEREÇO e pelo contato.
-- Nenhuma FK que a apague com o negócio, a cadência ou a inscrição; cascata só
-- da organização. O contato é ponteiro com `on delete set null`: apagar o
-- contato não leva a recusa junto (o hash do endereço fica), e enquanto ele
-- existe o ponteiro cobre a troca de e-mail do mesmo contato. A fusão de
-- contatos reponta o ponteiro para o principal (pelo catálogo de FKs) e o hash
-- segue valendo para o endereço que ficou na lápide.
create table if not exists public.email_cadence_suppressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email_hash text,
  contact_id uuid references public.contacts(id) on delete set null,
  origem text not null,
  created_at timestamptz not null default now(),
  constraint email_cadence_suppressions_origem_check check (origem in ('link','backfill'))
);

create index if not exists idx_email_cadence_suppressions_email
  on public.email_cadence_suppressions (organization_id, email_hash) where email_hash is not null;
create index if not exists idx_email_cadence_suppressions_contato
  on public.email_cadence_suppressions (contact_id) where contact_id is not null;

comment on table public.email_cadence_suppressions is
  'Endereço (hash por organização, fn_cadencia_hash_do_email) e contato que pediram para não receber cadências desta organização. Escrita só por fn_cadencia_descadastrar e pelo backfill; lida por fn_cadencia_inscrever e fn_cadencia_reservar_destinatario.';

-- Destinatário de cada envio: o link de descadastro carrega só o id desta
-- linha, e ela não cai com o negócio (a inscrição vira null), então o clique
-- depois de o negócio sumir ainda sabe qual endereço suprimir.
create table if not exists public.email_cadence_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email_hash text not null,
  contact_id uuid references public.contacts(id) on delete set null,
  enrollment_id uuid references public.email_cadence_enrollments(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_cadence_recipients_contato
  on public.email_cadence_recipients (contact_id) where contact_id is not null;
create index if not exists idx_email_cadence_recipients_inscricao
  on public.email_cadence_recipients (enrollment_id) where enrollment_id is not null;

comment on table public.email_cadence_recipients is
  'Um registro por e-mail de cadência reservado para envio: organização, hash do endereço, contato e inscrição. É o que o token do link de descadastro identifica.';

-- Backfill idempotente: descadastros gravados só na linha da inscrição viram
-- supressão do contato com o hash do e-mail dele, e supressões sem hash ganham
-- o hash do e-mail atual do contato. Reaplicar não duplica nem regrava.
insert into public.email_cadence_suppressions (organization_id, email_hash, contact_id, origem, created_at)
  select e.organization_id, public.fn_cadencia_hash_do_email(e.organization_id, c.email), e.contact_id,
         'backfill', min(coalesce(e.parada_em, e.updated_at))
    from public.email_cadence_enrollments e
    join public.contacts c on c.id = e.contact_id and c.organization_id = e.organization_id
   where e.motivo_parada = 'descadastro'
     and not exists (select 1 from public.email_cadence_suppressions s
                      where s.organization_id = e.organization_id and s.contact_id = e.contact_id)
   group by e.organization_id, e.contact_id, c.email;
update public.email_cadence_suppressions s
   set email_hash = public.fn_cadencia_hash_do_email(s.organization_id, c.email)
  from public.contacts c
 where s.email_hash is null and c.id = s.contact_id and c.organization_id = s.organization_id
   and btrim(coalesce(c.email, '')) <> '';

-- ═══ RLS ═══
-- Policy e ON em linhas distintas: compatibilidade real com update.sh<=v1.63.0
-- (mesmo contrato da provisionadora0619, issue1906); RLS será provada instalada.
-- SELECT das inscrições e dos eventos segue a visibilidade do NEGÓCIO
-- (fn_lead_scope, como crm_lead_activities); a sequência, ao tenant.
-- Escrita só pelo servidor (service_role), que filtra `organization_id`
-- manualmente a partir de `requireRole()`.
alter table public.email_cadences enable row level security;
alter table public.email_cadence_enrollments enable row level security;
alter table public.email_cadence_events enable row level security;
-- Sem policy: só o servidor (service_role) lê e grava a supressão e o destinatário.
alter table public.email_cadence_suppressions enable row level security;
alter table public.email_cadence_recipients enable row level security;

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
         and (
           (select public.fn_is_platform_admin())
           or l.organization_id in (
                select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
              )
           or (
                l.owner_user_id = auth.uid()
                and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
              )
           or (
                l.owner_user_id is null
                and l.organization_id in (
                     select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                   )
              )
         )
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
         and (
           (select public.fn_is_platform_admin())
           or l.organization_id in (
                select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
              )
           or (
                l.owner_user_id = auth.uid()
                and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
              )
           or (
                l.owner_user_id is null
                and l.organization_id in (
                     select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                   )
              )
         )
    )
  );

revoke all on public.email_cadences from anon, authenticated;
revoke all on public.email_cadence_enrollments from anon, authenticated;
revoke all on public.email_cadence_events from anon, authenticated;
revoke all on public.email_cadence_suppressions from anon, authenticated;
revoke all on public.email_cadence_recipients from anon, authenticated;
grant select on public.email_cadences to authenticated;
grant select on public.email_cadence_enrollments to authenticated;
grant select on public.email_cadence_events to authenticated;
grant all on public.email_cadences to service_role;
grant all on public.email_cadence_enrollments to service_role;
grant all on public.email_cadence_events to service_role;
grant all on public.email_cadence_suppressions to service_role;
grant all on public.email_cadence_recipients to service_role;

  -- Reaplicar restaura todas as proteções na mesma transação da instalação.
  perform public.fn_proteger_modulo_provisionado();

end;
$f$;

notify pgrst, 'reload schema';
