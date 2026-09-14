-- Stable link between a CRM organization and its Advomax office.
alter table public.organizations
  add column if not exists advomax_empresa_codigo bigint;

create unique index if not exists organizations_advomax_empresa_codigo_key
  on public.organizations (advomax_empresa_codigo)
  where advomax_empresa_codigo is not null;
