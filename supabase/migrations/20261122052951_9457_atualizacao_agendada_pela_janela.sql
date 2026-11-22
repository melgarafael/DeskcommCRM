-- manifest: **O pedido de atualização que espera a janela de manutenção é reconhecido como agendado (#4334, PR #4350, doc 337 = B).** Com `SYSTEM_UPDATE_WINDOW` no `.env`, o `agent.sh` deixa o run em `dispatched` até a janela abrir — horas, de propósito. A cerca entre extensões e atualização (`fn_extensions_core_update_in_progress`, migration 0271) só via "em curso" o run despachado há menos de 15 min, então a proteção se desligava 15 min depois do clique e a atualização da madrugada rodava por cima de uma extensão instalada à tarde. A coluna nova `system_update_runs.scheduled_for` é gravada pelo agente a cada ciclo em que o pedido espera (recado `run_scheduled`): é a próxima rodada dentro da janela. A cerca passa a medir os 15 min a partir do MAIS TARDE entre o despacho e o agendamento — agente morto continua liberando a cerca, só que 15 min depois da hora em que devia ter rodado. Aditiva e idempotente; espelhada no `baseline.sql`. Contribuição de @webtecnica (janela) e conserto nosso (estado agendado).
-- 9457: a atualização agendada pela janela de manutenção (#4334).

alter table public.system_update_runs
  add column if not exists scheduled_for timestamptz;

comment on column public.system_update_runs.scheduled_for is
  'Quando o agent.sh vai executar este pedido, se ele espera a janela de manutenção (SYSTEM_UPDATE_WINDOW, #4334). Gravada pelo agente (run_scheduled) a cada ciclo de espera; nula = sem janela. A cerca das extensões e o "desfecho desconhecido" da tela contam os 15 min a partir do mais tarde entre dispatched_at e esta coluna.';

-- `greatest` ignora o nulo: sem agendamento, é a régua de sempre (dispatched_at).
create or replace function public.fn_extensions_core_update_in_progress()
returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from public.system_update_runs
    where status='dispatched'
      and greatest(dispatched_at, scheduled_for) > now() - interval '15 minutes');
$$;

revoke execute on function public.fn_extensions_core_update_in_progress() from public, anon, authenticated, service_role;
