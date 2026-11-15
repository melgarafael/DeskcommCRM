-- manifest: Tabela de valores de negociação — por organização, procedimento com código e descrição, valor em US e em reais com valor de PARTIDA e valor LIMITE (a faixa é conferida pelo próprio banco), mais o registro de cada importação por chave do arquivo, para a mesma planilha não gravar duas vezes.
--
-- Fatia 1 (issue #4612): IMPORTAR e MODELAR. A conversa de negociação do
-- agente, o histórico de contrapropostas e a aprovação acima do limite ficam
-- para as fatias seguintes; nada aqui fala com o agente.
--
-- ─── Por que uma tabela, e não o prompt ──────────────────────────────────
-- Uma tabela de credenciamento tem centenas ou milhares de linhas. No prompt
-- não cabe (estoura contexto, custa a cada turno) e o modelo erra ao procurar
-- valor em texto longo. Aqui cada procedimento é uma linha com duas pontas de
-- preço, e a leitura é por código.
--
-- ─── Por que o LIMITE mora no banco e não na tela ────────────────────────
-- O limite é a informação que não pode vazar para o cliente e que não pode ser
-- furada por um import errado. Por isso as duas cercas estão no Postgres, e não
-- só no TypeScript: `faixa_*` recusa limite menor que a partida, `par_*` recusa
-- uma ponta sem a outra (moeda pela metade), e `algum_valor` recusa a linha que
-- não tem preço nenhum.
--
-- ─── Por que centavos inteiros ───────────────────────────────────────────
-- O repo guarda dinheiro em centavos (`value_cents`, `teto_ia_usd_cents`), e
-- comparar `numeric` em ponto flutuante é a classe de defeito que faz
-- "10,10 + 20,20 != 30,30". US também entra em centésimos: a unidade de
-- serviço é cotada com duas casas, igual ao real.

create table if not exists public.tabelas_de_valores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  descricao text,
  ativa boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tabelas_de_valores_nome_check check (btrim(nome) <> ''),
  -- Alvo da FK composta das filhas: a linha de uma tabela não pode nascer com
  -- organização diferente da organização da tabela.
  constraint tabelas_de_valores_id_org_unico unique (id, organization_id)
);

create index if not exists idx_tabelas_de_valores_org
  on public.tabelas_de_valores (organization_id, ativa, updated_at desc);

comment on table public.tabelas_de_valores is
  'Tabela de valores de negociação de uma organização (credenciamento, fornecedores, serviços com tabela). Cada procedimento vive em tabela_de_valores_itens, com valor de partida e valor limite.';

create table if not exists public.tabela_de_valores_itens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tabela_id uuid not null,
  codigo text not null,
  descricao text not null,
  -- US (unidade de serviço) e R$ lado a lado: a mesma linha pode ter as duas
  -- moedas, só uma, ou nenhuma das duas — desde que exista ao menos uma.
  valor_us_partida_cents bigint,
  valor_us_limite_cents bigint,
  valor_brl_partida_cents bigint,
  valor_brl_limite_cents bigint,
  unidade text,
  observacao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tabela_de_valores_itens_tabela_fk
    foreign key (tabela_id, organization_id)
    references public.tabelas_de_valores (id, organization_id) on delete cascade,
  constraint tabela_de_valores_itens_codigo_check check (btrim(codigo) <> ''),
  constraint tabela_de_valores_itens_descricao_check check (btrim(descricao) <> ''),
  -- FAIXA, moeda por moeda. A partida é o que a empresa oferece; o limite é até
  -- onde ela aceita ir. Limite abaixo da partida não é desconto, é erro de
  -- digitação: o import recusa a linha e o banco recusa o INSERT.
  constraint tabela_de_valores_itens_faixa_us
    check (valor_us_limite_cents >= valor_us_partida_cents),
  constraint tabela_de_valores_itens_faixa_brl
    check (valor_brl_limite_cents >= valor_brl_partida_cents),
  -- As duas pontas da moeda existem juntas: meia faixa (partida sem limite, ou
  -- limite sem partida) não se sabe negociar.
  constraint tabela_de_valores_itens_par_us
    check ((valor_us_partida_cents is null) = (valor_us_limite_cents is null)),
  constraint tabela_de_valores_itens_par_brl
    check ((valor_brl_partida_cents is null) = (valor_brl_limite_cents is null)),
  constraint tabela_de_valores_itens_algum_valor
    check (valor_us_partida_cents is not null or valor_brl_partida_cents is not null),
  constraint tabela_de_valores_itens_nao_negativo
    check (
      coalesce(valor_us_partida_cents, 0) >= 0
      and coalesce(valor_us_limite_cents, 0) >= 0
      and coalesce(valor_brl_partida_cents, 0) >= 0
      and coalesce(valor_brl_limite_cents, 0) >= 0
    ),
  -- UM procedimento por tabela. É o que faz a mesma planilha importada duas
  -- vezes não duplicar procedimento, mesmo quando a chave do arquivo não bate
  -- (arquivo salvo de novo, outra exportação do Excel).
  constraint tabela_de_valores_itens_codigo_unico unique (tabela_id, codigo)
);

