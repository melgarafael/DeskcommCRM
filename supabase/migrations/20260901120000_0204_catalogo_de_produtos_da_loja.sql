-- ============================================================================
-- 0204 — O CATÁLOGO DE PRODUTOS DA LOJA
--
-- ─── Por que uma tabela NOVA, e não `nuvemshop_products` + uma coluna `origem`
--
-- Quatro razões, em ordem de força. A primeira sozinha decide:
--
-- 1. A POLICY. `nuvemshop_products_tenant` é `for all` org-flat, SEM
--    `fn_role_at_least`. Pôr o preço de venda ali significa que qualquer
--    `viewer` da organização reescreve preço pelo PostgREST com o JWT dele. E a
--    tabela está congelada na allowlist de dívida de RBAC — uma tabela NOVA é
--    proibida de nascer assim, e reusar aquela não ganharia o conserto de graça.
--
-- 2. TRÊS `not null` DE ESPELHO. `external_id`, `last_updated_at` e `payload`
--    significam "o que o sistema remoto disse, e quando". Produto digitado à mão
--    teria de inventar os três, e `unique (organization_id, external_id)`
--    passaria a impor uma chave falsa (`manual:<uuid>`) — identidade virando
--    inferência por string, o anti-pattern nº 4 do CLAUDE.md.
--
-- 3. DOIS DONOS DE ESCRITA NUMA TABELA SÓ. No dia em que o sync da Nuvemshop
--    ganhar o escritor que hoje lhe falta, ele será um espelho: upsert por
--    `external_id` e, cedo ou tarde, delete do que sumiu lá em cima. Um
--    `where origem = 'nuvemshop'` esquecido em UMA query apaga o catálogo que a
--    dona da loja digitou à mão.
--
-- 4. O nome mente em toda instalação que nunca conectou Nuvemshop — e este
--    produto é multi-nicho por posicionamento.
--
-- Migrar dado não custa nada: medido, `nuvemshop_products` não tem UM escritor
-- em todo o repositório, e o indexador do RAG nem a lê (vai à API da Nuvemshop
-- direto). Ela fica onde está, como a forma certa de um ESPELHO. O que faltava
-- era a tabela do catálogo que a loja POSSUI.
--
-- ─── Por que UMA linha por item vendável, e não pai + variações
--
-- Porque o que tem preço é o SKU. "iPhone 15 Pro" não custa nada — quem custa é
-- "iPhone 15 Pro 256GB Titânio". Um pai sem preço não responde à pergunta que o
-- cliente faz no WhatsApp, e criar a segunda tabela para guardá-lo seria
-- entidade especulativa (DIRC, letra C: o "modelo" é derivável de marca +
-- categoria + nome, que já estão aqui).
--
-- Consequência aceita e escrita: 4 capacidades × 3 cores são 12 linhas. Para
-- uma loja de rua isso é o formato da planilha que ela já tem.
-- ============================================================================

create table if not exists public.catalog_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- O código do dono da loja (SKU, código interno). É por ele que a importação
  -- de planilha reconhece "isto é o mesmo produto, atualize" em vez de duplicar.
  codigo text not null,
  nome text not null,
  descricao text,

  marca text,
  categoria text,

  -- `_cents` + `moeda`, a regra do CLAUDE.md. `nuvemshop_products` não tem
  -- moeda e é a exceção errada, não o padrão: `orders` e `crm_leads` têm.
  preco_cents bigint not null,
  moeda text not null default 'BRL',
  -- O que a loja pagou. Existe para a regra de desconto do agente ter piso: sem
  -- custo, "pode dar 10%" é um número que ninguém sabe se cabe. Opcional porque
  -- muita loja não quer essa informação no sistema.
  custo_cents bigint,

  -- ⚠️ `controla_estoque` NÃO é firula, é o conserto de uma armadilha medida na
  -- tool antiga: ela filtra `available_qty > 0` por default, então uma loja que
  -- não conta estoque (decant de perfume, item sob encomenda) teria o catálogo
  -- INTEIRO invisível para o agente. Com este campo, quem não controla estoque
  -- continua aparecendo.
  controla_estoque boolean not null default true,
  quantidade integer not null default 0,

  ativo boolean not null default true,
  -- 'manual' | 'planilha' | 'nuvemshop'. Vocabulário ABERTO de propósito (sem
  -- CHECK): um clone com origem legada quebraria o `update.sh`, e a doutrina de
  -- migrations proíbe. Quem escreve usa a constante de `lib/catalogo/tipos.ts`.
  origem text not null default 'manual',

  imagem_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_products_preco_nao_negativo check (preco_cents >= 0),
  constraint catalog_products_custo_nao_negativo check (custo_cents is null or custo_cents >= 0),
  constraint catalog_products_quantidade_nao_negativa check (quantidade >= 0),
  constraint catalog_products_moeda_iso check (moeda ~ '^[A-Z]{3}$')
);

-- O código é a identidade dentro da organização: é ele que a planilha reusa.
create unique index if not exists catalog_products_org_codigo_key
  on public.catalog_products (organization_id, codigo);

-- A lista da tela: ativos primeiro, depois por nome.
create index if not exists catalog_products_org_ativos_idx
  on public.catalog_products (organization_id, ativo, nome);

-- ⚠️ O ÍNDICE QUE FAZ A BUSCA DO AGENTE FUNCIONAR.
--
-- O cliente escreve "ifone 15 pro 256", e o catálogo diz "iPhone 15 Pro 256GB".
-- Medido em 20 mil títulos: `ilike '%ifone 15%'` devolve ZERO linhas, e a
-- similaridade da frase inteira não separa 128GB de 256GB — que é exatamente
-- onde o preço erra. A busca é por TOKEN (ver `lib/catalogo/busca.ts`), e o
-- trigrama serve a parte difusa dela.
create index if not exists catalog_products_nome_trgm
  on public.catalog_products using gin (nome public.gin_trgm_ops);

alter table public.catalog_products enable row level security;

-- Leitura para a organização; ESCRITA só de `manager` para cima. É o molde da
-- 0177 (`calendar_event_types`), e é o que a tabela da Nuvemshop não tem: preço
-- de venda não se altera com papel de leitura.
drop policy if exists catalog_products_select on public.catalog_products;
create policy catalog_products_select on public.catalog_products
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists catalog_products_write on public.catalog_products;
create policy catalog_products_write on public.catalog_products
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline alcança
-- TODA tabela criada depois dele — inclusive esta. Sem o revoke, o catálogo
-- inteiro fica legível pela anon key, que vai para o browser.
revoke all on public.catalog_products from anon;
grant select, insert, update, delete on public.catalog_products to authenticated;
grant all on public.catalog_products to service_role;

drop trigger if exists trg_catalog_products_updated_at on public.catalog_products;
create trigger trg_catalog_products_updated_at
  before update on public.catalog_products
  for each row execute function public.fn_set_updated_at();

comment on table public.catalog_products is
  'O catálogo que a LOJA possui — uma linha por item vendável, com o preço que o agente de IA responde. Distinto de nuvemshop_products, que é ESPELHO de uma loja remota: aqui a loja é a fonte da verdade.';
comment on column public.catalog_products.codigo is
  'Código interno do dono (SKU). É a identidade que a importação de planilha reusa para atualizar em vez de duplicar.';
comment on column public.catalog_products.custo_cents is
  'O que a loja pagou. Existe para a regra de desconto do agente ter piso — sem custo, um teto de desconto é um número que ninguém sabe se cabe.';
comment on column public.catalog_products.controla_estoque is
  'false = item que não se conta (decant, sob encomenda). A busca do agente não o esconde por quantidade zero.';
