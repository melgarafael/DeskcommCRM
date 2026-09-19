-- 0244 · O catálogo do agente estava cravado no código (`motos`, `imagem_url`).
--
-- ─── O atrito que isto resolve ──────────────────────────────────────────────
-- O agente monta a apresentação de motos (foto + legenda + texto) a partir de um
-- banco externo. Até aqui, a TABELA (`motos`) e as COLUNAS (`nome`, `ano`, `cor`,
-- `quilometragem`, `preco`, `imagem_url`) viviam cravadas em
-- `lib/agent-engine/agent/fotos-do-catalogo.ts` e na skill. Isso só funciona para
-- UM cliente: outra loja com outro schema (ou o mesmo cliente mudando o schema)
-- teria de esperar deploy. O dono pediu explicitamente que isso seja dinâmico e
-- editável pela tela de Integração de dados.
--
-- ─── Por que uma TABELA, e não uma chave em `organizations.settings` ─────────
-- Mapeamento de catálogo é estrutura com validação (quais colunas, qual
-- operador) e precisa de FK para a conexão; um JSON solto em `settings` não
-- teria FK, nem CHECK, nem RLS própria. A tabela também deixa o caminho aberto
-- para VÁRIOS catálogos por organização no futuro.
--
-- ─── Por que 1 por organização, AGORA ────────────────────────────────────────
-- Um `unique (organization_id)` mantém a primeira entrega simples e o motor sem
-- ambiguidade ("qual catálogo?"). Quando houver dois catálogos (motos + produtos),
-- troca-se por `unique (organization_id, table_name)` numa migration nova — não
-- há dado a migrar.
--
-- ─── RBAC e LGPD ────────────────────────────────────────────────────────────
-- Leitura para qualquer membro (saber que existe um catálogo não é segredo);
-- escrita só `admin` (mexe na fonte de dados). Nenhuma função NOVA em `public`
-- ⇒ o item 9 da doutrina de migrations não é acionado (usamos `fn_set_updated_at`,
-- `fn_audit_log_row`, `fn_user_org_ids` e `fn_role_at_least`, todas existentes).

create table if not exists public.catalog_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- A fonte externa de onde o catálogo é lido. Apagar a conexão apaga o mapeamento.
  connection_id uuid not null references public.external_db_connections(id) on delete cascade,
  schema_name text not null default 'public',
  table_name text not null,
  -- Colunas REAIS do banco externo. `col_nome` é obrigatória (é o que o cliente
  -- busca e o que casa com o texto do agente); as demais são opcionais.
  col_nome text not null,
  col_ano text,
  col_cor text,
  col_km text,
  col_preco text,
  col_imagem text,
  col_estoque text,
  -- Cilindrada/tipo: se nulos, o motor extrai a cilindrada do NOME (ex.: "CB 250").
  col_cilindrada text,
  col_tipo text,
  -- Como o motor busca pelo termo do cliente. `contem` casa "cb300f" com
  -- "CB 300 F Twister" (mesmo critério do C-008 do banco externo).
  busca_operador text not null default 'contem',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_mappings_org_uk unique (organization_id),
  constraint catalog_mappings_busca_operador_conhecido
    check (busca_operador in ('contem', 'eq', 'comeca_com'))
);

comment on table public.catalog_mappings is
  'Mapeamento do catálogo do agente: qual tabela do banco externo e quais colunas são nome/ano/cor/km/preço/imagem/estoque. Uma por organização nesta fase. O runtime lê isto para montar a apresentação e o bloco de catálogo injetado no turno (nunca no prompt fixo da persona).';
comment on column public.catalog_mappings.col_nome is
  'Coluna do banco externo que guarda o nome/modelo (obrigatória): é o que casa com o termo do cliente.';
comment on column public.catalog_mappings.col_cilindrada is
  'Coluna de cilindrada, se existir. Nula = o motor extrai a cilindrada do nome (ex.: "CB 250" -> 250).';
comment on column public.catalog_mappings.busca_operador is
  'Operador da busca por nome: contem | eq | comeca_com. Default contem (tolerante a espaços/caixa).';

create index if not exists catalog_mappings_connection_idx
  on public.catalog_mappings (connection_id);

alter table public.catalog_mappings enable row level security;

drop policy if exists tenant_isolation_catalog_mappings_select on public.catalog_mappings;
create policy tenant_isolation_catalog_mappings_select on public.catalog_mappings
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_catalog_mappings_write on public.catalog_mappings;
create policy tenant_isolation_catalog_mappings_write on public.catalog_mappings
  for all
  using (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

revoke all on public.catalog_mappings from anon;

drop trigger if exists trg_catalog_mappings_updated_at on public.catalog_mappings;
create trigger trg_catalog_mappings_updated_at
  before update on public.catalog_mappings
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_catalog_mappings_audit on public.catalog_mappings;
create trigger trg_catalog_mappings_audit
  after insert or update or delete on public.catalog_mappings
  for each row execute function public.fn_audit_log_row();
