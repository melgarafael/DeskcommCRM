-- manifest: área da agência, fase 8b — calendário de publicações por cliente (rede, formato, data, legenda, mídia, responsável, situação), ligado às aprovações da fase 7 e com publicação automática na Meta só por chave da própria publicação, desligada por padrão; tabela da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-publicacoes.md.
--
-- Mesmo regime das 9003–9010: sem organization_id (é da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy.

create table if not exists public.agencia_publicacoes (
  id             uuid primary key default gen_random_uuid(),
  cliente_id     uuid not null references public.agencia_clientes(id) on delete cascade,
  titulo         text not null,
  rede           text not null default 'instagram',
  formato        text not null default 'feed',
  quando         timestamptz not null,
  legenda        text,
  midia_url      text,
  responsavel_id uuid references public.agencia_membros(id) on delete set null,
  situacao       text not null default 'rascunho',
  auto_publicar  boolean not null default false,
  comentario     text,
  post_id        text,
  post_url       text,
  erro           text,
  publicada_em   timestamptz,
  criado_por     uuid references auth.users(id) on delete set null,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  constraint agencia_publicacoes_rede check (rede in ('instagram','facebook','tiktok','youtube','outra')),
  constraint agencia_publicacoes_formato check (formato in ('feed','reels','story','carrossel','video')),
  constraint agencia_publicacoes_situacao check (situacao in ('rascunho','em_aprovacao','aprovada','agendada','publicando','publicada','falhou','cancelada')),
  constraint agencia_publicacoes_midia check (midia_url is null or midia_url ~* '^https://'),
  constraint agencia_publicacoes_post_url check (post_url is null or post_url ~* '^https://')
);
create index if not exists agencia_publicacoes_cliente on public.agencia_publicacoes (cliente_id, quando);
create index if not exists agencia_publicacoes_quando on public.agencia_publicacoes (quando);
create index if not exists agencia_publicacoes_agendadas on public.agencia_publicacoes (quando) where situacao = 'agendada';

alter table public.agencia_publicacoes enable row level security;
revoke all on table public.agencia_publicacoes from anon, authenticated;

-- A aprovação pedida a partir de uma publicação aponta para ela (P3).
alter table public.agencia_aprovacoes
  add column if not exists publicacao_id uuid references public.agencia_publicacoes(id) on delete set null;
create index if not exists agencia_aprovacoes_publicacao on public.agencia_aprovacoes (publicacao_id) where publicacao_id is not null;
