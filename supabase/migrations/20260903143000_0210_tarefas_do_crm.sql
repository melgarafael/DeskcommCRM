-- ============================================================================
-- 0210 — TAREFAS DO CRM
--
-- Extraída do PR #418, de @clinicacentrodosorrisosc-code (James, Clínica Centro
-- do Sorriso), que rodou o produto seis semanas numa operação real e devolveu o
-- módulo inteiro. O trabalho é dele; o que muda aqui é o vocabulário.
--
-- ─── O que o produto NÃO tinha, e por isso a tabela nasce
--
-- "Ligar de volta na terça", "cobrar o retorno amanhã": até aqui isso vivia na
-- cabeça de quem atende, ou em `custom_fields` do lead — jsonb sem schema, sem
-- índice por prazo, invisível para qualquer lista que pergunte "o que vence
-- hoje". A Agenda (0177) responde a outra pergunta: ela marca COMPROMISSO COM O
-- CLIENTE, com horário, local e confirmação. Uma tarefa é lembrete de trabalho
-- INTERNO — não tem convidado, não tem confirmação, e pode não ter dono.
--
-- ─── Por que `due_date` é timestamptz e NULLABLE
--
-- Nullable porque "algum dia eu preciso" é uma tarefa legítima, e forçar data
-- faria o operador inventar uma — o que envenena a lista de atrasadas, que é a
-- única razão de a coluna existir. `timestamptz` e não `date` porque "às 14h"
-- é a metade da informação que faz a pessoa lembrar.
--
-- ─── `on delete set null` no lead, e não cascade
--
-- Apagar um funil não pode apagar o que a pessoa escreveu para si mesma. A
-- tarefa sobrevive sem o vínculo — anti-pattern nº 7 do CLAUDE.md (cascade
-- fantasma) na direção que dói: perder trabalho digitado.
--
-- ─── Duas policies, e não uma `tenant_isolation_*_all`
--
-- Uma policy `for all` org-flat deixaria qualquer `viewer` criar, editar e
-- APAGAR tarefa dos outros pelo PostgREST com o JWT dele. É a crítica que a
-- 0204 faz a `nuvemshop_products_tenant`, e ela vale igual aqui. Leitura para a
-- organização; escrita a partir de `agent` — o papel de quem atende, que é
-- quem cria tarefa todo dia.
-- ============================================================================

create table if not exists public.crm_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  title text not null,
  description text,

  -- Nula = "sem prazo". Ver o cabeçalho: forçar data envenena a lista de
  -- atrasadas, que é a única razão de a coluna existir.
  due_date timestamptz,

  priority text not null default 'medium',
  status text not null default 'pending',

  -- Os dois vínculos são opcionais: tarefa solta ("revisar os textos do
  -- agente") é caso real, e negá-la obrigaria a inventar um lead.
  lead_id uuid references public.crm_leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,

  -- FK de verdade, não texto. Anti-pattern nº 1 do CLAUDE.md: `owner_email text`
  -- vira inferência por nome no dia em que alguém troca de e-mail.
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint crm_tasks_titulo_nao_vazio check (length(btrim(title)) > 0),
  constraint crm_tasks_priority_check check (priority in ('low','medium','high','urgent')),
  constraint crm_tasks_status_check check (status in ('pending','in_progress','done','cancelled'))
);

-- A consulta da tela: "o que vence, na minha organização, em ordem de prazo".
create index if not exists crm_tasks_org_due_idx
  on public.crm_tasks (organization_id, due_date);

-- O filtro que a lista aplica antes de tudo: só o que ainda está em aberto.
create index if not exists crm_tasks_org_status_idx
  on public.crm_tasks (organization_id, status);

-- As tarefas de UM negócio, para o painel do lead. Parcial porque a maioria das
-- linhas não tem lead, e indexar NULL aqui só engorda o índice.
create index if not exists crm_tasks_lead_idx
  on public.crm_tasks (lead_id) where lead_id is not null;

