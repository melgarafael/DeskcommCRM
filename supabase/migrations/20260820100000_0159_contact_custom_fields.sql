-- EPIC-05 / S-05.06 — campos personalizados em contacts
-- JSONB mantém compatibilidade com schemas declarativos por pipeline.

alter table public.contacts
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

comment on column public.contacts.custom_fields is
  'Valores de campos personalizados do contato. As definições são declaradas no settings.fields do pipeline e valores legados são preservados.';

alter table public.contacts
  drop constraint if exists contacts_custom_fields_object;

alter table public.contacts
  add constraint contacts_custom_fields_object
  check (jsonb_typeof(custom_fields) = 'object');
