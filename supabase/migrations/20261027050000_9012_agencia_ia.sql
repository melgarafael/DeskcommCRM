-- manifest: área da agência, fase 9 — IA da agência: registro de cada execução (quem pediu, ação do catálogo, modelo, tokens, situação), resultado da IA guardado na tarefa e ação do catálogo escolhida no bloco do mapa e na tarefa; tabela da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-ia-da-agencia.md.
--
-- Mesmo regime das 9003–9011: sem organization_id (é da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy.

create table if not exists public.agencia_execucoes_ia (
  id             uuid primary key default gen_random_uuid(),
  tarefa_id      uuid references public.agencia_tarefas(id) on delete set null,
  mapa_id        uuid references public.agencia_mapas(id) on delete set null,
  acao           text not null,
  pedido_por     uuid references auth.users(id) on delete set null,
  modelo         text,
  tokens_entrada int,
  tokens_saida   int,
  situacao       text not null,
  erro           text,
  criado_em      timestamptz not null default now(),
  constraint agencia_execucoes_ia_acao check (acao in ('propor_mapa','roteiro','legenda','ideias','plano_de_campanha','publicacao')),
  constraint agencia_execucoes_ia_situacao check (situacao in ('ok','falhou'))
);
create index if not exists agencia_execucoes_ia_pessoa on public.agencia_execucoes_ia (pedido_por, criado_em);
create index if not exists agencia_execucoes_ia_tarefa on public.agencia_execucoes_ia (tarefa_id) where tarefa_id is not null;

alter table public.agencia_execucoes_ia enable row level security;
revoke all on table public.agencia_execucoes_ia from anon, authenticated;

alter table public.agencia_tarefas add column if not exists resultado_ia text;
alter table public.agencia_tarefas add column if not exists acao_ia text;
alter table public.agencia_mapa_blocos add column if not exists acao_ia text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agencia_tarefas_acao_ia') then
    alter table public.agencia_tarefas add constraint agencia_tarefas_acao_ia
      check (acao_ia is null or acao_ia in ('roteiro','legenda','ideias','plano_de_campanha','publicacao'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agencia_mapa_blocos_acao_ia') then
    alter table public.agencia_mapa_blocos add constraint agencia_mapa_blocos_acao_ia
      check (acao_ia is null or acao_ia in ('roteiro','legenda','ideias','plano_de_campanha','publicacao'));
  end if;
end $$;
