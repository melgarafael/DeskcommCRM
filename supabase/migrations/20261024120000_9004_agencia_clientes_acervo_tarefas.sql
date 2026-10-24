-- manifest: área da agência, fase 2 — clientes da agência (empresas, equipe, contratações), acervo no Google Drive e o sistema de tarefas (etiquetas, checklist, links, cronômetro, recorrentes, avisos de prazo); tabelas da instalação, só o servidor lê e escreve
--
-- Specs: docs/agencia/SPEC-clientes.md, SPEC-acervo.md, SPEC-tarefas.md.
--
-- Mesmo regime da 9003: sem organization_id (são da INSTALAÇÃO, não de um
-- tenant), RLS ligada em todas, `revoke all` explícito de anon/authenticated e
-- nenhuma policy — toda leitura e escrita passa pelo servidor depois do guarda
-- de permissão (lib/agencia/acesso.ts). O cookie de sessão é HttpOnly, então o
-- navegador nunca fala com estas tabelas direto.
--
-- `servicos`, `quantidades` e as colunas de vocabulário aberto não têm CHECK: o
-- vocabulário mora em lib/agencia/clientes/servicos.ts e cresce. As colunas de
-- vocabulário fechado (situação, coluna do quadro, prioridade, padrão) têm.

-- ── Clientes ──────────────────────────────────────────────────────────────
create table if not exists public.agencia_clientes (
  id               uuid primary key default gen_random_uuid(),
  nome             text not null,
  razao_social     text,
  documento        text,
  segmento         text,
  responsavel_nome text,
  whatsapp         text,
  email            text,
  cidade           text,
  instagram        text,
  site             text,
  observacoes      text,
  situacao         text not null default 'prospeccao',
  organization_id  uuid references public.organizations(id) on delete set null,
  drive_pasta_id   text,
  drive_subpastas  jsonb not null default '{}',
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  criado_por       uuid references auth.users(id) on delete set null,
  constraint agencia_clientes_situacao check (situacao in
    ('prospeccao','apresentacao','fechamento','aguardando','ativo','pausado','encerrado','perdido','remarketing'))
);
create unique index if not exists agencia_clientes_organizacao_unica
  on public.agencia_clientes (organization_id) where organization_id is not null;
create index if not exists agencia_clientes_situacao_idx on public.agencia_clientes (situacao);

create table if not exists public.agencia_clientes_empresas (
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.agencia_clientes(id) on delete cascade,
  nome       text not null,
  documento  text,
  ordem      int not null default 0
);
create index if not exists agencia_clientes_empresas_cliente on public.agencia_clientes_empresas (cliente_id);

create table if not exists public.agencia_clientes_membros (
  cliente_id uuid not null references public.agencia_clientes(id) on delete cascade,
  membro_id  uuid not null references public.agencia_membros(id) on delete cascade,
  primary key (cliente_id, membro_id)
);
create index if not exists agencia_clientes_membros_membro on public.agencia_clientes_membros (membro_id);

create table if not exists public.agencia_contratacoes (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.agencia_clientes(id) on delete cascade,
  tipo        text not null,
  servicos    text[] not null default '{}',
  quantidades jsonb not null default '{}',
  inicio      date,
  fim         date,
  situacao    text not null default 'ativa',
  observacoes text,
  criado_em   timestamptz not null default now(),
  constraint agencia_contratacoes_tipo check (tipo in ('recorrente','avulsa')),
  constraint agencia_contratacoes_situacao check (situacao in ('proposta','ativa','pausada','encerrada'))
);
create index if not exists agencia_contratacoes_cliente on public.agencia_contratacoes (cliente_id);

-- ── Acervo no Google Drive ────────────────────────────────────────────────
create table if not exists public.agencia_drive (
  id                 boolean primary key default true,
  conta_email        text,
  refresh_token_ct   bytea,
  refresh_token_iv   bytea,
  refresh_token_tag  bytea,
  pasta_raiz_id      text,
  conectado_em       timestamptz,
  conectado_por      uuid references auth.users(id) on delete set null,
  ultimo_erro        text,
  atualizado_em      timestamptz not null default now(),
  constraint agencia_drive_unica check (id)
);
insert into public.agencia_drive (id) values (true) on conflict (id) do nothing;

-- ── Tarefas ───────────────────────────────────────────────────────────────
create table if not exists public.agencia_etiquetas (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null,
  cor       text not null default '#64748b',
  criada_em timestamptz not null default now(),
  constraint agencia_etiquetas_nome_unico unique (nome),
  constraint agencia_etiquetas_cor_hex check (cor ~ '^#[0-9a-fA-F]{6}$')
);

