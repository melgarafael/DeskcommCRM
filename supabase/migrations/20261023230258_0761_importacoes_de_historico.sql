-- manifest: **Estado da importação do histórico do WhatsApp (#999).** Cria `importacoes_de_historico`: uma linha por importação pedida num número conectado, com a janela (`dias` 30/90/180/365), o estado (`previa`/`rodando`/`concluida`/`erro`/`cancelada`), o `cursor` de onde a próxima rodada retoma (`indiceConversa`, `offsetMensagens`, `desde`), a prévia e os contadores (conversas feitas, mensagens gravadas, já existentes, ignoradas, mídias baixadas e indisponíveis). Índice único parcial: no máximo UMA importação `rodando` por número (duas importações do mesmo número andariam o mesmo acervo); o índice não barra duas execuções da MESMA importação: a rodada grava com update condicional (`status = 'rodando'`), que não sobrescreve importação cancelada no meio, e serializar execuções simultâneas é de quem dispara a rodada. RLS: membro da organização lê; escrita só `service_role` (a rodada e as rotas). Tabela nova, sem função, sem dado; idempotente; apêndice igual no fim do `baseline.sql`.

-- ---- estado da importação do histórico do WhatsApp (migration 0761, #999) ----
--
-- A importação traz do celular as conversas anteriores à conexão do número, em
-- RODADAS curtas que retomam de onde pararam (`lib/channels/historico/rodada.ts`).
-- O cursor e os contadores precisam sobreviver entre uma rodada e outra, e a
-- tela precisa ler o andamento: daí a tabela.
--
-- Uma `rodando` por número (índice único parcial): impede duas IMPORTAÇÕES
-- `rodando` no mesmo número, que andariam o mesmo acervo com cursores
-- diferentes. NÃO impede duas EXECUÇÕES da mesma importação (é a mesma linha).
-- O que a rodada faz é gravar com update condicional
-- (`... where id = $1 and status = 'rodando'`): a importação que saiu de
-- `rodando` durante a rodada (cancelada, por exemplo) não é sobrescrita. Duas
-- execuções SIMULTÂNEAS, ambas vendo `rodando`, passam as duas pelo update; a
-- deduplicação por `external_id` evita linha repetida, mas o cursor e os
-- contadores ficam com a última. Serializar as rodadas é de quem as dispara.
-- `previa`,
-- `concluida`, `erro` e `cancelada` não entram no índice: o histórico de
-- importações fica.
--
-- Leitura por membro da organização (`fn_user_org_ids`, o padrão das tabelas
-- por org); escrita só pelo `service_role`: nenhuma policy de escrita e nenhum
-- grant de escrita para `authenticated`.
--
-- Não cria função; fica ANTES das proteções do fim do arquivo (0325/0274), que
-- precisam ver toda tabela de organização na primeira aplicação.
--
-- Gate: `tests/invariants/importacoes-de-historico-rls.test.ts`.

create table if not exists public.importacoes_de_historico (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  status text not null default 'previa'
    check (status in ('previa', 'rodando', 'concluida', 'erro', 'cancelada')),
  dias int not null check (dias in (30, 90, 180, 365)),
  cursor jsonb not null default '{}'::jsonb,
  previa jsonb,
  conversas_feitas int not null default 0,
  mensagens_gravadas int not null default 0,
  mensagens_existentes int not null default 0,
  mensagens_ignoradas int not null default 0,
  midias_baixadas int not null default 0,
  midias_indisponiveis int not null default 0,
  erro text,
  criada_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists importacoes_de_historico_uma_rodando_idx
  on public.importacoes_de_historico (channel_session_id)
  where status = 'rodando';
create index if not exists importacoes_de_historico_org_idx
  on public.importacoes_de_historico (organization_id, created_at desc);

alter table public.importacoes_de_historico enable row level security;
drop policy if exists tenant_isolation_importacoes_de_historico_select on public.importacoes_de_historico;
create policy tenant_isolation_importacoes_de_historico_select on public.importacoes_de_historico
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.importacoes_de_historico from public, anon, authenticated;
grant select on public.importacoes_de_historico to authenticated;
grant all on public.importacoes_de_historico to service_role;

notify pgrst, 'reload schema';
