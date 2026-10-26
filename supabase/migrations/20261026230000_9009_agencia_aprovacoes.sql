-- manifest: área da agência, fase 7 — aprovações do cliente pela organização dele (vídeos, roteiros, artes, estratégia): tabela com organization_id e RLS de tenant só para leitura, escrita só pelo servidor; motivo `aprovacao` no WhatsApp da agência
--
-- Spec: docs/agencia/SPEC-aprovacoes.md.
--
-- DIFERENTE das tabelas 9003–9008 (que são só da instalação): esta tem
-- organization_id, porque o CLIENTE da agência lê pela organização dele. A
-- policy de tenant libera SELECT para quem é da organização (fn_user_org_ids());
-- nenhum papel do PostgREST escreve — aprovar e pedir ajustes passam pela
-- server action, que confere organização ativa, papel e a guarda de suporte.

create table if not exists public.agencia_aprovacoes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cliente_id      uuid not null references public.agencia_clientes(id) on delete cascade,
  tipo            text not null,
  titulo          text not null,
  descricao       text,
  link            text,
  arquivo_id      uuid references public.agencia_arquivos(id) on delete set null,
  tarefa_id       uuid references public.agencia_tarefas(id) on delete set null,
  versao          int not null default 1,
  origem_id       uuid references public.agencia_aprovacoes(id) on delete set null,
  situacao        text not null default 'pendente',
  comentario      text,
  pedido_por      uuid references auth.users(id) on delete set null,
  pedido_em       timestamptz not null default now(),
  respondido_por  uuid references auth.users(id) on delete set null,
  respondido_em   timestamptz,
  constraint agencia_aprovacoes_tipo check (tipo in ('video','roteiro','arte','estrategia','outro')),
  constraint agencia_aprovacoes_situacao check (situacao in ('pendente','aprovado','ajustes','cancelado')),
  constraint agencia_aprovacoes_link check (link is null or link ~* '^https://'),
  constraint agencia_aprovacoes_versao check (versao between 1 and 99)
);
create index if not exists agencia_aprovacoes_org on public.agencia_aprovacoes (organization_id, situacao, pedido_em desc);
create index if not exists agencia_aprovacoes_cliente on public.agencia_aprovacoes (cliente_id, pedido_em desc);
create index if not exists agencia_aprovacoes_tarefa on public.agencia_aprovacoes (tarefa_id) where tarefa_id is not null;

alter table public.agencia_aprovacoes enable row level security;
revoke all on table public.agencia_aprovacoes from anon, authenticated;
grant select on table public.agencia_aprovacoes to authenticated;

drop policy if exists tenant_isolation_agencia_aprovacoes_read on public.agencia_aprovacoes;
create policy tenant_isolation_agencia_aprovacoes_read on public.agencia_aprovacoes
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

-- O WhatsApp da agência ganha o motivo `aprovacao` (aviso ao cliente ou ao grupo).
alter table public.agencia_envios_whatsapp drop constraint if exists agencia_envios_motivo;
alter table public.agencia_envios_whatsapp add constraint agencia_envios_motivo
  check (motivo in ('convite', 'aviso', 'teste', 'reuniao', 'formulario', 'aprovacao'));
