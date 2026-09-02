-- Renomeia identificadores fiscais brasileiros (CPF, CNPJ) para NUIT (Número
-- Único de Identificação Tributária, Moçambique) — um único identificador que
-- serve tanto pessoas físicas quanto empresas, ao contrário do par CPF/CNPJ
-- brasileiro. Idempotente: guarda cada passo para poder rodar de novo em
-- `update.sh` sem duplicar efeito nem quebrar em cima do estado final.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contacts' and column_name = 'cpf_encrypted'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contacts' and column_name = 'nuit_encrypted'
  ) then
    alter table public.contacts rename column cpf_encrypted to nuit_encrypted;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contacts' and column_name = 'cpf_hash'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contacts' and column_name = 'nuit_hash'
  ) then
    alter table public.contacts rename column cpf_hash to nuit_hash;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'cnpj'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'nuit'
  ) then
    alter table public.organizations rename column cnpj to nuit;
  end if;
end $$;

-- Constraint e índice não seguem o rename de coluna pelo nome — só pelo
-- atributo interno. Sem isto, o objeto continua a funcionar mas com um nome
-- que mente sobre o que guarda.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'contacts_cpf_consistency' and conrelid = 'public.contacts'::regclass
  ) then
    alter table public.contacts rename constraint contacts_cpf_consistency to contacts_nuit_consistency;
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'organizations_cnpj_key' and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations rename constraint organizations_cnpj_key to organizations_nuit_key;
  end if;
end $$;

alter index if exists public.uniq_contacts_org_cpf rename to uniq_contacts_org_nuit;

comment on table public.contacts is 'Pessoa fisica no escopo de um tenant. NUIT criptografado at-rest. is_anonymized irreversivel (L-04).';

-- Pipelines existentes cujo identity_resolution ainda prioriza 'cpf' passam a
-- priorizar 'nuit' — dado, não só default de coluna nova.
update public.crm_pipelines
set settings = jsonb_set(
  settings,
  '{identity_resolution,fields_in_priority_order}',
  (
    select jsonb_agg(case when elem = '"cpf"'::jsonb then '"nuit"'::jsonb else elem end)
    from jsonb_array_elements(settings #> '{identity_resolution,fields_in_priority_order}') as elem
  )
)
where settings #> '{identity_resolution,fields_in_priority_order}' @> '["cpf"]'::jsonb;

alter table public.crm_pipelines
  alter column settings set default jsonb_build_object(
    'fields', '[]'::jsonb,
    'canonical_tags', '[]'::jsonb,
    'lost_reasons', '[]'::jsonb,
    'identity_resolution', jsonb_build_object(
      'fields_in_priority_order', jsonb_build_array('nuit', 'phone_e164', 'email')
    )
  );
