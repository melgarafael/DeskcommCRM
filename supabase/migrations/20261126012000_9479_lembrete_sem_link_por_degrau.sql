-- 9479 — o lembrete de cada degrau pode sair SEM o link da reunião (#5154)
-- manifest: Cada degrau do lembrete ganha o direito de sair sem o link da reunião (calendar_event_types.reminder_sem_link_offsets_minutes, lista de minutos dos degraus que NÃO levam o link). Vazio — o default, e o valor de toda linha existente — significa todos levam, o comportamento de hoje; coluna só, sem backfill e sem mudar nenhum envio.
--
-- ─── O defeito que a issue #5154 mediu ────────────────────────────────────
--
-- Num tipo Google Meet, `montarLembrete` acrescenta "Link da reunião: …" a TODO
-- lembrete cujo texto não use `{{link}}`. Com degraus de 60 e 15 minutos, o
-- contato recebe o mesmo endereço três vezes (na entrega do link, no lembrete
-- de 1 h e no de 15 min), e a issue mediu 6 vezes em 5 horas somando
-- remarcação e respostas da equipe. Não havia como dizer "este degrau não
-- leva link": o mapa `reminder_bodies` é minuto → texto, e texto vazio cai na
-- frase de fábrica, que também leva o link.
--
-- ─── Por que uma lista de "sem link", e não um booleano por degrau ────────
--
-- O padrão de produto é LIGADO em todos os degraus (decisão do mantenedor:
-- "a chave por degrau, ligada por padrão, é aditiva"). Guardar a EXCEÇÃO numa
-- lista de minutos faz o default do banco ('{}') já ser "todos levam", então
-- instalação que atualiza não muda um byte do que manda — nem precisa de
-- backfill. Um booleano por degrau exigiria uma tabela/estrutura nova ou
-- TRUE em toda linha, e a primeira varredura depois do deploy teria de saber
-- diferenciar "nunca configurado" de "desligado".
--
-- A tela grava a lista inteira a cada salvamento (o mesmo desenho de
-- `reminder_bodies`), então degrau que muda de minutos ou some não deixa
-- entrada velha: uma linha que não está na lista leva o link.
--
-- ─── O que NÃO muda ──────────────────────────────────────────────────────
--
-- Sem backfill, sem UPDATE, sem trigger. Quem rodar o SQL duas vezes (o
-- `update.sh` reaplica o apêndice do baseline) cai no `if not exists`.
-- Leitura antiga não seleciona a coluna e continua mandando o link em todos os
-- degraus: a compatibilidade é para trás, não um modo novo.
alter table public.calendar_event_types
  add column if not exists reminder_sem_link_offsets_minutes integer[] not null default '{}';

comment on column public.calendar_event_types.reminder_sem_link_offsets_minutes is
  'Degraus (minutos antes) cujo lembrete sai SEM a linha automática do link da reunião (#5154). Vazio = todos levam, o comportamento de sempre: é o default e o valor de toda linha que já existe, então atualizar não muda nenhum envio. A tela grava a lista inteira a cada salvamento; degrau fora da lista leva o link.';
