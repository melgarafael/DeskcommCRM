-- manifest: área da agência, fase 1 — funções e membros da equipe, convites, WhatsApp da agência e avisos; tabelas da instalação (sem organization_id), só o servidor escreve, o membro lê os próprios avisos
--
-- Specs: docs/agencia/SPEC-equipe.md, SPEC-whatsapp-agencia.md, SPEC-avisos.md.
--
-- Por que sem organization_id: a agência não é uma organização-cliente. Estas
-- tabelas são da INSTALAÇÃO, como platform_admins e platform_config. O isolamento
-- aqui não é entre tenants, é entre a equipe da agência e todo o resto: nenhuma
-- policy para anon; authenticated só lê e marca como lido o PRÓPRIO aviso; toda
-- outra leitura e escrita passa pelo servidor (service_role), depois do guarda de
-- permissão em lib/agencia/acesso.ts.
--
-- Por que permissoes sem CHECK: o vocabulário cresce a cada fase e mora em
-- lib/agencia/permissoes.ts; item desconhecido é ignorado na soma, nunca
-- concedido (somarPermissoes). Mesma exceção de vocabulário aberto do CLAUDE.md.

create table if not exists public.agencia_funcoes (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  cor           text not null default '#64748b',
  permissoes    text[] not null default '{}',
  ativa         boolean not null default true,
  ordem         int not null default 0,
  criada_em     timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  constraint agencia_funcoes_nome_unico unique (nome),
  constraint agencia_funcoes_cor_hex check (cor ~ '^#[0-9a-fA-F]{6}$')
);

create table if not exists public.agencia_membros (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete set null,
  nome               text not null,
  whatsapp           text not null,
  email              text not null,
  ve_todos_clientes  boolean not null default false,
  recebe_whatsapp    boolean not null default true,
  situacao           text not null default 'convidado',
  convidado_em       timestamptz not null default now(),
  ativado_em         timestamptz,
  desativado_em      timestamptz,
  criado_por         uuid references auth.users(id) on delete set null,
  constraint agencia_membros_situacao check (situacao in ('convidado', 'ativo', 'desativado')),
  constraint agencia_membros_whatsapp_e164 check (whatsapp ~ '^\+[1-9][0-9]{7,14}$')
);
create unique index if not exists agencia_membros_user_unico
  on public.agencia_membros (user_id) where user_id is not null;
create unique index if not exists agencia_membros_email_unico
  on public.agencia_membros (lower(email));

create table if not exists public.agencia_membros_funcoes (
  membro_id uuid not null references public.agencia_membros(id) on delete cascade,
  funcao_id uuid not null references public.agencia_funcoes(id),
  primary key (membro_id, funcao_id)
);

create table if not exists public.agencia_convites (
  id          uuid primary key default gen_random_uuid(),
  membro_id   uuid not null references public.agencia_membros(id) on delete cascade,
  token_hash  text not null,
  expira_em   timestamptz not null,
  aceito_em   timestamptz,
  revogado_em timestamptz,
  criado_por  uuid references auth.users(id) on delete set null,
  criado_em   timestamptz not null default now(),
  constraint agencia_convites_token_unico unique (token_hash)
);
create index if not exists agencia_convites_membro on public.agencia_convites (membro_id);

-- Configuração única da instalação (uma linha, id = true).
create table if not exists public.agencia_config (
  id                     boolean primary key default true,
  canal_organization_id  uuid references public.organizations(id) on delete set null,
  canal_session_id       uuid references public.channel_sessions(id) on delete set null,
  janela_inicio          time not null default '07:00',
  janela_fim             time not null default '22:00',
  avisos_antecedencia    int[] not null default '{2,1}',
  atualizado_em          timestamptz not null default now(),
  atualizado_por         uuid references auth.users(id) on delete set null,
  constraint agencia_config_unica check (id),
  constraint agencia_config_antecedencia check (avisos_antecedencia <@ array[1,2,3,4,5,6,7])
);
insert into public.agencia_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.agencia_envios_whatsapp (
  id             uuid primary key default gen_random_uuid(),
  motivo         text not null,
  referencia_id  uuid,
  telefone       text not null,
  corpo          text not null,
  situacao       text not null default 'pendente',
  tentativas     int not null default 0,
  erro_codigo    text,
  external_id    text,
  -- Agrupamento de avisos (SPEC-avisos, A4): avisos do mesmo tipo para o mesmo
  -- número, enquanto o envio ainda está pendente, viram uma mensagem só.
  grupo          text,
  titulos        text[] not null default '{}',
  criado_em      timestamptz not null default now(),
  enviado_em     timestamptz,
  constraint agencia_envios_motivo check (motivo in ('convite', 'aviso', 'teste')),
  constraint agencia_envios_situacao check (situacao in ('pendente', 'enviado', 'falhou', 'descartado'))
);
create index if not exists agencia_envios_recentes on public.agencia_envios_whatsapp (criado_em desc);
create index if not exists agencia_envios_pendentes_por_grupo
  on public.agencia_envios_whatsapp (telefone, grupo) where situacao = 'pendente';