create table if not exists public.agencia_tarefas_recorrentes (
  id               uuid primary key default gen_random_uuid(),
  titulo           text not null,
  descricao        text,
  cliente_id       uuid references public.agencia_clientes(id) on delete set null,
  funcao_id        uuid references public.agencia_funcoes(id),
  prioridade       text not null default 'media',
  padrao           text not null,
  dias_semana      int[] not null default '{}',    -- 0 = domingo … 6 = sábado
  dia_do_mes       int,
  hora             time not null default '08:00',
  prazo_em_horas   int,                            -- prazo da tarefa gerada, contado da geração
  inicio           date not null default current_date,
  fim              date,
  ativa            boolean not null default true,
  proxima_execucao timestamptz,
  ultima_execucao  timestamptz,
  criada_em        timestamptz not null default now(),
  criada_por       uuid references auth.users(id) on delete set null,
  constraint agencia_recorrentes_padrao check (padrao in ('diaria','semanal','mensal')),
  constraint agencia_recorrentes_prioridade check (prioridade in ('baixa','media','alta','urgente')),
  constraint agencia_recorrentes_dias check (dias_semana <@ array[0,1,2,3,4,5,6]),
  constraint agencia_recorrentes_dia_do_mes check (dia_do_mes is null or dia_do_mes between 1 and 31)
);
create index if not exists agencia_recorrentes_proxima on public.agencia_tarefas_recorrentes (proxima_execucao) where ativa;

create table if not exists public.agencia_recorrentes_responsaveis (
  recorrente_id uuid not null references public.agencia_tarefas_recorrentes(id) on delete cascade,
  membro_id     uuid not null references public.agencia_membros(id) on delete cascade,
  primary key (recorrente_id, membro_id)
);
create table if not exists public.agencia_recorrentes_etiquetas (
  recorrente_id uuid not null references public.agencia_tarefas_recorrentes(id) on delete cascade,
  etiqueta_id   uuid not null references public.agencia_etiquetas(id) on delete cascade,
  primary key (recorrente_id, etiqueta_id)
);

create table if not exists public.agencia_tarefas (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  coluna        text not null default 'a_fazer',
  posicao       numeric not null default 0,
  prioridade    text not null default 'media',
  prazo         timestamptz,
  cliente_id    uuid references public.agencia_clientes(id) on delete set null,
  funcao_id     uuid references public.agencia_funcoes(id),
  executor      text not null default 'humano',
  recorrente_id uuid references public.agencia_tarefas_recorrentes(id) on delete set null,
  gerada_para   timestamptz,                       -- instante da recorrência que gerou esta tarefa
  concluida_em  timestamptz,
  criada_em     timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  criada_por    uuid references auth.users(id) on delete set null,
  constraint agencia_tarefas_coluna check (coluna in ('backlog','a_fazer','em_andamento','revisao','concluido')),
  constraint agencia_tarefas_prioridade check (prioridade in ('baixa','media','alta','urgente')),
  constraint agencia_tarefas_executor check (executor in ('humano','ia'))
);
-- A recorrência gera UMA tarefa por instante, mesmo com o cron rodando duas vezes.
create unique index if not exists agencia_tarefas_uma_por_recorrencia
  on public.agencia_tarefas (recorrente_id, gerada_para) where recorrente_id is not null;
create index if not exists agencia_tarefas_coluna_posicao on public.agencia_tarefas (coluna, posicao);
create index if not exists agencia_tarefas_cliente on public.agencia_tarefas (cliente_id);
create index if not exists agencia_tarefas_prazo_aberto on public.agencia_tarefas (prazo) where concluida_em is null;

create table if not exists public.agencia_tarefas_responsaveis (
  tarefa_id uuid not null references public.agencia_tarefas(id) on delete cascade,
  membro_id uuid not null references public.agencia_membros(id) on delete cascade,
  primary key (tarefa_id, membro_id)
);
create index if not exists agencia_tarefas_responsaveis_membro on public.agencia_tarefas_responsaveis (membro_id);

create table if not exists public.agencia_tarefas_checklist (
  id        uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.agencia_tarefas(id) on delete cascade,
  texto     text not null,
  feito     boolean not null default false,
  ordem     int not null default 0
);
create index if not exists agencia_tarefas_checklist_tarefa on public.agencia_tarefas_checklist (tarefa_id);

