-- manifest: Pessoa física: endereço no contato (CEP, logradouro, número, complemento, bairro, cidade, UF) para entrega e cobrança — colunas em `contacts`, espelhando `companies`, e o gatilho `trg_contato_anonimizado_esquece_o_endereco`, que as apaga quando o contato é anonimizado (LGPD). Issue #3494.

-- 9041 — endereço da pessoa física no contato (issue #3494).
--
-- `contacts` só tinha `address_book_name` (rótulo da agenda do celular, nunca
-- endereço). Entrega e cobrança precisam do endereço do titular, e hoje ele
-- morava só em `companies` (pessoa jurídica). As colunas abaixo espelham as de
-- `companies` (migration 0368/0448) para a pessoa física, com os mesmos nomes e
-- tipos, para que um mesmo código de formatação/validação sirva aos dois.
--
-- Aditiva e idempotente: `add column if not exists`. Sem backfill — quem não
-- tinha endereço segue sem. Sem CHECK de formato: CEP/UF variam por país e a
-- validação fica na borda (Zod), como em `companies`.

alter table public.contacts
  add column if not exists zip_code text,
  add column if not exists street text,
  add column if not exists number text,
  add column if not exists complement text,
  add column if not exists district text,
  add column if not exists city text,
  add column if not exists state text;

comment on column public.contacts.zip_code is
  'CEP do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.street is
  'Logradouro do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.number is
  'Número do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.complement is
  'Complemento do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.district is
  'Bairro do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.city is
  'Cidade do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.state is
  'UF do endereço da pessoa física (issue #3494). NULL quando não informado.';

-- Anonimizar apaga o endereço. As duas RPCs de LGPD (`fn_lgpd_cascade_redact_contact`
-- e `fn_lgpd_anonymize_contact`, que chama a primeira) zeram nome, e-mail,
-- telefone, CPF e nascimento, mas não sabem destas colunas: sem isto, o
-- "Cliente Anonimizado #N" ficaria com rua, número e CEP — o bastante para
-- reidentificar o titular. Gatilho em NEW, no molde de
-- `trg_contato_anonimizado_esquece_a_agenda` (0593): vale para as duas RPCs e
-- para qualquer caminho futuro que deixe a linha anonimizada, sem redefinir a
-- função de cascata. Também impede que uma escrita posterior grave o endereço
-- de volta num contato já anonimizado.
create or replace function public.fn_contato_anonimizado_esquece_o_endereco()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.zip_code := null;
  new.street := null;
  new.number := null;
  new.complement := null;
  new.district := null;
  new.city := null;
  new.state := null;
  return new;
end;
$$;

revoke execute on function public.fn_contato_anonimizado_esquece_o_endereco() from public, anon, authenticated;

drop trigger if exists trg_contato_anonimizado_esquece_o_endereco on public.contacts;
create trigger trg_contato_anonimizado_esquece_o_endereco
  before insert or update on public.contacts
  for each row
  when (new.is_anonymized is true and (
    new.zip_code is not null or new.street is not null or new.number is not null
    or new.complement is not null or new.district is not null
    or new.city is not null or new.state is not null))
  execute function public.fn_contato_anonimizado_esquece_o_endereco();

notify pgrst, 'reload schema';