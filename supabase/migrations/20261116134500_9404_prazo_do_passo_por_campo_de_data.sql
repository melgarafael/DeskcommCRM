-- manifest: o prazo do passo do plano pode contar de um campo de DATA do card, e as tarefas abertas são recalculadas quando a data muda (#4717 item 4)
--
-- ═══ O QUE ESTA MIGRATION ACRESCENTA ═══
--
-- 1. `crm_tasks` ganha a ORIGEM do prazo: a marca do plano (`plan_id`), o passo
--    (`plan_step`), a chave do campo de data (`prazo_campo`), o deslocamento em
--    dias (`prazo_dias`, negativo = antes) e o motivo de ter nascido sem prazo
--    (`prazo_motivo`). A marca da aplicação em `crm_lead_activities` continua
--    sendo a idempotência do plano; estas colunas são o que deixa o GATILHO
--    achar as tarefas daquele plano que ainda estão abertas.
--
-- 2. `fn_prazo_do_campo(dia, dias, fuso)` — a ÚNICA implementação da conta
--    "dia do campo + N dias, às 09:00 no fuso da organização". A aplicação do
--    plano (`lib/tarefas/prazo-relativo.ts`) e o gatilho abaixo chamam a MESMA
--    função: duas cópias da aritmética (uma em TS, outra em SQL) divergiriam no
--    primeiro ajuste, e a divergência seria invisível — as duas "calculam o
--    prazo", só que uma atravessa o horário de verão e a outra não.
--
-- 3. O gatilho `crm_leads_recalcula_prazos_do_plano`: quando a DATA DO CARD
--    muda, as tarefas do plano que ainda estão ABERTAS (`pending`,
--    `in_progress`) são recalculadas; as encerradas (`done`, `cancelled`) não
--    são tocadas — reescrever prazo de tarefa concluída é reescrever histórico,
--    e uma tarefa feita ontem não passa a estar atrasada porque a viagem mudou.
--
-- ═══ POR QUE GATILHO, E NÃO UM TRECHO NA ROTA ═══
--
-- A data do card é escrita por quatro caminhos diferentes: o PATCH do dossiê
-- (`app/api/v1/leads/_handler.ts`), a ação de automação `set_lead_date_field`,
-- a captação por webhook e o clone/mover de card. Um `recalcular()` chamado em
-- cada porta é a regra escrita quatro vezes — e três delas esqueceriam no
-- primeiro ajuste. O gatilho é a única porta que TODOS atravessam.
--
-- O `exception when others` no corpo do gatilho é deliberado: editar o card não
-- pode falhar por causa da consequência. Se a conta der errado, a edição do
-- operador continua valendo e o prazo fica como estava — o desfecho que a
-- pessoa consegue perceber e corrigir.
--
-- ═══ POR QUE 09:00, E NÃO MEIA-NOITE ═══
--
-- O prazo é um dia de TRABALHO. À meia-noite, a tarefa que vence "dia 10" está
-- atrasada durante todo o dia 10 (já passou); às 09:00 ela vence quando o
-- expediente começa — a mesma hora da varredura do gatilho de data
-- (`HORA_DA_VARREDURA`, `lib/automation/cron-de-data.ts`).
--
-- ═══ COMPATIBILIDADE ═══
--
-- Tudo é aditivo: colunas nulas nas tarefas que já existem, funções novas e um
-- gatilho que só age quando `custom_fields` MUDA e existe tarefa de plano
-- aberta com `prazo_campo` preenchido. Plano antigo (`vence_em_dias`) não grava
-- `prazo_campo` nenhum, então o gatilho não tem o que recalcular nele.

alter table public.crm_tasks
  add column if not exists plan_id text,
  add column if not exists plan_step smallint,
  add column if not exists prazo_campo text,
  add column if not exists prazo_dias integer,
  add column if not exists prazo_motivo text;

alter table public.crm_tasks drop constraint if exists crm_tasks_prazo_campo_check;
alter table public.crm_tasks
  add constraint crm_tasks_prazo_campo_check
  check (prazo_campo is null or length(btrim(prazo_campo)) between 1 and 64);

alter table public.crm_tasks drop constraint if exists crm_tasks_prazo_dias_check;
alter table public.crm_tasks
  add constraint crm_tasks_prazo_dias_check
  check (prazo_dias is null or prazo_dias between -365 and 365);

alter table public.crm_tasks drop constraint if exists crm_tasks_prazo_motivo_check;
alter table public.crm_tasks
  add constraint crm_tasks_prazo_motivo_check
  check (
    prazo_motivo is null
    or prazo_motivo in ('campo_de_data_vazio', 'campo_de_data_invalido')
  );

alter table public.crm_tasks drop constraint if exists crm_tasks_plan_step_check;
alter table public.crm_tasks
  add constraint crm_tasks_plan_step_check
  check (plan_step is null or plan_step between 1 and 500);

-- O índice é PARCIAL: só as tarefas de plano ainda abertas interessam ao
-- gatilho, e ele roda a cada gravação de `custom_fields` do card.
create index if not exists crm_tasks_plano_aberto_idx
  on public.crm_tasks (organization_id, plan_id)
  where plan_id is not null and status in ('pending', 'in_progress');

comment on column public.crm_tasks.plan_id is
  'Plano de tarefas que criou a linha (organizations.settings.task_plans[].id). Nulo = tarefa avulsa.';
comment on column public.crm_tasks.prazo_campo is
  'Chave do campo de DATA do negócio de onde o prazo conta (#4717). Nulo = prazo contado da aplicação.';
comment on column public.crm_tasks.prazo_dias is
  'Deslocamento em dias a partir do campo: negativo = antes, positivo = depois, 0 = o próprio dia.';
comment on column public.crm_tasks.prazo_motivo is
  'Por que a tarefa está sem prazo: campo_de_data_vazio | campo_de_data_invalido. Nulo = prazo calculado.';

-- ── O fuso: `organizations.timezone` não tem CHECK ──────────────────────────
-- `at time zone` ESTOURA com fuso inexistente, e um tenant com o campo torto
-- derrubaria toda gravação de `custom_fields`. A função degrada para o padrão
-- do produto em vez de lançar — a mesma decisão de `fusoUtilizavel`
-- (`lib/tempo/fusos.ts`), que é quem valida do lado do TypeScript.
--
-- `set search_path` na PRÓPRIA definição, e não um `alter function` depois: um
-- `create or replace function` posterior, sem a cláusula, apagaria a anterior e
-- o aviso `function_search_path_mutable` voltaria em silêncio
-- (`tests/invariants/avisos-do-security-advisor.test.ts`). Vazio basta: esta
-- função só toca `pg_catalog` (`pg_timezone_names`, `btrim`, `coalesce`) e é
-- chamada daqui por nome qualificado (`public.fn_prazo_do_campo`).
create or replace function public.fn_fuso_valido(p_fuso text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select name from pg_timezone_names where name = btrim(p_fuso)),
    'America/Sao_Paulo'
  )