create table if not exists public.agencia_avisos (
  id            uuid primary key default gen_random_uuid(),
  membro_id     uuid not null references public.agencia_membros(id) on delete cascade,
  tipo          text not null,
  titulo        text not null,
  corpo         text,
  link          text,
  referencia_id uuid,
  criado_em     timestamptz not null default now(),
  lido_em       timestamptz
);
create index if not exists agencia_avisos_membro_recentes
  on public.agencia_avisos (membro_id, criado_em desc);
create index if not exists agencia_avisos_membro_nao_lidos
  on public.agencia_avisos (membro_id) where lido_em is null;

-- O membro ATIVO do usuário corrente. Usada pela policy dos avisos.
create or replace function public.fn_agencia_membro_atual()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id
    from public.agencia_membros m
   where m.user_id = auth.uid()
     and m.situacao = 'ativo'
   limit 1
$$;
revoke execute on function public.fn_agencia_membro_atual() from public, anon;
grant  execute on function public.fn_agencia_membro_atual() to authenticated, service_role;

-- RLS em todas. Sem policy = só o service_role (que ignora RLS) lê e escreve.
alter table public.agencia_funcoes          enable row level security;
alter table public.agencia_membros          enable row level security;
alter table public.agencia_membros_funcoes  enable row level security;
alter table public.agencia_convites         enable row level security;
alter table public.agencia_config           enable row level security;
alter table public.agencia_envios_whatsapp  enable row level security;
alter table public.agencia_avisos           enable row level security;

-- O default ACL do Supabase concede tudo a anon/authenticated em tabela nova; a
-- RLS sem policy já barra, mas o revoke explícito é o que vale no Supabase real
-- (lição da 0258, CLAUDE.md › Audit log).
revoke all on table
  public.agencia_funcoes, public.agencia_membros, public.agencia_membros_funcoes,
  public.agencia_convites, public.agencia_config, public.agencia_envios_whatsapp,
  public.agencia_avisos
  from anon, authenticated;

grant select on table public.agencia_avisos to authenticated;
grant update (lido_em) on table public.agencia_avisos to authenticated;

drop policy if exists agencia_avisos_do_proprio_membro_select on public.agencia_avisos;
create policy agencia_avisos_do_proprio_membro_select on public.agencia_avisos
  for select to authenticated
  using (membro_id = public.fn_agencia_membro_atual());

drop policy if exists agencia_avisos_do_proprio_membro_update on public.agencia_avisos;
create policy agencia_avisos_do_proprio_membro_update on public.agencia_avisos
  for update to authenticated
  using (membro_id = public.fn_agencia_membro_atual())
  with check (membro_id = public.fn_agencia_membro_atual());

-- O sininho atualiza sem recarregar (Supabase Realtime respeita a RLS acima).
-- Guardado: o Postgres descartável do test:db não tem a publicação.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agencia_avisos'
     ) then
    execute 'alter publication supabase_realtime add table public.agencia_avisos';
  end if;
end
$$;

-- As funções que nascem prontas (SPEC-equipe › Funções que nascem prontas).
insert into public.agencia_funcoes (nome, cor, permissoes, ordem) values
  ('Roteirista',        '#8b5cf6', '{tarefas.criar}', 1),
  ('Videomaker',        '#ef4444', '{tarefas.criar}', 2),
  ('Editor',            '#3b82f6', '{tarefas.criar}', 3),
  ('Designer',          '#f59e0b', '{tarefas.criar}', 4),
  ('Social media',      '#ec4899', '{tarefas.criar}', 5),
  ('Gestor de tráfego', '#10b981', '{tarefas.criar}', 6),
  ('Programador',       '#64748b', '{tarefas.criar}', 7)
on conflict (nome) do nothing;
