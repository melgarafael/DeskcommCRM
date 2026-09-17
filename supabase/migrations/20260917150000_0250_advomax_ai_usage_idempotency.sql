alter table public.llm_calls add column if not exists external_request_id text;
create unique index if not exists uq_llm_calls_org_external_request
  on public.llm_calls(organization_id, external_request_id) where external_request_id is not null;
comment on column public.llm_calls.external_request_id is
  'Identificador idempotente de chamada feita por sistema integrado, sem credencial ou conteúdo do prompt.';
