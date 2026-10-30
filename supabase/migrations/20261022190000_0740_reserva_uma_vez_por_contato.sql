-- manifest: A chave `(regra, contato)` ganha uma tabela de RESERVA com índice único, tomada com `insert ... on conflict do nothing` ANTES de executar as ações — é o que faz o segundo dreno concorrente do mesmo contato perder a corrida em vez de rodar a regra outra vez (#2974).
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- O motor consulta "esta regra já rodou para este contato?", executa as ações e
-- só DEPOIS grava a linha do run. Consultar e executar são dois passos, e entre
-- eles cabe outro dreno: o laço do worker e o cron drenam o `event_log` em
-- paralelo e, numa instalação sem worker, o dreno roda dentro da própria
-- requisição de captação. Dois `lead.created` do MESMO contato (o "reenviou
-- porque demorou" da issue) chegam aos dois drenos ao mesmo tempo, os dois leem
-- "nunca rodou", os dois executam e a sequência sai duas vezes — que é
-- exatamente o defeito que a 0733 veio fechar, sobrevivendo à 0733.
--
-- ─── Por que uma tabela, e não uma linha em `automation_rule_runs` ───────────
-- O arbitro da corrida tem de ser uma restrição ÚNICA, e `automation_rule_runs`
-- não pode ter uma em `(organization_id, rule_id, contact_id)`: com a opção
-- DESLIGADA, o mesmo contato rodando a mesma regra em dois eventos diferentes
-- grava DUAS linhas legítimas, e uma restrição única as recusaria (perdendo o
-- registro da segunda execução, não a execução). Um índice único PARCIAL — por
-- uma coluna que dissesse "esta linha é reserva" — resolveria no banco e NÃO no
-- PostgREST: o `on_conflict` que o cliente manda é `on conflict (<colunas>) do
-- nothing`, sem `where`, e o Postgres não aceita um índice parcial como árbitro
-- de um insert sem predicado. Então a reserva mora em tabela própria, cuja
-- chave única é total e é exatamente o que o motor manda no `on_conflict`.
--
-- ─── Por que `on delete cascade` nas três pontas ────────────────────────────
-- A reserva não é auditoria (o registro da execução é, e vive em
-- `automation_rule_runs`): ela é a chave de uma decisão em andamento. Apagar a
-- regra, o contato ou a organização apaga a reserva junto — e a linha de
-- execução, essa sim, sobrevive (`on delete set null` lá, pela 0733). `event_id`
-- é `on delete set null` porque o expurgo do evento não pode ser impedido por
-- uma linha de reserva.
--
-- Aditiva e idempotente: `create table if not exists` + `create unique index if
-- not exists` + `enable row level security` (idempotente) e os `comment on`.
-- Nada é reescrito, nada a corrigir antes de aplicar.

create table if not exists public.automation_rule_contact_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  rule_id uuid not null references public.automation_rules(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  event_id uuid references public.event_log(id) on delete set null,
  created_at timestamptz not null default now()
);

-- A CHAVE DA CORRIDA. É esta restrição que decide quem executa: o dreno que
-- consegue inserir executa, o outro recebe lista vazia (`ignoreDuplicates`) e só
-- registra o bloqueio. `organization_id` vem junto pela doutrina multi-tenant,
-- igual ao índice da 0733.
create unique index if not exists uq_automation_rule_contact_claims_org_regra_contato
  on public.automation_rule_contact_claims (organization_id, rule_id, contact_id);

-- RLS ligada e SEM policy: quem escreve e lê aqui é o motor, com a service role
-- (que não passa por RLS). A tabela nasce fechada para `anon`/`authenticated` —
-- o mesmo desenho de `event_log` para o que não é superfície de tela.
alter table public.automation_rule_contact_claims enable row level security;

comment on table public.automation_rule_contact_claims is
  'Reserva da chave (organization_id, rule_id, contact_id) para a opção "no máximo uma vez por contato" (#2974). O motor insere aqui ANTES de executar as ações: quem insere executa, quem recebe lista vazia (on conflict do nothing) não executa e só registra o bloqueio em automation_rule_runs. Índice único = o árbitro da corrida entre o laço do worker, o cron e o dreno dentro da requisição.';

comment on column public.automation_rule_contact_claims.event_id is
  'O evento que TOMOU a chave (auditoria da decisão: quem reservou, quando). on delete set null: o expurgo do evento não é impedido pela reserva.';

-- Revoke + service role: sem isto a tabela nasce com o grant padrão do Postgres
-- (tudo a PUBLIC, e PUBLIC contém `authenticated`), o invariante de travas a vê
-- como gravável pela sessão e cobra as três travas `support_write_*` que este
-- desenho não quer — quem escreve aqui é o motor, com a service role. Mesmo
-- desenho de event_log (#3267).
revoke all on public.automation_rule_contact_claims from public, anon, authenticated;
grant  all on public.automation_rule_contact_claims to service_role;

notify pgrst, 'reload schema';
