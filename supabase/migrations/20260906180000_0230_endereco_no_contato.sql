-- ============================================================================
-- 0230 — ENDEREÇO E FISCAL NO CONTATO (paridade com a ficha do Mercos/WP)
--
-- A ficha do cliente sem endereço é cadastro pela metade: entrega, cobrança
-- e visita precisam dele. Colunas próprias (não metadata) porque endereço é
-- filtrado e impresso — metadata é para rastro, não para dado operacional.
-- ============================================================================

alter table public.contacts
  add column if not exists tipo_pessoa text check (tipo_pessoa in ('F', 'J'));

alter table public.contacts
  add column if not exists fantasia text;

alter table public.contacts
  add column if not exists ie text;

alter table public.contacts
  add column if not exists regime text;

alter table public.contacts
  add column if not exists logradouro text;

alter table public.contacts
  add column if not exists numero_end text;

alter table public.contacts
  add column if not exists complemento text;

alter table public.contacts
  add column if not exists bairro text;

alter table public.contacts
  add column if not exists cidade text;

alter table public.contacts
  add column if not exists uf char(2);

alter table public.contacts
  add column if not exists cep text;

create index if not exists contacts_org_cidade_idx
  on public.contacts (organization_id, cidade);

comment on column public.contacts.tipo_pessoa is
  'F = pessoa física, J = jurídica. Define o card do cadastro (CPF x CNPJ+IE).';

comment on column public.contacts.fantasia is
  'Nome fantasia (PJ). Razão social vai em name/display_name.';
