-- 0329 — CADA LEMBRETE TEM O PRÓPRIO TEXTO, E A LISTA DEIXA DE TER TETO DE 3
--
-- Até aqui o tipo tinha um texto só (`reminder_body`) para todos os degraus, e
-- `fn_degraus_de_lembrete_validos` recusava mais de 3 extras. A tela pedia
-- "e de novo, quantos minutos antes" num campo de vírgulas — não dava para
-- escolher N avisos nem uma frase por aviso.
--
-- `reminder_bodies jsonb` é o mapa minuto → frase dos degraus ADICIONAIS. O
-- principal continua em `reminder_body`: clone que atualiza e nunca abriu a
-- tela nova se comporta como antes. Extra SEM entrada no mapa cai na frase de
-- fábrica do cron, não na do principal — senão "mensagem por lembrete" vira
-- um campo só de novo.
--
-- O teto de 3 extras saiu. A 0254 o pôs para "lembrar não virar insistir";
-- quem opera o tipo é quem decide quantos avisos o cliente recebe. Fica um
-- teto de segurança (20) contra laço de formulário, não contra a operação.
-- `create or replace` da função basta: o CHECK `calendar_event_types_extras_na_faixa`
-- chama a função pelo nome e passa a usar o corpo novo.
--
-- Backfill: extra que hoje compartilha `reminder_body` ganha a mesma frase no
-- mapa, para a primeira varredura depois da atualização não trocar o texto
-- que o cliente já recebia. Só roda onde o mapa ainda está vazio.

alter table public.calendar_event_types
  add column if not exists reminder_bodies jsonb not null default '{}'::jsonb;

create or replace function public.fn_degraus_de_lembrete_validos(p_degraus integer[])
returns boolean
language sql
immutable
as $$
  select coalesce(array_length(p_degraus, 1), 0) <= 20
     and coalesce(bool_and(x between 15 and 10080), true)
    from unnest(coalesce(p_degraus, '{}'::integer[])) as x;
$$;

revoke execute on function public.fn_degraus_de_lembrete_validos(integer[]) from public, anon;
grant execute on function public.fn_degraus_de_lembrete_validos(integer[]) to authenticated, service_role;

create or replace function public.fn_corpos_de_lembrete_validos(p_corpos jsonb)
returns boolean
language sql
immutable
as $$
  select p_corpos is not null
     and jsonb_typeof(p_corpos) = 'object'
     and coalesce((select count(*) from jsonb_object_keys(p_corpos)), 0) <= 20
     and coalesce((
       select bool_and(
         e.key ~ '^[0-9]+$'
         and jsonb_typeof(e.value) = 'string'
         and length(e.value #>> '{}') <= 1000
       )
       from jsonb_each(p_corpos) as e
     ), true);
$$;

revoke execute on function public.fn_corpos_de_lembrete_validos(jsonb) from public, anon;
grant execute on function public.fn_corpos_de_lembrete_validos(jsonb) to authenticated, service_role;

update public.calendar_event_types
   set reminder_bodies = coalesce((
     select jsonb_object_agg(x::text, reminder_body)
       from unnest(reminder_extra_offsets_minutes) as x
   ), '{}'::jsonb)
 where reminder_body is not null
   and length(trim(reminder_body)) > 0
   and coalesce(array_length(reminder_extra_offsets_minutes, 1), 0) > 0
   and reminder_bodies = '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'calendar_event_types_corpos_validos'
       and conrelid = 'public.calendar_event_types'::regclass
  ) then
    update public.calendar_event_types
       set reminder_bodies = '{}'::jsonb
     where not public.fn_corpos_de_lembrete_validos(reminder_bodies);

    alter table public.calendar_event_types
      add constraint calendar_event_types_corpos_validos
      check (public.fn_corpos_de_lembrete_validos(reminder_bodies));
  end if;
end $$;

comment on column public.calendar_event_types.reminder_bodies is
  'Texto de cada lembrete ADICIONAL, chave = minutos antes (string). Extra ausente do mapa usa a frase de fábrica do cron, não reminder_body. Vazio = nenhum extra tem texto próprio.';
