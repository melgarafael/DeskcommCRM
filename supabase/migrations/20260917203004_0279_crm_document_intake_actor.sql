-- 0243 — preserva a identidade Advomax que iniciou a atribuição.
-- Retries não podem usar um usuário técnico global, pois uma instalação CRM
-- atende vários escritórios e o backend valida o usuário dentro da empresa.
alter table public.crm_document_intake
  add column if not exists requested_by_email text;
