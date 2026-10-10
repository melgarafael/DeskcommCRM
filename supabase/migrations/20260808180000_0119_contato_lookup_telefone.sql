-- 0119 — carimbo da última TENTATIVA de descobrir o telefone do contato.
--
-- ─── Por que uma coluna, e não deduzir de `phone_number is null` ────────────
--
-- O WhatsApp passou a identificar quem escreve por um id opaco em vez do
-- número, e uma instalação real acumula contatos SEM telefone: medido aqui, 52
-- de 54. O canal sabe traduzir, mas a tabela de tradução é povoada por
-- atividade — hoje ela não tem a resposta, semana que vem talvez sim.
--
-- Uma varredura que escolhesse "contatos sem telefone" sem carimbar
-- reprocessaria SEMPRE os mesmos primeiros N, e os do fim da fila nunca
-- chegariam a ser perguntados. Com o carimbo, a ordem é "quem foi perguntado há
-- mais tempo primeiro", e a fila gira.
--
-- ─── Por que NULLABLE, e o que cada estado significa ───────────────────────
--
--   NULL          — nunca perguntamos
--   <timestamp>   — perguntamos nessa data; se `phone_number` continua null,
--                   o canal ainda não sabia
--
-- Um `not null default now()` colapsaria "nunca perguntado" com "perguntado
-- agora e sem resposta", e a varredura passaria a tratar contato novo como já
-- tentado — justamente o que ela precisa distinguir para não deixar ninguém de
-- fora.
--
-- Índice PARCIAL: a varredura só olha quem NÃO tem telefone, que é a minoria
-- que interessa e (numa instalação saudável) encolhe com o tempo. Linha com
-- número não entra no índice nem paga por ele.
--
-- Aditiva e idempotente: coluna nullable, sem constraint nova, nada a corrigir
-- antes. O código antigo não a conhece e não a toca.

alter table public.contacts
  add column if not exists phone_lookup_at timestamptz;

comment on column public.contacts.phone_lookup_at is
  'Última vez que se PERGUNTOU ao canal o telefone por trás da identidade opaca. NULL = nunca perguntado. Com valor e phone_number ainda null = o canal não sabia na ocasião. Usado pelo cron de backfill para girar a fila em vez de reprocessar sempre os mesmos.';

create index if not exists idx_contacts_phone_lookup_pendente
  on public.contacts (organization_id, phone_lookup_at nulls first)
  where phone_number is null;