create table if not exists public.agencia_tarefas_links (
  id        uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.agencia_tarefas(id) on delete cascade,
  titulo    text not null,
  url       text not null,
  constraint agencia_tarefas_links_url check (url ~* '^https?://')
);
create index if not exists agencia_tarefas_links_tarefa on public.agencia_tarefas_links (tarefa_id);

create table if not exists public.agencia_tarefas_etiquetas (
  tarefa_id   uuid not null references public.agencia_tarefas(id) on delete cascade,
  etiqueta_id uuid not null references public.agencia_etiquetas(id) on delete cascade,
  primary key (tarefa_id, etiqueta_id)
);

create table if not exists public.agencia_tarefas_tempo (
  id        uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.agencia_tarefas(id) on delete cascade,
  membro_id uuid not null references public.agencia_membros(id) on delete cascade,
  inicio    timestamptz not null,
  fim       timestamptz,
  manual    boolean not null default false,
  constraint agencia_tempo_fim_depois check (fim is null or fim >= inicio)
);
-- Um cronômetro rodando por pessoa.
create unique index if not exists agencia_tempo_um_rodando
  on public.agencia_tarefas_tempo (membro_id) where fim is null;
create index if not exists agencia_tempo_tarefa on public.agencia_tarefas_tempo (tarefa_id);

-- Cada marco de prazo avisa UMA vez (antes_Nd, no_dia, atrasou).
create table if not exists public.agencia_avisos_de_prazo (
  tarefa_id  uuid not null references public.agencia_tarefas(id) on delete cascade,
  marco      text not null,
  avisado_em timestamptz not null default now(),
  primary key (tarefa_id, marco)
);

create table if not exists public.agencia_arquivos (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid references public.agencia_clientes(id) on delete set null,
  tarefa_id     uuid references public.agencia_tarefas(id) on delete set null,
  subpasta      text not null,
  drive_file_id text not null,
  nome          text not null,
  mime          text,
  tamanho_bytes bigint,
  link          text not null,
  enviado_por   uuid references auth.users(id) on delete set null,
  criado_em     timestamptz not null default now(),
  constraint agencia_arquivos_drive_unico unique (drive_file_id)
);
create index if not exists agencia_arquivos_tarefa on public.agencia_arquivos (tarefa_id);
create index if not exists agencia_arquivos_cliente on public.agencia_arquivos (cliente_id);

-- ── Acesso ────────────────────────────────────────────────────────────────
alter table public.agencia_clientes                 enable row level security;
alter table public.agencia_clientes_empresas        enable row level security;
alter table public.agencia_clientes_membros         enable row level security;
alter table public.agencia_contratacoes             enable row level security;
alter table public.agencia_drive                    enable row level security;
alter table public.agencia_etiquetas                enable row level security;
alter table public.agencia_tarefas_recorrentes      enable row level security;
alter table public.agencia_recorrentes_responsaveis enable row level security;
alter table public.agencia_recorrentes_etiquetas    enable row level security;
alter table public.agencia_tarefas                  enable row level security;
alter table public.agencia_tarefas_responsaveis     enable row level security;
alter table public.agencia_tarefas_checklist        enable row level security;
alter table public.agencia_tarefas_links            enable row level security;
alter table public.agencia_tarefas_etiquetas        enable row level security;
alter table public.agencia_tarefas_tempo            enable row level security;
alter table public.agencia_avisos_de_prazo          enable row level security;
alter table public.agencia_arquivos                 enable row level security;

revoke all on table
  public.agencia_clientes, public.agencia_clientes_empresas, public.agencia_clientes_membros,
  public.agencia_contratacoes, public.agencia_drive, public.agencia_etiquetas,
  public.agencia_tarefas_recorrentes, public.agencia_recorrentes_responsaveis,
  public.agencia_recorrentes_etiquetas, public.agencia_tarefas, public.agencia_tarefas_responsaveis,
  public.agencia_tarefas_checklist, public.agencia_tarefas_links, public.agencia_tarefas_etiquetas,
  public.agencia_tarefas_tempo, public.agencia_avisos_de_prazo, public.agencia_arquivos
  from anon, authenticated;

-- Etiquetas que nascem prontas (as do vídeo de referência).
insert into public.agencia_etiquetas (nome, cor) values
  ('Vídeo',             '#2563eb'),
  ('Gravação',          '#dc2626'),
  ('Edição',            '#7c3aed'),
  ('Postagem',          '#ea580c'),
  ('Material gráfico',  '#16a34a'),
  ('Organização mídias','#0d9488'),
  ('Tráfego',           '#ca8a04')
on conflict (nome) do nothing;
