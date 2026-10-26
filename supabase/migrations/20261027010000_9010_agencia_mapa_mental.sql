-- manifest: área da agência, fase 8a — mapa mental por cliente (blocos com posição, responsável ou função, prazo, checklist, links e executor humano/IA; setas de dependência), com Criação em rascunho e Ao vivo que desbloqueia e vira tarefa; tabelas da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-mapa-mental.md.
--
-- Mesmo regime das 9003–9008: sem organization_id (são da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy.

create table if not exists public.agencia_mapas (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.agencia_clientes(id) on delete cascade,
  titulo        text not null,
  descricao     text,
  situacao      text not null default 'rascunho',
  publicado_em  timestamptz,
  criado_por    uuid references auth.users(id) on delete set null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint agencia_mapas_situacao check (situacao in ('rascunho','publicado','arquivado'))
);
create index if not exists agencia_mapas_cliente on public.agencia_mapas (cliente_id, situacao);

create table if not exists public.agencia_mapa_blocos (
  id             uuid primary key default gen_random_uuid(),
  mapa_id        uuid not null references public.agencia_mapas(id) on delete cascade,
  titulo         text not null,
  descricao      text,
  cor            text not null default '#2563eb',
  x              numeric not null default 0,
  y              numeric not null default 0,
  tipo           text not null default 'tarefa',
  funcao_id      uuid references public.agencia_funcoes(id) on delete set null,
  responsavel_id uuid references public.agencia_membros(id) on delete set null,
  prazo          timestamptz,
  checklist      text[] not null default '{}',
  links          text[] not null default '{}',
  executor       text not null default 'humano',
  situacao       text not null default 'bloqueado',
  tarefa_id      uuid references public.agencia_tarefas(id) on delete set null,
  liberado_em    timestamptz,
  concluido_em   timestamptz,
  criado_em      timestamptz not null default now(),
  constraint agencia_mapa_blocos_cor check (cor ~ '^#[0-9a-fA-F]{6}$'),
  constraint agencia_mapa_blocos_tipo check (tipo in ('tarefa','marco')),
  constraint agencia_mapa_blocos_executor check (executor in ('humano','ia')),
  constraint agencia_mapa_blocos_situacao check (situacao in ('bloqueado','liberado','em_andamento','concluido'))
);
create index if not exists agencia_mapa_blocos_mapa on public.agencia_mapa_blocos (mapa_id);
create index if not exists agencia_mapa_blocos_tarefa on public.agencia_mapa_blocos (tarefa_id) where tarefa_id is not null;

create table if not exists public.agencia_mapa_ligacoes (
  mapa_id uuid not null references public.agencia_mapas(id) on delete cascade,
  de_id   uuid not null references public.agencia_mapa_blocos(id) on delete cascade,
  para_id uuid not null references public.agencia_mapa_blocos(id) on delete cascade,
  primary key (de_id, para_id),
  constraint agencia_mapa_ligacoes_sem_laco check (de_id <> para_id)
);
create index if not exists agencia_mapa_ligacoes_mapa on public.agencia_mapa_ligacoes (mapa_id);

alter table public.agencia_mapas         enable row level security;
alter table public.agencia_mapa_blocos   enable row level security;
alter table public.agencia_mapa_ligacoes enable row level security;

revoke all on table public.agencia_mapas, public.agencia_mapa_blocos, public.agencia_mapa_ligacoes from anon, authenticated;