create index if not exists idx_tabela_de_valores_itens_tabela
  on public.tabela_de_valores_itens (tabela_id, codigo);
create index if not exists idx_tabela_de_valores_itens_org
  on public.tabela_de_valores_itens (organization_id, updated_at desc);

comment on table public.tabela_de_valores_itens is
  'Procedimento de uma tabela de valores: código, descrição, valor de partida e valor limite em US e em R$. A faixa e a paridade das pontas são constraints; o limite nunca é menor que a partida.';

-- O REGISTRO DE CADA IMPORTAÇÃO, pela chave do arquivo.
--
-- Importar a mesma planilha duas vezes é quase sempre o mesmo clique dado duas
-- vezes (duplo envio, aba recarregada), não duas intenções. A chave é o SHA-256
-- do arquivo, e o `unique` abaixo é a cerca: o segundo pedido não grava, e a
-- rota responde "esta planilha já entrou" com as contagens da primeira.
create table if not exists public.tabela_de_valores_importacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tabela_id uuid not null,
  chave_do_arquivo text not null,
  nome_do_arquivo text,
  linhas_lidas integer not null default 0,
  linhas_aceitas integer not null default 0,
  linhas_recusadas integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tabela_de_valores_importacoes_tabela_fk
    foreign key (tabela_id, organization_id)
    references public.tabelas_de_valores (id, organization_id) on delete cascade,
  constraint tabela_de_valores_importacoes_chave_check check (btrim(chave_do_arquivo) <> ''),
  constraint tabela_de_valores_importacoes_mesmo_arquivo
    unique (tabela_id, chave_do_arquivo)
);

create index if not exists idx_tabela_de_valores_importacoes_org
  on public.tabela_de_valores_importacoes (organization_id, created_at desc);

comment on table public.tabela_de_valores_importacoes is
  'Uma linha por importação confirmada de planilha: chave SHA-256 do arquivo, nome e as contagens. O unique (tabela_id, chave_do_arquivo) impede a mesma planilha de entrar duas vezes.';

-- ═══ RLS ═══
-- Leitura da tabela e dos itens pela equipe da própria organização (ou admin de
-- plataforma). ESCRITA SÓ PELO SERVIDOR (service_role): quem confirma a
-- importação é a rota, que filtra `organization_id` a partir da autenticação.
-- O registro de importações nem leitura tem policy — é livro do servidor.
alter table public.tabelas_de_valores enable row level security;
alter table public.tabela_de_valores_itens enable row level security;
alter table public.tabela_de_valores_importacoes enable row level security;

drop policy if exists tenant_isolation_tabelas_de_valores_select on public.tabelas_de_valores;
create policy tenant_isolation_tabelas_de_valores_select
  on public.tabelas_de_valores
  for select to authenticated using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_tabela_de_valores_itens_select on public.tabela_de_valores_itens;
create policy tenant_isolation_tabela_de_valores_itens_select
  on public.tabela_de_valores_itens
  for select to authenticated using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

revoke all on public.tabelas_de_valores from anon, authenticated;
revoke all on public.tabela_de_valores_itens from anon, authenticated;
revoke all on public.tabela_de_valores_importacoes from public, anon, authenticated;
grant select on public.tabelas_de_valores to authenticated;
grant select on public.tabela_de_valores_itens to authenticated;
grant all on public.tabelas_de_valores to service_role;
grant all on public.tabela_de_valores_itens to service_role;
grant all on public.tabela_de_valores_importacoes to service_role;

notify pgrst, 'reload schema';
