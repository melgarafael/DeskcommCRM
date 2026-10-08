-- manifest: **O nome salvo na agenda do celular vai para um campo que só a equipe vê (PR #2439, de @felpzGondim).** `contacts.address_book_name`: escrito pela varredura `contact-names` (pergunta ao canal) e pelo contato do endereço do app WhatsApp Business (coexistência, que antes gravava em `display_name`). Nunca em `name` nem `display_name`: `name` entra no `{{nome}}` das automações e `name`/`display_name` no das campanhas, e o rótulo da agenda pode ser apelido interno. A inbox e a ficha o mostram; mensagem nenhuma o usa. `contacts.name_lookup_at`: carimbo da última tentativa (NULL = nunca perguntado), para a fila girar. Índice parcial em quem não tem `name` nem `address_book_name`. LGPD: gatilho `before insert or update` (`fn_contato_anonimizado_esquece_a_agenda`, revogada de public/anon/authenticated) zera o campo em toda linha anonimizada. Sem backfill: o `display_name` que a coexistência já gravou não se distingue do apelido do perfil. Apêndice no `baseline.sql`, antes da VARREDURA anon. Gates: `tests/unit/nome-da-agenda-nunca-vai-ao-cliente.test.ts`, `tests/unit/cron-contact-names.test.ts`.

-- 0593 — o nome salvo na agenda do celular, num campo que SÓ A EQUIPE vê
-- (PR #2439, de @felpzGondim).
--
-- O webhook só traz o apelido do perfil. Contato salvo no aparelho e sem
-- apelido fica sem nome, e a inbox mostra o telefone. A varredura
-- `contact-names` pergunta ao canal o nome da agenda; o app WhatsApp Business
-- (coexistência) também o entrega, pelo `smb_app_state_sync`.
--
-- POR QUE UM CAMPO PRÓPRIO, e não `name` nem `display_name`: o nome da agenda é
-- o rótulo que alguém da empresa escreveu no celular ("João obra", às vezes
-- algo menos gentil). `name` entra no `{{nome}}` das automações; `name` e, na
-- falta dele, `display_name` entram no `{{nome}}` das campanhas. Gravado em
-- qualquer um dos dois, o apelido interno chegaria ao próprio cliente numa
-- saudação. Decisão do mantenedor: a agenda serve para a equipe RECONHECER o
-- contato (caixa de entrada e ficha) e nunca vai em mensagem. Para usar o nome
-- numa mensagem, alguém o copia para o nome principal na ficha.
--
-- `name_lookup_at`: carimbo da última TENTATIVA. Sem ele os mesmos primeiros N
-- voltariam em toda rodada e o fim da fila nunca seria perguntado. NULLABLE de
-- propósito: NULL = nunca perguntado; um default now() faria contato novo
-- nascer como "já tentado".
--
-- LGPD: anonimizar apaga o nome da agenda. O gatilho age em NEW (antes da
-- gravação), em qualquer caminho que deixe a linha anonimizada — inclusive uma
-- escrita futura num contato que já estava anonimizado.

alter table public.contacts
  add column if not exists address_book_name text;

comment on column public.contacts.address_book_name is
  'Nome salvo na agenda do celular (varredura contact-names; app WhatsApp Business). SÓ A EQUIPE vê: nunca entra em {{nome}} de automação nem de campanha. Pode ser apelido interno. NULL ao anonimizar.';

alter table public.contacts
  add column if not exists name_lookup_at timestamptz;

comment on column public.contacts.name_lookup_at is
  'Última vez que se PERGUNTOU ao canal o nome salvo na agenda do celular. NULL = nunca perguntado. Com valor e address_book_name ainda null = o canal não tinha o nome na ocasião.';

-- Índice PARCIAL: a varredura só olha quem não tem nome nenhum escolhido aqui
-- nem nome de agenda.
create index if not exists idx_contacts_name_lookup_pendente
  on public.contacts (organization_id, name_lookup_at nulls first)
  where name is null and address_book_name is null and is_anonymized = false and kind = 'person';

create or replace function public.fn_contato_anonimizado_esquece_a_agenda()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.address_book_name := null;
  return new;
end;
$$;

revoke execute on function public.fn_contato_anonimizado_esquece_a_agenda() from public, anon, authenticated;

drop trigger if exists trg_contato_anonimizado_esquece_a_agenda on public.contacts;
create trigger trg_contato_anonimizado_esquece_a_agenda
  before insert or update on public.contacts
  for each row
  when (new.is_anonymized is true and new.address_book_name is not null)
  execute function public.fn_contato_anonimizado_esquece_a_agenda();
