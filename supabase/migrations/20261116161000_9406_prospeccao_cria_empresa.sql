-- manifest: **A prospecção passa a criar a Empresa do módulo "Empresas e pessoas" — com o módulo LIGADO (issue #3198, fatia 2; desenho fechado por @paulolimajr77).** `contacts.company_id` opcional, chave estrangeira para `companies` com `on delete set null`, porque o telefone do Google é da RECEPÇÃO e não de uma pessoa — a ligação é referência à empresa, não pessoa sintética (decisão 1 do autor). `companies.website`, `companies.maps_url` e `companies.place_id`, só o que NÃO muda; nota, avaliações e categoria continuam em `prospecting_candidates.data`, porque mudam com o tempo e não são cadastro (decisão 2). Índice único parcial `(organization_id, place_id)` é a primeira chave de deduplicação de empresa por negócio do módulo, que hoje só compara CNPJ. Mesma organização garantida por GATILHO (`fn_contacts_company_same_org`), o mesmo padrão de `fn_contacts_person_same_org` da 0448 — a chave estrangeira sozinha não sabe de tenant. Com o módulo DESLIGADO nada disto é escrito pela prospecção: ela segue como hoje, contato, negócio e conversa, sem nenhuma linha em `companies` (decisão 3).
--
-- O que NÃO está aqui, de propósito: nenhuma coluna para nota, avaliações ou
-- categoria (decisão 2), nenhuma pessoa "Recepção" (decisão 1), nenhuma mudança
-- na cascata de LGPD (`companies` já não é alcançada pela 0449, e continua não
-- sendo) e nenhuma alteração nas telas da fatia 1.
--
-- Por que GATILHO e não checagem na escrita: `contacts` tem muitos escritores —
-- WAHA (`fn_upsert_wa_contact`), importação de planilha, REST, MCP e agora a
-- prospecção. Checagem no nosso caminho protegeria um deles; o gatilho protege
-- todos, e é exatamente o caminho que a 0448 abriu para `contacts.person_id`.

-- ---------------------------------------------------------------------------
-- 1. contacts.company_id — a referência do número à empresa (decisão 1)
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists company_id uuid references public.companies(id) on delete set null;

create index if not exists idx_contacts_org_company
  on public.contacts (organization_id, company_id)
  where company_id is not null;

create or replace function public.fn_contacts_company_same_org()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company_org uuid;
begin
  if new.company_id is null then
    return new;
  end if;
  select organization_id into v_company_org
    from public.companies where id = new.company_id;
  if v_company_org is null then
    raise exception 'contacts.company_id: empresa inexistente';
  end if;
  if new.organization_id is distinct from v_company_org then
    raise exception 'contacts.company_id: organization_id deve coincidir com a empresa';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_contacts_company_same_org() from public, anon;

drop trigger if exists trg_contacts_company_same_org on public.contacts;
create trigger trg_contacts_company_same_org
  before insert or update of company_id, organization_id on public.contacts
  for each row execute function public.fn_contacts_company_same_org();

-- ---------------------------------------------------------------------------
-- 2. companies: só o que NÃO muda (decisão 2)
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists website text,
  add column if not exists maps_url text,
  add column if not exists place_id text;

-- A primeira chave de deduplicação por NEGÓCIO do módulo. Não conflita com
-- `prospecting_candidates`: é outra tabela, e o candidato continua com o seu
-- `unique (organization_id, place_id)`. Parcial porque empresa cadastrada à mão
-- (planilha, CNPJ) não tem `place_id` e não pode colidir consigo mesma.
create unique index if not exists companies_org_place_id_uidx
  on public.companies (organization_id, place_id)
  where place_id is not null;

notify pgrst, 'reload schema';