$$;

-- ── A conta do prazo, num lugar só ──────────────────────────────────────────
-- `(dia + dias)::timestamp + 09:00` é aritmética de CALENDÁRIO: o deslocamento
-- não atravessa fuso nem horário de verão. O `at time zone` converte a hora de
-- parede (09:00 daquele dia, naquele fuso) no instante — e é ele que faz o dia
-- 21 de outubro em São Paulo valer 12:00Z, com ou sem horário de verão.
--
-- Mesma razão da `fn_fuso_valido`: a cláusula mora na definição. Vazio basta —
-- tudo o que o corpo usa é `pg_catalog` (`coalesce`, `time`, `at time zone`) e a
-- outra função entra qualificada.
create or replace function public.fn_prazo_do_campo(
  p_dia date,
  p_dias integer,
  p_fuso text
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (((p_dia + coalesce(p_dias, 0))::timestamp + time '09:00')
    at time zone public.fn_fuso_valido(p_fuso))
$$;

revoke execute on function public.fn_fuso_valido(text) from public, anon, authenticated;
revoke execute on function public.fn_prazo_do_campo(date, integer, text) from public, anon, authenticated;
grant execute on function public.fn_fuso_valido(text) to service_role;
grant execute on function public.fn_prazo_do_campo(date, integer, text) to service_role;

-- ── O recálculo das tarefas abertas do plano ────────────────────────────────
create or replace function public.fn_recalcular_prazos_do_plano()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fuso text := 'America/Sao_Paulo';
  v_linha record;
  v_texto text;
  v_dia date;
  v_novo timestamptz;
  v_motivo text;
begin
  begin
    select public.fn_fuso_valido(o.timezone) into v_fuso
      from public.organizations o
     where o.id = new.organization_id;

    if v_fuso is null then
      v_fuso := 'America/Sao_Paulo';
    end if;

    for v_linha in
      select t.id, t.prazo_campo, t.prazo_dias
        from public.crm_tasks t
       where t.organization_id = new.organization_id
         and t.lead_id = new.id
         and t.plan_id is not null
         and t.prazo_campo is not null
         and t.status in ('pending', 'in_progress')
    loop
      v_texto := nullif(btrim(coalesce(new.custom_fields ->> v_linha.prazo_campo, '')), '');
      v_dia := null;

      -- `YYYY-MM-DD` (o que o `<input type="date">` grava) e data cheia (o que
      -- a API aceita) valem; o resto é "preenchido torto", não "vazio".
      if v_texto is not null and v_texto ~ '^\d{4}-\d{2}-\d{2}' then
        begin
          v_dia := substring(v_texto from 1 for 10)::date;
        exception when others then
          v_dia := null;
        end;
      end if;

      if v_dia is null then
        v_novo := null;
        v_motivo := case
          when v_texto is null then 'campo_de_data_vazio'
          else 'campo_de_data_invalido'
        end;
      else
        v_novo := public.fn_prazo_do_campo(v_dia, coalesce(v_linha.prazo_dias, 0), v_fuso);
        v_motivo := null;
      end if;

      -- `status in (...)` repetido de propósito: entre o SELECT acima e este
      -- UPDATE alguém pode ter concluído a tarefa, e reescrever prazo de tarefa
      -- CONCLUÍDA é reescrever histórico. A condição no UPDATE é a que vale.
      update public.crm_tasks
         set due_date = v_novo,
             prazo_motivo = v_motivo,
             updated_at = now()
       where id = v_linha.id
         and organization_id = new.organization_id
         and status in ('pending', 'in_progress')
         and (due_date is distinct from v_novo
              or prazo_motivo is distinct from v_motivo);
    end loop;
  exception when others then
    -- Editar o card NUNCA falha por causa da consequência: o prazo fica como
    -- estava e a edição do operador continua valendo.
    null;
  end;

  return new;
end;
$$;

revoke execute on function public.fn_recalcular_prazos_do_plano() from public, anon, authenticated;
grant execute on function public.fn_recalcular_prazos_do_plano() to service_role;

drop trigger if exists crm_leads_recalcula_prazos_do_plano on public.crm_leads;
create trigger crm_leads_recalcula_prazos_do_plano
  after update of custom_fields on public.crm_leads
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.fn_recalcular_prazos_do_plano();
