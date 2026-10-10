-- O lembrete passa a ter mais de um degrau.
--
-- Até aqui cada tipo de evento tinha UM lembrete (`reminder_minutes_before`) e
-- cada compromisso UM carimbo (`reminder_sent_at`). Quem quer avisar com um dia
-- de antecedência E de novo poucas horas antes — a combinação que todo negócio
-- que marca hora usa — não tinha como: ligar o segundo aviso exigiria apagar o
-- primeiro.
--
-- ═══ POR QUE "EXTRAS", E NÃO UMA LISTA QUE SUBSTITUI ═══
--
-- A modelagem óbvia seria trocar `reminder_minutes_before int` por uma lista e
-- migrar o valor para dentro dela. Isso obrigaria a tela, a rota, a projeção de
-- `lib/agenda/consulta.ts` e todo clone a mudar de semântica ao mesmo tempo, e
-- deixaria a coluna antiga por anos como sinônimo da nova — a duplicação sem
-- fonte declarada que o anti-pattern 2 nomeia.
--
-- `reminder_extra_offsets_minutes` não é sinônimo de nada: é o conjunto dos
-- degraus ADICIONAIS. Os degraus efetivos são `reminder_minutes_before` mais
-- estes. Um clone que atualiza recebe `'{}'` e se comporta exatamente como
-- antes, sem backfill e sem nada para decidir.
--
-- ═══ O CARIMBO PRECISA SER POR DEGRAU ═══
--
-- `reminder_sent_at` responde "já saiu algum?", e essa pergunta deixa de bastar
-- quando há dois: com ela como filtro, o compromisso que recebeu o aviso de um
-- dia nunca voltaria para receber o de três horas. `reminder_sent_offsets_minutes`
-- responde "quais já saíram", que é a pergunta que o cron passa a fazer.
--
-- `reminder_sent_at` CONTINUA sendo escrito e continua significando o que diz —
-- o instante do último lembrete enviado. Ele não é mais a autoridade sobre o
-- que falta enviar, e o comentário da coluna passa a dizer isso, para que a
-- próxima pessoa não o reuse como filtro.
--
-- O backfill marca o degrau principal como enviado onde já havia carimbo: sem
-- ele, todo compromisso já lembrado de um clone em atualização entraria na
-- primeira varredura como se nunca tivesse recebido nada, e a pessoa receberia
-- o lembrete duas vezes.

alter table public.calendar_event_types
  add column if not exists reminder_extra_offsets_minutes integer[] not null default '{}';

alter table public.calendar_appointments
  add column if not exists reminder_sent_offsets_minutes integer[] not null default '{}';

-- A faixa é a mesma que a rota já cobra do degrau principal (15 min a 7 dias), e
-- o teto de 3 extras existe para que "lembrar" não vire "insistir": quatro avisos
-- do mesmo compromisso é o que faz a pessoa bloquear o número.
--
-- A validação mora numa função porque CHECK não aceita subconsulta, e conferir
-- cada elemento de um array exige `unnest`. `immutable` é o que torna a função
-- utilizável em CHECK; sem isso o Postgres recusa a constraint.
create or replace function public.fn_degraus_de_lembrete_validos(p_degraus integer[])
returns boolean
language sql
immutable
as $$
  select coalesce(array_length(p_degraus, 1), 0) <= 3
     and coalesce(bool_and(x between 15 and 10080), true)
    from unnest(coalesce(p_degraus, '{}'::integer[])) as x;
$$;

-- Nasce exposta: o ALTER DEFAULT PRIVILEGES do baseline concede a `anon` toda
-- função criada depois dele, e o Postgres concede a PUBLIC ao criar. As duas
-- origens são distintas e revogar uma não remove a outra.
revoke execute on function public.fn_degraus_de_lembrete_validos(integer[]) from public, anon;
grant execute on function public.fn_degraus_de_lembrete_validos(integer[]) to authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_event_types_extras_na_faixa'
       and conrelid = 'public.calendar_event_types'::regclass
  ) then
    -- Dados fora da faixa não existem (a coluna nasce agora, vazia), mas a
    -- ordem continua sendo a da doutrina: corrigir antes de constranger.
    update public.calendar_event_types
       set reminder_extra_offsets_minutes = '{}'
     where not public.fn_degraus_de_lembrete_validos(reminder_extra_offsets_minutes);

    alter table public.calendar_event_types
      add constraint calendar_event_types_extras_na_faixa
      check (public.fn_degraus_de_lembrete_validos(reminder_extra_offsets_minutes));
  end if;
end $$;

update public.calendar_appointments a
   set reminder_sent_offsets_minutes = array[t.reminder_minutes_before]
  from public.calendar_event_types t
 where a.event_type_id = t.id
   and a.reminder_sent_at is not null
   and coalesce(array_length(a.reminder_sent_offsets_minutes, 1), 0) = 0;

comment on column public.calendar_event_types.reminder_extra_offsets_minutes is
  'Degraus ADICIONAIS de lembrete, em minutos antes do compromisso. Os degraus efetivos são reminder_minutes_before mais estes. Vazio = um lembrete só, o comportamento anterior.';

comment on column public.calendar_appointments.reminder_sent_offsets_minutes is
  'Quais degraus de lembrete já saíram para este compromisso. É a autoridade sobre o que falta enviar — reminder_sent_at guarda apenas o instante do último envio e NÃO deve ser usado como filtro.';

comment on column public.calendar_appointments.reminder_sent_at is
  'Instante do último lembrete enviado. Informativo: quem decide o que ainda falta enviar é reminder_sent_offsets_minutes.';
