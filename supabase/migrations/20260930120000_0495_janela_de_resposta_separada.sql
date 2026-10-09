-- ═══ Janela de RESPOSTA separada da janela de DISPARO (0495) ═══
--
-- O agente passa a poder responder a quem escreveu fora do horário comercial
-- sem abrir junto o disparo em massa, a prospecção e a retomada de conversa
-- parada. As duas coisas eram regidas por UM par (`window_start_hour`/
-- `window_end_hour`), então abrir a resposta para 24h abria também o disparo.
--
-- Por que colunas soltas e não um jsonb: o projeto trata `window_*_hour` como
-- coluna desde a 0010 e a tela de Conexões já os edita. Um `resposta_knobs`
-- nasceria jsonb sem CHECK forte e divergiria do vizinho na mesma tabela.
--
-- ⚠️ Sem DEFAULT: NULL = a resposta herda a janela de disparo, coluna a coluna,
-- que é o comportamento de antes. Quem só atualiza não muda de operação.

-- A primeira versão desta migration (PR #1983, fechado sem merge) chamava as
-- colunas `reengajar_*`. Quem já a aplicou tem os dados lá: renomeia em vez de
-- criar coluna nova ao lado, e a constraint de nome velho sai junto.
do $renomear_reengajar$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'channel_knobs'
                and column_name = 'reengajar_start_hour')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'channel_knobs'
                and column_name = 'resposta_start_hour') then
    alter table public.channel_knobs rename column reengajar_start_hour to resposta_start_hour;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'channel_knobs'
                and column_name = 'reengajar_end_hour')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'channel_knobs'
                and column_name = 'resposta_end_hour') then
    alter table public.channel_knobs rename column reengajar_end_hour to resposta_end_hour;
  end if;
end
$renomear_reengajar$;

alter table public.channel_knobs
  drop constraint if exists channel_knobs_reengajar_horas_validas;

alter table public.channel_knobs
  add column if not exists resposta_start_hour smallint,
  add column if not exists resposta_end_hour smallint;

comment on column public.channel_knobs.resposta_start_hour is
  'Início da janela de RESPOSTA do agente (h, hora local da org). NULL = usa window_start_hour (comportamento anterior).';
comment on column public.channel_knobs.resposta_end_hour is
  'Fim da janela de RESPOSTA do agente (h, exclusivo; 24 = meia-noite). NULL = usa window_end_hour.';

-- 0..24. `end` pode ser 24 (meia-noite seguinte) porque `insideWindow` compara
-- `wall.h < windowEndHour` e a hora local nunca passa de 23.
-- O `drop … if exists` antes do `add` e o que torna a migration reaplicavel:
-- o `update.sh` de quem ja aplicou a 0495 roda o apendice do baseline de novo, e
-- `add constraint` sem guarda quebra com 'already exists'. Mesmo par no baseline.
alter table public.channel_knobs
  drop constraint if exists channel_knobs_resposta_horas_validas;
alter table public.channel_knobs
  add constraint channel_knobs_resposta_horas_validas
  check (
    (resposta_start_hour is null or resposta_start_hour between 0 and 23)
    and (resposta_end_hour is null or resposta_end_hour between 1 and 24)
  );
