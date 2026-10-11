-- manifest: **Dias da semana da prospecção por conexão.** O domingo único de `channel_knobs.allow_sunday` valia para resposta e disparo juntos: quem desliga o domingo para não prospectar no fim de semana cala junto a resposta de domingo — e quem escreve no domingo espera resposta no domingo. A prospecção ganha os dias próprios em `channel_knobs.prospeccao_dias` (`smallint[]`, 0=domingo … 6=sábado, convenção `getDay`); as horas continuam as da janela de disparo (`window_*_hour`). Coluna `NOT NULL` com default todos os dias (regressão zero para instalação nova) + backfill que congela o comportamento de quem tinha `allow_sunday = false` (seg a sáb) só nas linhas ainda no padrão — reaplicação nunca apaga personalização. CHECK forte (`<@` + `cardinality`), `drop constraint if exists` antes do `add` (reaplicável, como a 0495).
-- 0642: dias da prospecção por conexão.

alter table public.channel_knobs
  add column if not exists prospeccao_dias smallint[] not null default '{0,1,2,3,4,5,6}';

comment on column public.channel_knobs.prospeccao_dias is
  'Dias da semana em que a PROSPECÇÃO pode abordar (0=domingo … 6=sábado). Só a prospecção lê isto; resposta, disparo em massa e retomada seguem allow_sunday. Default = todos os dias (comportamento anterior).';

-- Quem desligou o domingo (allow_sunday = false) prospectava de seg a sáb: congela
-- esse comportamento nas linhas que ainda estão no padrão. A guarda do array cheio
-- impede que uma reaplicação apague dias que o operador já personalizou.
update public.channel_knobs
  set prospeccao_dias = '{1,2,3,4,5,6}'
  where allow_sunday is false
    and prospeccao_dias = '{0,1,2,3,4,5,6}';

-- Reaplicável: o `update.sh` roda o apêndice do baseline em toda atualização, e
-- `add constraint` sem guarda quebra com 'already exists' — ver a 0495.
alter table public.channel_knobs
  drop constraint if exists channel_knobs_prospeccao_dias_validos;

alter table public.channel_knobs
  add constraint channel_knobs_prospeccao_dias_validos
  check (
    prospeccao_dias <@ '{0,1,2,3,4,5,6}'::smallint[]
    and cardinality(prospeccao_dias) between 1 and 7
  );
