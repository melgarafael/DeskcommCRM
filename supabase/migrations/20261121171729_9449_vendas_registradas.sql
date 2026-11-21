-- manifest: Vendas registradas — a venda como registro próprio, com valor, data e tags, ligada ao negócio e ao contato; o mesmo negócio aceita várias vendas (recompra), e a venda conta no painel em qualquer etapa do card.
--
-- ─── O que esta tabela responde ────────────────────────────────────────────
-- "O cliente comprou, quanto e quando" — independente de onde o card está no
-- funil. Até aqui a venda só existia como NEGÓCIO GANHO (`crm_leads.status =
-- 'won'`, um valor e uma data por card): a recompra exigia card novo, e o card
-- que vendeu mas seguiu em outra etapa (pós-venda, entrega) não contava.
--
-- ─── Por que não a comanda (`sales`) ───────────────────────────────────────
-- A comanda pertence ao módulo opcional Financeiro (tabelas nascem na
-- instalação do módulo), com caixa, itens e comissão. Quem só quer registrar
-- "vendeu R$ 180 em 20/11, tag atacado" não instala um módulo de caixa. Se a
-- proposta #4860 (comanda → Vendas) entrar na versão oficial, esta tabela é o
-- que migra para lá: uma linha por venda, com valor, moeda e data.
--
-- ─── As cercas no próprio banco ────────────────────────────────────────────
--  - valor em centavos inteiros, não negativo; moeda ISO-4217 (3 letras);
--  - a venda aponta para negócio e contato por FK; que o negócio e o contato
--    são da MESMA organização da venda é conferido pela rota antes de gravar
--    (a organização vem do cookie, nunca do corpo);
--  - `data` é o DIA da venda na parede da empresa (date, não instante): o
--    relatório filtra por dia de calendário, sem conversão de fuso;
--  - tags normalizadas por quem grava (rota), guardadas em text[] com GIN.
--
-- ─── Leitura pela RLS, escrita só pela rota ────────────────────────────────
-- `authenticated` só LÊ, pela organização (mesma régua das tabelas de módulo
-- recentes). Gravar e apagar passam por `/api/v1/vendas`, que confere papel,
-- organização do cookie e o negócio, e audita.

create table if not exists public.vendas_registradas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid,
  contact_id uuid,
  valor_cents bigint not null,
  moeda text not null default 'BRL',
  data date not null,
  tags text[] not null default '{}',
  observacao text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendas_registradas_valor_nao_negativo check (valor_cents >= 0),
  constraint vendas_registradas_moeda_iso check (moeda ~ '^[A-Z]{3}$'),
  constraint vendas_registradas_observacao_curta check (observacao is null or char_length(observacao) <= 500),
  constraint vendas_registradas_dono check (lead_id is not null or contact_id is not null)
);

-- FKs em bloco idempotente (a migration roda de novo sem erro). Negócio ou
-- contato apagado não apaga a venda: o registro do dinheiro fica, sem o elo.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vendas_registradas_lead_fk') then
    alter table public.vendas_registradas
      add constraint vendas_registradas_lead_fk
      foreign key (lead_id) references public.crm_leads(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vendas_registradas_contact_fk') then
    alter table public.vendas_registradas
      add constraint vendas_registradas_contact_fk
      foreign key (contact_id) references public.contacts(id) on delete set null;
  end if;
end $$;

create index if not exists idx_vendas_registradas_org_data
  on public.vendas_registradas (organization_id, data desc);
create index if not exists idx_vendas_registradas_lead
  on public.vendas_registradas (organization_id, lead_id, data desc);
create index if not exists idx_vendas_registradas_contato
  on public.vendas_registradas (organization_id, contact_id, data desc);
create index if not exists idx_vendas_registradas_tags
  on public.vendas_registradas using gin (tags);

comment on table public.vendas_registradas is
  'Venda registrada no negócio ou no contato: valor em centavos, moeda, dia da venda e tags. Várias por negócio (recompra). Conta no painel de vendas em qualquer etapa do card; negócio ganho sem venda registrada continua contando pelo próprio valor.';

alter table public.vendas_registradas enable row level security;

drop policy if exists tenant_isolation_vendas_registradas_select on public.vendas_registradas;
create policy tenant_isolation_vendas_registradas_select
  on public.vendas_registradas
  for select to authenticated using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

revoke all on public.vendas_registradas from public, anon, authenticated;
grant select on public.vendas_registradas to authenticated;
grant all on public.vendas_registradas to service_role;

notify pgrst, 'reload schema';
