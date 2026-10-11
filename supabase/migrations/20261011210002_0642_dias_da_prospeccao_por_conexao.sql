-- manifest: **Dias da semana da prospecção por conexão.** O domingo único de `channel_knobs.allow_sunday` valia para resposta e disparo juntos: quem desliga o domingo para não prospectar no fim de semana cala junto a resposta de domingo — e quem escreve no domingo espera resposta no domingo. A prospecção ganha os dias próprios em `channel_knobs.prospeccao_dias` (`smallint[]`, 0=domingo … 6=sábado, convenção `getDay`); as horas continuam as da janela de disparo (`window_*_hour`). Coluna `NOT NULL` com default todos os dias (regressão zero para instalação nova) + backfill que congela o comportamento de quem tinha `allow_sunday = false` (seg a sáb) que roda uma vez só, quando a coluna nasce — reaplicação nunca reescreve a escolha do operador. CHECK forte (`<@` + `cardinality`), coluna, backfill e troca da constraint num bloco `DO` (reaplicável, como a 0495, e sem janela sem guarda).
-- 0642: dias da prospecção por conexão.

-- Coluna + backfill só quando a coluna ainda não existe: o `update.sh` reaplica o
-- apêndice do baseline em toda atualização, e um backfill solto reescreveria a
-- escolha do operador a cada uma. A troca da constraint vai no mesmo bloco: o
-- `update.sh` roda sem ON_ERROR_STOP, e drop/add soltos podiam deixar a tabela
-- sem a guarda (ver a 0495).
do $dias$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'channel_knobs'
      and column_name = 'prospeccao_dias'
  ) then
    alter table public.channel_knobs
      add column prospeccao_dias smallint[] not null default '{0,1,2,3,4,5,6}';
    update public.channel_knobs
      set prospeccao_dias = '{1,2,3,4,5,6}'
      where allow_sunday is false;
  end if;
  alter table public.channel_knobs
    drop constraint if exists channel_knobs_prospeccao_dias_validos;
  alter table public.channel_knobs
    add constraint channel_knobs_prospeccao_dias_validos
    check (
      prospeccao_dias <@ '{0,1,2,3,4,5,6}'::smallint[]
      and cardinality(prospeccao_dias) between 1 and 7
    );
end $dias$;

comment on column public.channel_knobs.prospeccao_dias is
  'Dias da semana em que a PROSPECÇÃO pode abordar (0=domingo … 6=sábado). Só a prospecção lê isto; resposta, disparo em massa e retomada seguem allow_sunday. Default = todos os dias (comportamento anterior).';
