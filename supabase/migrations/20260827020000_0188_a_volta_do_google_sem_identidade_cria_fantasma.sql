-- 0188 — a volta do Google sem identidade cria compromisso fantasma
--
-- O QUÊ: acrescenta `ical_uid` a `public.calendar_external_events`.
--
-- POR QUÊ, e o custo já está sendo pago em dois lugares:
--
-- `calendar_appointments` guarda `google_ical_uid` desde a 0177 — o lado de IDA
-- sabe qual evento do Google é nosso. A linha de VOLTA não guardava nada
-- equivalente: `external_event_id` é o id do Google, não a nossa identidade.
-- Sem ela não existe chave entre o evento que voltou e o agendamento que o
-- originou, e as duas consequências já estão medidas:
--
--  1. COMPROMISSO FANTASMA. Um agendamento nosso que a pessoa MOVEU no Google
--     volta pelo sync e ocupa o horário NOVO, enquanto `calendar_appointments`
--     segue ocupando o ANTIGO. O mesmo compromisso bloqueia dois horários, e
--     nada liga um ao outro para desfazer.
--  2. O CRON DO "ACONTECEU?" NÃO PODE PERGUNTAR. Para saber se um compromisso
--     foi cancelado do lado de lá, a única alternativa sem identidade é casar
--     por mesmo dono e mesma janela — heurística que erra nos dois sentidos, e
--     cujo falso positivo é DESTRUTIVO: cancelaria um compromisso real porque
--     outro evento na mesma janela foi cancelado. O passo está barrado no
--     handler, esperando esta coluna.
--
-- Com ela, o anti-eco (`ehIcalUidNosso`, `lib/agenda/google/evento.ts`) deixa de
-- ser função pura sem consumidor e passa a filtrar na hora da escrita: evento
-- que nós mesmos criamos não é reimportado como se fosse de terceiro.
--
-- ADITIVA e idempotente: coluna nova, anulável, sem default e sem constraint —
-- nada a corrigir antes, e o `update.sh` de um clone com dados a aplica sem
-- tocar em linha nenhuma.

alter table public.calendar_external_events
  add column if not exists ical_uid text;

comment on column public.calendar_external_events.ical_uid is
  'O iCalUID que o Google devolveu. É por ele que se reconhece um evento criado por nós (sufixo do produto) e que se liga a linha ao calendar_appointments correspondente.';

-- Parcial: só as linhas que TÊM uid entram, que são as que alguém procura.
create index if not exists calendar_external_events_ical_uid_idx
  on public.calendar_external_events (organization_id, ical_uid)
  where ical_uid is not null;
