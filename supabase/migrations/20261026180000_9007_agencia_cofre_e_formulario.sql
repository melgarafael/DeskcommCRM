-- manifest: área da agência, fase 5 — formulário de acesso dentro da central (link por cliente com token em hash, 72 h, rascunho sem senhas) e cofre de acessos (senha cifrada AES-256-GCM, cada visualização registrada); motivo `formulario` no WhatsApp da agência; tabelas da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-cofre-e-formulario.md.
--
-- Mesmo regime das 9003–9006: sem organization_id (são da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy. A senha
-- nunca é gravada em claro: só `senha_ct/iv/tag` (lib/crypto/aes_gcm.ts), e o
-- rascunho/respostas do formulário não carregam senha (F3).

create table if not exists public.agencia_formularios (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.agencia_clientes(id) on delete cascade,
  token_hash  text not null,
  expira_em   timestamptz not null,
  situacao    text not null default 'aberto',
  rascunho    jsonb not null default '{}',
  respostas   jsonb,
  enviado_em  timestamptz,
  criado_em   timestamptz not null default now(),
  criado_por  uuid references auth.users(id) on delete set null,
  constraint agencia_formularios_token unique (token_hash),
  constraint agencia_formularios_situacao check (situacao in ('aberto','enviado','cancelado'))
);
create index if not exists agencia_formularios_cliente on public.agencia_formularios (cliente_id, criado_em desc);

create table if not exists public.agencia_cofre_itens (
  id            uuid primary key default gen_random_uuid(),
  cliente_id    uuid not null references public.agencia_clientes(id) on delete cascade,
  plataforma    text not null,
  rotulo        text not null,
  login         text,
  extra         text,
  senha_ct      bytea,
  senha_iv      bytea,
  senha_tag     bytea,
  origem        text not null default 'manual',
  formulario_id uuid references public.agencia_formularios(id) on delete set null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references auth.users(id) on delete set null,
  constraint agencia_cofre_itens_origem check (origem in ('formulario','manual')),
  constraint agencia_cofre_itens_senha_inteira check (
    (senha_ct is null and senha_iv is null and senha_tag is null)
    or (senha_ct is not null and senha_iv is not null and senha_tag is not null))
);
create index if not exists agencia_cofre_itens_cliente on public.agencia_cofre_itens (cliente_id);

-- Cada vez que alguém vê uma senha ou gera o relatório (F5).
create table if not exists public.agencia_cofre_visualizacoes (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid references public.agencia_cofre_itens(id) on delete set null,
  cliente_id uuid not null references public.agencia_clientes(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  motivo     text not null,
  visto_em   timestamptz not null default now(),
  constraint agencia_cofre_visualizacoes_motivo check (motivo in ('ver','relatorio'))
);
create index if not exists agencia_cofre_visualizacoes_item on public.agencia_cofre_visualizacoes (item_id, visto_em desc);

-- O WhatsApp da agência ganha o motivo `formulario` (o link mandado ao cliente).
alter table public.agencia_envios_whatsapp drop constraint if exists agencia_envios_motivo;
alter table public.agencia_envios_whatsapp add constraint agencia_envios_motivo
  check (motivo in ('convite', 'aviso', 'teste', 'reuniao', 'formulario'));

alter table public.agencia_formularios          enable row level security;
alter table public.agencia_cofre_itens          enable row level security;
alter table public.agencia_cofre_visualizacoes  enable row level security;

revoke all on table
  public.agencia_formularios, public.agencia_cofre_itens, public.agencia_cofre_visualizacoes
  from anon, authenticated;
