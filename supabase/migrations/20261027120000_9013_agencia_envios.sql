-- manifest: área da agência, envios — vídeo (até 2 GB), arte, roteiro e aviso para o cliente ver DENTRO do sistema: arquivo e texto na aprovação, tipo aviso com situação ciente, bucket privado agencia-envios e a fila de cópia para o Google Drive (tabela da instalação, só o servidor lê e escreve)
--
-- Spec: docs/agencia/SPEC-envios.md.

-- O que o cliente vê sem sair do sistema (E2–E5). `arquivo_caminho` é caminho no
-- bucket privado, nunca URL: a URL é assinada a cada abertura da tela.
alter table public.agencia_aprovacoes add column if not exists texto              text;
alter table public.agencia_aprovacoes add column if not exists arquivo_caminho    text;
alter table public.agencia_aprovacoes add column if not exists arquivo_nome       text;
alter table public.agencia_aprovacoes add column if not exists arquivo_mime       text;
alter table public.agencia_aprovacoes add column if not exists arquivo_bytes      bigint;
alter table public.agencia_aprovacoes add column if not exists arquivo_apagado_em timestamptz;

-- O aviso (só ciência) entra no vocabulário fechado.
alter table public.agencia_aprovacoes drop constraint if exists agencia_aprovacoes_tipo;
alter table public.agencia_aprovacoes add constraint agencia_aprovacoes_tipo
  check (tipo in ('video','roteiro','arte','estrategia','outro','aviso'));
alter table public.agencia_aprovacoes drop constraint if exists agencia_aprovacoes_situacao;
alter table public.agencia_aprovacoes add constraint agencia_aprovacoes_situacao
  check (situacao in ('pendente','aprovado','ajustes','cancelado','ciente'));
alter table public.agencia_aprovacoes drop constraint if exists agencia_aprovacoes_arquivo;
alter table public.agencia_aprovacoes add constraint agencia_aprovacoes_arquivo
  check (arquivo_caminho is null or (arquivo_caminho !~ '\.\.' and arquivo_bytes is not null and arquivo_bytes between 1 and 2147483648));

-- A fila de cópia para o Drive (E6–E9). Da INSTALAÇÃO: a sessão resumível do
-- Drive permite gravar, e agencia_aprovacoes é legível pela organização do cliente.
create table if not exists public.agencia_envios_copias (
  aprovacao_id     uuid primary key references public.agencia_aprovacoes(id) on delete cascade,
  situacao         text not null default 'aguardando',
  sessao           text,
  enviados         bigint not null default 0,
  tentativas       int not null default 0,
  drive_arquivo_id text,
  drive_link       text,
  erro             text,
  avisado_em       timestamptz,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  constraint agencia_envios_copias_situacao check (situacao in ('aguardando','copiando','copiado','falhou'))
);
create index if not exists agencia_envios_copias_pendentes on public.agencia_envios_copias (atualizado_em) where situacao in ('aguardando','copiando','falhou');

alter table public.agencia_envios_copias enable row level security;
revoke all on table public.agencia_envios_copias from anon, authenticated;

-- Bucket privado; só o servidor (service_role) assina envio e leitura.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agencia-envios', 'agencia-envios', false, 2147483648,
        array['video/mp4','video/quicktime','video/webm','image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
