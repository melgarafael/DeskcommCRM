-- manifest: A tela de atualização ganha o botão "Forçar atualização" nos estados de falha — o run registra a intenção (--force) e o alvo que a tela mostrou, para o agent.sh rodar `update.sh --to <tag> --force` sem SSH.
--
-- Por que viaja NO RUN: o agente do host só lê o pedido no heartbeat seguinte
-- (de 5 em 5 minutos), e o pedido é a única coisa que atravessa a fronteira.
-- Sem `force_requested` o `POST /system/update` receberia o clique e o agente
-- executaria `update.sh` SEM `--force` — que, com o código já na versão alvo,
-- responde "você já está na versão mais recente", sai com 0 e reporta SUCESSO
-- sem trocar imagem nenhuma. É o falso sucesso que desligava o botão.
--
-- `force_target` é o MESMO `--to` que a tela mostra ao lado do botão
-- (`comandoDeVolta`), derivado no servidor a partir do run de falha — o
-- cliente manda só `{ force: true }`, nunca um comando.

alter table public.system_update_runs
  add column if not exists force_requested boolean not null default false,
  add column if not exists force_target     text    not null default '';

comment on column public.system_update_runs.force_requested is
  'Pedido veio do botão "Forçar atualização" da tela: o agente do host roda o update.sh com --force.';
comment on column public.system_update_runs.force_target is
  'Tag que o update.sh instala neste pedido (o --to), derivada do run de falha que a tela mostrou. Vazio = sem --to: o host resolve o alvo.';
