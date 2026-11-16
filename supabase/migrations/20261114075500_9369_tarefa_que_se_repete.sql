-- 9369: a TAREFA QUE SE REPETE sozinha (issue #4595).
--
-- "Toda segunda às 9h, ligar para a carteira" era uma tarefa que alguém tinha
-- de criar À MÃO toda semana. O produto já sabia repetir lançamento financeiro
-- (`recurring_entries`) e já sabia aplicar um PLANO de tarefas por automação
-- (`organizations.settings.task_plans`, 0464/#1752) — mas nenhum dos dois
-- responde "toda segunda às 9h": o plano é um comando disparado por um fato do
-- negócio, não um relógio; o molde financeiro é de competência mensal e grava
-- em `financial_entries`, outra tabela.
--
-- ═══ ONDE A REGRA MORA, E POR QUE NÃO É TABELA NOVA ═══
--
-- `recurrence` jsonb na PRÓPRIA tarefa: `{"dias":[1],"hora":9,"ativa":true}`.
-- Tabela nova (`task_recurrences`) custaria a migration tríplice inteira para
-- guardar três números que só a tarefa lê, e a linha da série já é uma tarefa
-- (é ela que a pessoa vê, edita e desliga). O JSON é o mesmo sítio que o
-- produto já usa para configuração em lista (`task_plans`, `lost_reasons`).
--
-- `dias` é o dia da semana LOCAL da organização, domingo = 0 — a mesma régua
-- de `diaDaSemanaLocal` (`lib/agenda/fuso.ts`) e do `dow` da jornada de
-- trabalho. `hora` é 0–23 na hora de PAREDE da organização; o instante nasce
-- de `instanteDe(parede, fuso)`, nunca de UTC cru.
--
-- ═══ A OCORRÊNCIA É UMA TAREFA IRMÃ, E O VÍNCULO É COLUNA ═══
--
-- `recurrence_source_id` aponta para a tarefa que carrega a REGRA. Tarefa com
-- `recurrence` preenchido e `recurrence_source_id` nulo é a SÉRIE; a ocorrência
-- gerada tem `recurrence` nulo (ela não repete, quem repete é a série) e o
-- vínculo preenchido. Duas consequências que valem a coluna:
--
--   1. tarefa SEM recorrência fica exatamente como hoje — as duas colunas
--      nascem nulas e nenhum leitor antigo muda de comportamento;
--   2. a série desligada (`recurrence.ativa = false`) para de gerar sem apagar
--      o que já nasceu: as ocorrências passadas continuam sendo história.
--
-- ═══ IDEMPOTÊNCIA É DO BANCO, NÃO DA ROTINA ═══
--
-- O índice único `(recurrence_source_id, due_date)` é o que impede a mesma
-- ocorrência de nascer duas vezes quando dois geradores rodam no mesmo minuto:
-- o segundo chega no `on conflict do nothing` e sai vazio, que é o desfecho
-- correto. A rotina também evita o trabalho ("já existe ocorrência futura"),
-- mas essa checagem é OTIMIZAÇÃO — quem fecha a corrida é a constraint, do
-- mesmo jeito que em `recurring_entries` (`(recurring_entry_id, entry_date)`).
--
-- Reaplicável: `if not exists` / `drop ... if exists` antes de constraint,
-- índice e comentários.

alter table public.crm_tasks
  add column if not exists recurrence jsonb,
  add column if not exists recurrence_source_id uuid
    references public.crm_tasks(id) on delete cascade;

comment on column public.crm_tasks.recurrence is
  'Regra da SÉRIE: {"dias":[0..6 domingo=0, no fuso da org],"hora":0..23,"ativa":true}. Nula = tarefa avulsa; é o caso de hoje para toda linha antiga.';
comment on column public.crm_tasks.recurrence_source_id is
  'A série que gerou esta ocorrência. Nula nas tarefas avulsas e na própria série (que é quem carrega a regra).';

-- Forma do JSON. `jsonb_typeof` e não uma lista de chaves: o leitor tolerante
-- (`lib/tarefas/recorrencia.ts`) descarta dia/hora inválidos um a um, e uma
-- constraint que exigisse o shape exato recusaria linha escrita à mão que o
-- produto sabe ler — o mesmo motivo pelo qual `task_plans` não tem schema.
alter table public.crm_tasks drop constraint if exists crm_tasks_recurrence_forma;
alter table public.crm_tasks
  add constraint crm_tasks_recurrence_forma
  check (recurrence is null or jsonb_typeof(recurrence) = 'object');

-- A trava da ocorrência repetida. Parcial porque a maioria das linhas não tem
-- série, e porque `due_date` nulo (tarefa sem prazo) nunca é ocorrência gerada.
create unique index if not exists crm_tasks_recurrence_ocorrencia_unica
  on public.crm_tasks (recurrence_source_id, due_date)
  where recurrence_source_id is not null and due_date is not null;

-- A varredura do gerador: só as séries (com regra e sem vínculo). Parcial para
-- o índice não crescer com o histórico de tarefas comuns.
create index if not exists crm_tasks_series_idx
  on public.crm_tasks (organization_id)
  where recurrence is not null and recurrence_source_id is null;

notify pgrst, 'reload schema';
