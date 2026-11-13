-- manifest: **A revenda publica o estoque num FEED e o CRM se sincroniza sozinho (#3587, fatia 2):** cria `catalog_feed_sources` (UMA fonte por organização — URL, formato `json`/`csv`, mapeamento de campos e último resumo) e a coluna `catalog_products.id_externo`, com índice único parcial em `(organization_id, id_externo)`. O id externo é a CHAVE do casamento entre feed e catálogo: sem ele a rodada duplicaria produto, e produto duplicado é dois preços para o mesmo item na conversa com o cliente. Nada é apagado — o item que sai do feed vira `ativo = false`, porque histórico de conversa e proposta apontam para a linha. Idempotente; espelho no fim do apêndice do `supabase/baseline.sql`.
-- ============================================================================
-- 9222 — A FONTE DE CATÁLOGO SINCRONIZADA (issue #3587, fatia 2).
--
-- ─── Por que uma tabela NOVA, e não `webhook_sources` ───────────────────────
--
-- A `webhook_sources` da 0038 é captação de LEAD de ENTRADA: `path_token`
-- único, `secret` de assinatura, `kind` travado em `'lead_capture'` por CHECK e
-- `field_map` que aponta para funil e etapa (`default_pipeline_id`,
-- `default_stage_id` NOT NULL). O feed de catálogo é o contrário: nós SAÍMOS
-- para buscar uma URL da revenda, não há segredo de assinatura, e o mapeamento
-- é de campos de produto, não de lead. Reusar a tabela exigiria afrouxar o
-- CHECK, tornar NOT NULL em colunas de funil e dar outro significado a
-- `path_token` — três mudanças destrutivas num caminho que está em produção
-- para todo mundo. `external_db_connections` é conexão de banco (host, porta,
-- usuário, senha): também não é isto.
--
-- ─── Por que UMA linha por organização ──────────────────────────────────────
--
-- A revenda publica UM estoque — o do ERP dela. Duas fontes na mesma
-- organização disputariam o mesmo produto com dois preços, e a regra de "quem
-- manda" não existe no feed. O índice único fecha isso no banco, e não só na
-- rota: quem inserir por PostgREST recebe 23505 em vez de um catálogo dividido.
-- ============================================================================

create table if not exists public.catalog_feed_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- A URL do feed da revenda (http/https). A guarda de SSRF é do código
  -- (`assertUrlDeMidiaSegura`, a mesma da foto por URL), não do CHECK: o CHECK
  -- recusaria `file:`/`data:`, mas não um hostname público que resolve para
  -- 169.254.169.254 — e é esse o ataque que importa.
  url text not null,
  -- 'json' | 'csv'. Vocabulário aberto (sem CHECK de propósito, doutrina de
  -- migrations): um clone com feed legado não pode quebrar o `update.sh`.
  formato text not null default 'json',
  -- { id_externo?: "sku", nome?: "title", preco?: "price", … } — campo do
  -- produto → chave do item no feed. `{}` = os apelidos padrão de
  -- `lib/catalogo/feed.ts`.
  mapeamento jsonb not null default '{}'::jsonb,

  -- Desligar a fonte PARA a sincronização sem perder a configuração: o cron só
  -- lê `ativo = true` (mesma semântica de `webhook_sources.is_active` e da
  -- `is_active` das automações).
  ativo boolean not null default true,

  -- O que a última rodada fez — é o que a rota devolve e o que o operador olha
  -- quando o catálogo parece parado.
  ultima_leitura_em timestamptz,
  ultimo_resumo jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_feed_sources_url_http check (url ~* '^https?://')
);

create unique index if not exists catalog_feed_sources_org_key
  on public.catalog_feed_sources (organization_id);

-- ─── A coluna que faz o casamento ────────────────────────────────────────────
--
-- `codigo` já é identidade dentro da organização, mas é do DONO da loja (SKU
-- digitado, nome da planilha). O id do feed é do SISTEMA da revenda, e os dois
-- podem divergir — inclusive com o mesmo produto tendo SKU "FONE-1" na tela e
-- "8842" no feed. Guardar o id externo em coluna própria mantém as duas
-- identidades verdadeiras e deixa a rodada casar pela que o feed conhece.
--
-- NULO = produto que não veio de feed (manual, planilha, Nuvemshop). NULL não
-- colide em índice único, e o índice é PARCIAL para não pagar por eles.
alter table public.catalog_products
  add column if not exists id_externo text;

create unique index if not exists catalog_products_org_id_externo_key
  on public.catalog_products (organization_id, id_externo)
  where id_externo is not null;

comment on column public.catalog_products.id_externo is
  'Identidade do produto no FEED da revenda (issue #3587). É a chave do casamento da sincronização: id externo igual = mesmo produto, atualiza em vez de criar. Nulo = produto que não veio de feed.';

-- ─── RLS: leitura da organização, escrita `manager`+ ─────────────────────────
-- O molde é o do próprio `catalog_products` (0214/0553): ESCRITA separada em
-- insert/update/delete, nunca `for all` — `for all` vale também para SELECT e
-- fazia toda leitura avaliar `fn_role_at_least` linha a linha.
--
-- A fonte guarda uma URL que o SERVIDOR vai buscar: quem pode escrever nela
-- decide para onde a instalação faz requisição. Papel de leitura não escreve.
alter table public.catalog_feed_sources enable row level security;

drop policy if exists catalog_feed_sources_select on public.catalog_feed_sources;
create policy catalog_feed_sources_select on public.catalog_feed_sources
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or (select public.fn_is_platform_admin())
  );

drop policy if exists catalog_feed_sources_insert on public.catalog_feed_sources;
create policy catalog_feed_sources_insert on public.catalog_feed_sources
  for insert with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists catalog_feed_sources_write on public.catalog_feed_sources;
create policy catalog_feed_sources_write on public.catalog_feed_sources
  for update using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists catalog_feed_sources_delete on public.catalog_feed_sources;
create policy catalog_feed_sources_delete on public.catalog_feed_sources
  for delete using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- O `ALTER DEFAULT PRIVILEGES ... TO anon` do baseline alcança toda tabela nova:
-- sem o revoke, a URL do feed (e o mapeamento) ficariam legíveis pela anon key.
revoke all on public.catalog_feed_sources from anon;
grant select, insert, update, delete on public.catalog_feed_sources to authenticated;
grant all on public.catalog_feed_sources to service_role;

drop trigger if exists trg_catalog_feed_sources_updated_at on public.catalog_feed_sources;
create trigger trg_catalog_feed_sources_updated_at
  before update on public.catalog_feed_sources
  for each row execute function public.fn_set_updated_at();

comment on table public.catalog_feed_sources is
  'A fonte do catálogo sincronizado (issue #3587): a URL do feed que a revenda publica, o formato e o mapeamento de campos. UMA por organização — duas fontes disputariam o mesmo produto com dois preços. O cron `catalog-feed-sync` lê as ativas; nada é apagado do catálogo, item que sai do feed vira `ativo = false`.';

-- Sem isto, o PostgREST segue servindo o schema velho e a tabela nova (e a
-- coluna `id_externo`) respondem 400 até alguém reiniciar o serviço à mão.
notify pgrst, 'reload schema';