alter table public.crm_tasks enable row level security;

drop policy if exists crm_tasks_select on public.crm_tasks;
create policy crm_tasks_select on public.crm_tasks
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists crm_tasks_write on public.crm_tasks;
create policy crm_tasks_write on public.crm_tasks
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline alcança
-- TODA tabela criada depois dele — inclusive esta. Sem o revoke, as tarefas da
-- organização ficam legíveis pela anon key, que vai para o browser.
revoke all on public.crm_tasks from anon;
grant select, insert, update, delete on public.crm_tasks to authenticated;
grant all on public.crm_tasks to service_role;

drop trigger if exists trg_crm_tasks_updated_at on public.crm_tasks;
create trigger trg_crm_tasks_updated_at
  before update on public.crm_tasks
  for each row execute function public.fn_set_updated_at();

comment on table public.crm_tasks is
  'Lembrete de trabalho INTERNO com prazo — "ligar de volta na terça". Distinto de calendar_appointments (0177), que é compromisso COM o cliente, com horário, local e confirmação.';
comment on column public.crm_tasks.due_date is
  'Nula = sem prazo. Forçar data faria o operador inventar uma, e um prazo inventado envenena a lista de atrasadas.';
comment on column public.crm_tasks.lead_id is
  'set null, não cascade: apagar o funil não pode apagar o que a pessoa escreveu para si mesma.';

-- ─────────────────────────────────────────────────────────────────────────────
-- LGPD: a anonimização do contato alcança as tarefas dele
--
-- `crm_tasks` tem FK para `contacts` e guarda `title` — texto livre que, na
-- prática, é "Ligar para Fulano confirmar o orçamento". Sem isto, anonimizar um
-- contato devolveria SUCESSO, a contagem por tabela fecharia, o SLA de D+15
-- seria marcado como cumprido, e o nome de quem exerceu o direito de
-- apagamento continuaria legível. Nada erra e nada loga — é o modo de falha que
-- `tests/invariants/lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` existe
-- para pegar, e foi ELE que pegou esta tabela.
--
-- TRIGGER e não um passo dentro de `fn_lgpd_cascade_redact_contact`, pelo mesmo
-- motivo escrito nas migrations 0174 e 0184: aquela função vem do dump com ~180
-- linhas, e acrescentar um passo obrigaria a carregar uma CÓPIA inteira dela no
-- apêndice do baseline — duas cópias que divergem no primeiro conserto. O
-- gancho é a transição `is_anonymized false → true` na própria `contacts`, que
-- é o último fato da anonimização, roda na MESMA transação, e alcança QUALQUER
-- caminho que anonimize um contato, não só o cascade.
--
-- O que é PRESERVADO: prazo, situação, prioridade e o vínculo com o negócio.
-- Que houve uma tarefa, e quando ela venceu, é registro de operação — não é
-- dado da pessoa.
create or replace function public.fn_redigir_tarefas_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.crm_tasks
     set title       = 'Tarefa anonimizada',
         description = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

-- Função de trigger não exige EXECUTE de quem dispara o UPDATE, então revogar
-- das três origens não a quebra — e a mantém fora da lista de exceções do
-- invariante de hardening, que é congelada.
revoke execute on function public.fn_redigir_tarefas_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_tarefas_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_tarefas_ao_anonimizar on public.contacts;
create trigger trg_redigir_tarefas_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_tarefas_do_contato_anonimizado();

comment on column public.crm_tasks.title is
  'Texto livre do operador — "Ligar para Fulano confirmar o orçamento". É dado pessoal quando a tarefa aponta para um contato: o trigger trg_redigir_tarefas_ao_anonimizar o substitui por "Tarefa anonimizada" e apaga a descrição quando o contato é anonimizado. Prazo, situação e prioridade são PRESERVADOS — que houve tarefa e quando ela venceu é registro de operação.';
