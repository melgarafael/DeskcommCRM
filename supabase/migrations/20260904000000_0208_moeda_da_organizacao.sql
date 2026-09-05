-- 0208 — A MOEDA DA ORGANIZAÇÃO DEIXA DE SER PRESUMIDA
--
-- ─── O que existia antes ───────────────────────────────────────────────────
--
-- Nada. O produto inteiro presume real, e a presunção não está escrita em
-- lugar nenhum onde alguém possa mudá-la. `catalog_products.moeda` (0204) já
-- nasce com `default 'BRL'`, e medido no fonte: NINGUÉM manda outra coisa.
-- O formulário de "Novo produto" (`app/app/products/_client.tsx`) não tem o
-- campo — o `Rascunho` não o declara e o `doRascunho()` não o envia —, e o
-- import por planilha (`lib/catalogo/planilha.ts`) não mapeia coluna de moeda.
-- Só a rota aceita `moeda` no corpo, o que é pior que não aceitar: nenhuma
-- tela oferece, então o único jeito de um produto não ser BRL é chamar a API
-- por fora do produto.
--
-- Uma loja no México cadastra o preço em pesos, o sistema guarda 'BRL', e o
-- agente de IA cota esse número ao cliente com o símbolo errado. O dado está
-- certo e o rótulo mente.
--
-- ─── Por que na organização, e por que coluna ──────────────────────────────
--
-- A moeda é fato do NEGÓCIO, não preferência de quem lê: todo mundo que abre
-- aquele catálogo vê a mesma. É a mesma classe de `organizations.locale` e
-- `organizations.timezone`, que já são colunas de primeira classe nesta tabela
-- — e não `settings` jsonb, que seria o anti-pattern 6 (a tela lendo path
-- direto sem schema central).
--
-- DIRC antes de acrescentar o campo:
--   D — não é duplicação sem dono: a organização é a fonte NA ESCRITA, e a
--       linha guarda a moeda com que nasceu. É o certo para `orders`, que são
--       fatos históricos: um pedido pago em BRL não vira MXN depois.
--   I/R — nenhuma FK a traz de outro lugar.
--   C — não é calculável. É uma declaração de quem opera.
--
-- ─── Por que `currency` e não `moeda` ──────────────────────────────────────
--
-- A doutrina (CLAUDE.md, API REST) diz "Dinheiro em `_cents` + `currency`
-- ISO-4217", e duas das três tabelas com dinheiro já obedecem:
-- `crm_leads.currency` e `orders.currency`. `catalog_products.moeda` é o
-- desvio, não o padrão. Renomear coluna já distribuída quebraria o `update.sh`
-- de quem instalou — a doutrina só admite forward-fix —, então ela fica onde
-- está e a coluna nova não propaga o desvio.
--
-- ─── O CHECK é de FORMA, não de vocabulário ────────────────────────────────
--
-- `^[A-Z]{3}$` valida o formato ISO-4217; não fecha um conjunto de valores.
-- Por isso NÃO entra em `tests/invariants/vocabulario-banco-x-typescript`, que
-- cobre pares coluna↔union do TypeScript. Precedente idêntico e deliberado:
-- `catalog_products_moeda_iso`, que também não está lá.
--
-- Aditiva: coluna nova com default que satisfaz a constraint em toda linha
-- existente. Não há dado a curar num banco saudável — o `update` abaixo existe
-- para o clone onde a coluna tenha sido criada à mão, antes desta migration.

alter table public.organizations
  add column if not exists currency text not null default 'BRL';

-- Auto-curativo, e ANTES da constraint (doutrina de migrations §8): num clone
-- onde a coluna já exista nula ou com lixo, criar o CHECK primeiro quebraria o
-- `update.sh` no meio.
update public.organizations
   set currency = 'BRL'
 where currency is null
    or currency !~ '^[A-Z]{3}$';

alter table public.organizations
  alter column currency set default 'BRL';

alter table public.organizations
  alter column currency set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'organizations_currency_iso'
       and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_currency_iso check (currency ~ '^[A-Z]{3}$');
  end if;
end $$;

comment on column public.organizations.currency is
  'Moeda do negócio desta organização, ISO-4217. CONTRATO: é a fonte na ESCRITA — o produto herda esta moeda no cadastro, e a moeda que venha no corpo da requisição não decide (corpo não decide unidade, como não decide escopo). A linha do produto guarda a moeda com que nasceu: pedido pago em BRL não vira MXN depois.';
