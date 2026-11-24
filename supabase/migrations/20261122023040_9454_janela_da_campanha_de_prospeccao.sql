-- manifest: **A campanha de prospecção ganha janela própria e pausa/retoma sozinha (issue #4830, saída 1).** Até aqui a janela de disparo era só do NÚMERO (`channel_knobs.prospeccao_dias` + horas de disparo): quem usa um número para dois nichos — um de manhã, outro à tarde — pausava e retomava a mão a cada troca. A janela nova é da CAMPANHA (`config.janela`: dias 0..6, hora de início e de fim, no fuso da organização) e as duas se CRUZAM, não se substituem. A trava de uma campanha `running` por número continua valendo (`prospecting_one_running_canal`, #3896) — a saída 2 da issue é decisão de produto e não entra. A coluna `pausada_pela_janela` é o que separa a pausa AUTOMÁTICA (volta sozinha na abertura) da pausa de quem opera (não volta nunca): pausa manual, arquivamento e início a limpam. O índice parcial serve à varredura do tick, que hoje só via organizações com campanha `running`. Aditiva e idempotente; espelhada no `baseline.sql`.
-- 9454: a campanha de prospecção ganha janela própria (issue #4830, saída 1).
--
-- Sem migration de dados: a janela mora em `config.janela` (jsonb), e campanha
-- que não a tem continua com o comportamento de hoje — nada a preencher.
--
-- A marca `pausada_pela_janela` é COLUNA e não chave de `config` de propósito:
-- `config` é o que o operador configura (e o schema estrito o valida no envio),
-- enquanto "quem pausou" é estado do motor. Gravá-la em `config` faria a
-- campanha perder a própria janela a cada edição do briefing.

alter table public.prospecting_campaigns
  add column if not exists pausada_pela_janela boolean not null default false;

comment on column public.prospecting_campaigns.pausada_pela_janela is
  'A campanha foi pausada pela JANELA dela (#4830)? true = o tick a retoma sozinho na próxima abertura; false = pausa de quem opera (ou início/retomada/arquivamento) e ninguém a retoma sem clique.';

-- A varredura do tick (#4830): "quais organizações têm campanha esperando a
-- janela abrir". Parcial porque só interessa a pausa automática — o universo é
-- minúsculo perto da tabela, e a lista do tick já é limitada em 20 organizações.
create index if not exists prospecting_janela_pausada
  on public.prospecting_campaigns(organization_id)
  where status = 'paused' and pausada_pela_janela;
