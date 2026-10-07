-- manifest: **A remarcação passa a carimbar QUANDO o horário atual foi gravado (#2230, seguimento do #2226/#2223).** A régua do degrau vencido na marcação é `calendar_appointments.created_at`, e `created_at` não muda quando a reunião é REMARCADA: reunião criada 3 dias antes e remarcada às 18:30 para as 16h do dia seguinte mantém a véspera (1440 min) "vencida desde 16:00 de hoje", e a primeira varredura depois da remarcação manda o aviso minutos depois de o agente confirmar o novo horário — o mesmo defeito da #2223 com outro gatilho. Coluna `starts_at_marked_at timestamptz` NULL-ável, SEM backfill, gravada por gatilho (`before update of starts_at`, guarda `is distinct from` porque o `fn_appointment_change` SEMPRE nomeia `starts_at` no SET mesmo quando o patch não o traz). `updated_at` não serve (link do Meet e cada revisão o reescrevem e descartaria degraus ARMADOS) nem `revision_started_at` (ele vira com status e conversa, e confirmar um compromisso já dentro de 24h mataria a véspera armada) — as duas medições estão no corpo do arquivo. Quem lê é a rota `app/api/v1/cron/agenda-reminder/route.ts`, que passa a preferir `starts_at_marked_at` e cai em `created_at` quando a linha nunca foi remarcada. Aditiva e idempotente (`add column if not exists`, `drop trigger if exists`, `create or replace`); apêndice no `baseline.sql` ANTES da varredura anon (cria função). Gates: `lib/agenda/aviso-do-compromisso-lembrete.test.ts` (o caso medido não dispara e o degrau armado continua saindo na hora certa), `app/api/v1/cron/agenda-reminder/route.test.ts` (a rota lê a coluna e a passa) e `tests/unit/remarcacao-carimba-quando-o-horario-foi-marcado.test.ts` (coluna + gatilho nos DOIS artefatos, antes da varredura).
-- 0536: a remarcação carimba quando o `starts_at` atual foi marcado (#2230).
--
-- O DEFEITO, medido na issue com o fonte de `degrausPendentes` do head 6ed38c78c:
-- reunião criada 3 dias antes, remarcada às 18:30 para as 16h do dia seguinte,
-- varredura às 18:35 → `[1440]`. A véspera sai um minuto depois da remarcação.
--
-- A REGUA. `vencidoNaMarcacao` pergunta "a hora deste degrau já tinha passado
-- quando ESTA data foi marcada?" e compara contra `created_at`. Depois de uma
-- remarcação, a resposta certa vem do instante em que o `starts_at` ATUAL foi
-- gravado — `created_at` continua sendo a marcação ORIGINAL, que a nova data não
-- tem nada a ver com.
--
-- As duas alternativas da issue, medidas antes de escolher:
--
--   - `updated_at`: não serve. O link do Meet e cada revisão reescrevem a linha,
--     e descartaria degraus ARMADOS quando o link ficasse pronto dentro da
--     última hora antes da reunião — sumindo com o lembrete em silêncio, o
--     defeito simétrico (razão escrita em `vencidoNaMarcacao`, da #2223).
--   - `revision_started_at`: também não. Medido em `fn_appointment_stamp`
--     (baseline): ele vira quando `starts_at`, `ends_at`, `status`, `contact_id`
--     ou `conversation_id` mudam. Confirmar um compromisso já dentro de 24h
--     reposicionaria a régua para DEPOIS da hora da véspera e mataria o degrau
--     armado — um lembrete sumindo em silêncio trocado por outro.
--
-- A coluna própria cobre o caso e nenhum dos dois defeitos: ela só anda quando
-- `starts_at` muda.
--
-- O carimbo mora num GATILHO, e não no handler de remarcação: a remarcação
-- entra por vários caminhos (a tela, `crm_reschedule_appointment` da ferramenta
-- MCP, a reconciliação do Google em `fn_appointment_change_core`) e todos passam
-- pelo mesmo UPDATE — mas o gatilho é o único ponto que não depende de quem
-- escreve lembrar de gravar.
--
-- O guard é `is distinct from`, e não igualdade simples: `fn_appointment_change`
-- monta o SET com `case when p_patch?'starts_at' then … else starts_at end`, ou
-- seja, SEMPRE nomeia a coluna. Nomear não é mudar; sem o guard todo UPDATE de
-- nota ou de status reposicionaria a régua e mataria a véspera armada.
--
-- Reaplicável: `add column if not exists`, `create or replace`, `drop trigger if
-- exists`. Sem backfill: linha nunca remarcada fica `NULL` e o leitor cai em
-- `created_at`, que é o comportamento de antes — a regra só muda para quem de fato
-- remarcar.
-- ---- a remarcação carimba quando o horário foi marcado (migration 0536) ----
alter table public.calendar_appointments
  add column if not exists starts_at_marked_at timestamptz;

comment on column public.calendar_appointments.starts_at_marked_at is
  'Instante em que o starts_at ATUAL foi gravado — a régua do degrau de lembrete vencido na marcação (#2223) depois de uma remarcação (#2230). NULL = a linha nunca foi remarcada; quem lê (a rota agenda-reminder) cai em created_at.';

create or replace function public.fn_starts_at_marked_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.starts_at is distinct from old.starts_at then
    new.starts_at_marked_at := clock_timestamp();
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_starts_at_marked_at() from public, anon, authenticated;
grant execute on function public.fn_starts_at_marked_at() to service_role;

drop trigger if exists trg_starts_at_marked_at on public.calendar_appointments;
create trigger trg_starts_at_marked_at
  before update of starts_at on public.calendar_appointments
  for each row execute function public.fn_starts_at_marked_at();
