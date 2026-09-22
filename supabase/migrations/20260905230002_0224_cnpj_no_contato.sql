-- ============================================================================
-- 0224 — CNPJ NO CONTATO (autocompletar empresa pela Receita/BrasilAPI)
--
-- `cnpj` em DÍGITOS, texto puro: CNPJ é dado público (não é segredo como o
-- CPF, que vai cifrado + hash). Unique parcial por org — o mesmo CNPJ não
-- vira dois clientes, e é por ele que a importação de prospects acha quem já
-- existe. Endereço da empresa vai em `source_metadata` (sem coluna nova:
-- endereço de ENTREGA mora no pedido, e endereço fiscal não tem ciclo
-- próprio que justifique entidade).
-- ============================================================================

alter table public.contacts
  add column if not exists cnpj text;

alter table public.contacts
  drop constraint if exists contacts_cnpj_formato;

alter table public.contacts
  add constraint contacts_cnpj_formato
  check (cnpj is null or cnpj ~ '^\d{14}$');

create unique index if not exists contacts_org_cnpj_key
  on public.contacts (organization_id, cnpj)
  where cnpj is not null;

comment on column public.contacts.cnpj is
  'CNPJ com 14 dígitos, dado público. Unique por org: mesma empresa, um contato. Preenchido via BrasilAPI no cadastro.';
