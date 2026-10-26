-- manifest: catálogo de serviços — `catalog_products` passa a carregar o que a #2497 não respondia para quem vende projeto e plano recorrente: `tipo_servico` (hora marcada, projeto, recorrente), `unidade_cobranca` (sessão, hora, valor fechado, mês, trimestre, ano), `prazo_dias_uteis` (só projeto), sinal (`sinal_percentual` 1..100 ou `sinal_cents`), `instrucoes_ia`, `ia_oferece`/`ia_agenda` e `pai_id` para a variação ser item do catálogo ligado ao principal, com `revision` para a escrita concorrente responder 409 (issue #3372, fatia B — complementa a #2497 sem criar tabela de serviço com preço).
--
-- ─── Por que colunas no catálogo, e não uma tabela de serviço ───────────────
--
-- A #2497 recusou a segunda tabela de serviços com preço, e a pergunta 3 da
-- #3372 oferece as duas formas. Colunas anuláveis em `catalog_products` mantêm
-- UMA fonte para o item e para o preço: um serviço é um item do catálogo que TEM
-- tipo; um produto de prateleira é o mesmo item sem tipo. Com tabela 1:1, toda
-- leitura de preço do agente passaria a precisar de um `join` opcional, e o dia
-- em que ele faltasse o serviço sairia da busca em silêncio.
--
-- `tipo_servico is null` = produto. É o que mantém as instalações existentes
-- exatamente como estão: nenhuma linha velha ganha tipo, unidade ou sinal.
--
-- ─── A variação é item, não linha de detalhe ────────────────────────────────
--
-- "12 posts por R$ 1.200" e "20 posts + 4 reels por R$ 1.900" são dois ITENS com
-- nome, código e preço próprios (é o que a #2497 já sabe vender), ligados ao
-- principal por `pai_id`. O principal guarda o que é comum — descrição, fotos,
-- tipo, unidade, sinal; a variação NÃO repete tipo nem unidade, e o CHECK
-- `catalog_products_servico_variacao_check` recusa a tentativa. Dois lugares
-- dizendo de que tipo é o mesmo serviço divergem na primeira edição.
--
-- ─── O que o banco garante, e o que fica na API ─────────────────────────────
--
-- Aqui: unidade compatível com o tipo, prazo só em projeto, sinal percentual de
-- 1 a 100 ou fixo positivo, serviço sem estoque, variação que não carrega
-- detalhe, variação da mesma organização e com pai que é serviço, revisão que
-- só cresce.
--
-- Na API (`lib/schemas/servicos.ts`): o sinal FIXO não passar do preço da menor
-- variação. Isso depende de ler as variações irmãs, e um CHECK não enxerga
-- outras linhas; um gatilho faria toda escrita de item pagar a leitura só por
-- causa de um campo opcional de serviço. A rota recusa com 422 e o teste prova.

alter table public.catalog_products
  add column if not exists tipo_servico text,
  add column if not exists unidade_cobranca text,
  add column if not exists prazo_dias_uteis integer,
  add column if not exists sinal_tipo text,
  add column if not exists sinal_percentual numeric(5, 2),
  add column if not exists sinal_cents bigint,
  add column if not exists instrucoes_ia text,
  -- `ia_oferece` nasce LIGADO (só lê: a IA pode oferecer o serviço na conversa);
  -- `ia_agenda` nasce DESLIGADO (escreve: reserva horário). Mesma régua dos
  -- módulos opcionais — o que escreve nasce fechado.
  add column if not exists ia_oferece boolean not null default true,
  add column if not exists ia_agenda boolean not null default false,
  add column if not exists pai_id uuid,
  add column if not exists revision integer not null default 1;

comment on column public.catalog_products.tipo_servico is
  'Tipo do serviço (issue #3372): hora_marcada, projeto ou recorrente. NULL = produto de prateleira, que é o que toda linha anterior a esta migration é.';
comment on column public.catalog_products.unidade_cobranca is
  'Como o item é cobrado: sessao/hora (hora marcada), valor_fechado/hora (projeto), mes/trimestre/ano (recorrente). A compatibilidade com o tipo é CHECK, não convenção.';
comment on column public.catalog_products.prazo_dias_uteis is
  'Prazo de entrega em dias úteis — só existe em projeto; CHECK recusa em qualquer outro tipo.';
comment on column public.catalog_products.sinal_tipo is
  'Como o sinal é calculado: percentual (sinal_percentual, 1 a 100) ou fixo (sinal_cents). O valor por variação é calculado na leitura, nunca copiado.';
comment on column public.catalog_products.instrucoes_ia is
  'Instruções internas para a IA: orientam a conversa e NUNCA vão ao cliente. A busca do agente devolve marcadas como "não repita ao cliente".';
comment on column public.catalog_products.ia_agenda is
  'Quando ligado, a IA pode reservar horário deste serviço. Nasce desligado: quem escreve (agenda) nasce fechado, quem só lê (ia_oferece) nasce aberto.';
comment on column public.catalog_products.pai_id is
  'Variação do serviço: aponta para o item principal, que carrega tipo, unidade, prazo e sinal. A variação tem nome, código e preço próprios e ZERO detalhe de serviço (CHECK).';
comment on column public.catalog_products.revision is
  'Só cresce (gatilho). É o que faz PATCH com `expected_revision` velho responder 409 em vez de sobrescrever a edição de outra pessoa.';

-- ⚠️ drop + add num bloco DO só: o `update.sh` reaplica o baseline sem
-- ON_ERROR_STOP e em autocommit. Soltos, um `add` que falhasse deixaria a coluna
-- sem guarda nenhuma até a próxima passada.
do $$
begin
  alter table public.catalog_products
    drop constraint if exists catalog_products_tipo_servico_check;
  alter table public.catalog_products
    add constraint catalog_products_tipo_servico_check
      check (
        tipo_servico is null
        or tipo_servico in ('hora_marcada', 'projeto', 'recorrente')
      );

  alter table public.catalog_products
    drop constraint if exists catalog_products_unidade_cobranca_check;
  alter table public.catalog_products
    add constraint catalog_products_unidade_cobranca_check
      check (
        unidade_cobranca is null
        or unidade_cobranca in ('sessao', 'hora', 'valor_fechado', 'mes', 'trimestre', 'ano')
      );

  -- Tipo e unidade nascem juntos: serviço sem unidade não tem preço legível
  -- ("R$ 1.200,00" de quê?), e unidade sem tipo é produto com unidade de serviço.
  -- A compatibilidade espelha `UNIDADES_POR_TIPO` (`lib/catalogo/servicos.ts`).
  alter table public.catalog_products
    drop constraint if exists catalog_products_servico_unidade_check;
  alter table public.catalog_products
    add constraint catalog_products_servico_unidade_check
      check (
        (tipo_servico is null) = (unidade_cobranca is null)
        and (
          tipo_servico is null
          or (tipo_servico = 'hora_marcada' and unidade_cobranca in ('sessao', 'hora'))
          or (tipo_servico = 'projeto' and unidade_cobranca in ('valor_fechado', 'hora'))
          or (tipo_servico = 'recorrente' and unidade_cobranca in ('mes', 'trimestre', 'ano'))
        )
      );

  alter table public.catalog_products
    drop constraint if exists catalog_products_servico_prazo_check;
  alter table public.catalog_products
    add constraint catalog_products_servico_prazo_check
      check (
        prazo_dias_uteis is null
        or (tipo_servico = 'projeto' and prazo_dias_uteis between 1 and 3650)
      );

  alter table public.catalog_products
    drop constraint if exists catalog_products_servico_sinal_check;
  alter table public.catalog_products
    add constraint catalog_products_servico_sinal_check
      check (
        (sinal_tipo is null and sinal_percentual is null and sinal_cents is null)
        or (
          tipo_servico is not null
          and (
            (sinal_tipo = 'percentual' and sinal_percentual between 1 and 100 and sinal_cents is null)
            or (sinal_tipo = 'fixo' and sinal_cents > 0 and sinal_percentual is null)
          )
        )
      );

  -- Serviço nunca controla estoque (#2497, pergunta 3). Sem isto, um serviço
  -- cadastrado com o default `controla_estoque = true` e quantidade 0 sairia da
  -- busca do agente como "sem estoque" — invisível para quem quer comprá-lo.
  alter table public.catalog_products
    drop constraint if exists catalog_products_servico_sem_estoque_check;
  alter table public.catalog_products
    add constraint catalog_products_servico_sem_estoque_check
      check (
        tipo_servico is null
        or (controla_estoque = false and quantidade = 0)
      );

  alter table public.catalog_products
    drop constraint if exists catalog_products_servico_variacao_check;
  alter table public.catalog_products
    add constraint catalog_products_servico_variacao_check
      check (
        pai_id is null
        or (
          tipo_servico is null
          and unidade_cobranca is null
          and prazo_dias_uteis is null
          and sinal_tipo is null
          and sinal_percentual is null
          and sinal_cents is null
        )
      );

  alter table public.catalog_products
    drop constraint if exists catalog_products_pai_nao_e_ele_mesmo_check;
  alter table public.catalog_products
    add constraint catalog_products_pai_nao_e_ele_mesmo_check
      check (pai_id is null or pai_id <> id);

  alter table public.catalog_products
    drop constraint if exists catalog_products_revision_check;
  alter table public.catalog_products
    add constraint catalog_products_revision_check
      check (revision >= 1);
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'catalog_products_pai_fkey'
      and conrelid = 'public.catalog_products'::regclass
  ) then
    alter table public.catalog_products
      add constraint catalog_products_pai_fkey
        foreign key (pai_id) references public.catalog_products(id) on delete set null;
  end if;
end
$$;

-- A listagem de um serviço com as variações é `where pai_id = $1`; a busca do
-- agente filtra os serviços por `tipo_servico is not null`. Índice parcial: a
-- esmagadora maioria das linhas é produto, e elas não entram nele.
create index if not exists catalog_products_pai_idx
  on public.catalog_products (pai_id)
  where (pai_id is not null);

create index if not exists catalog_products_servico_idx
  on public.catalog_products (organization_id, tipo_servico)
  where (tipo_servico is not null);

-- A revisão só cresce: quem edita manda a que viu, e a rota compara. Sem o
-- gatilho, `revision` seria uma coluna que ninguém atualiza e o 409 nunca
-- chegaria (o segundo a salvar sobrescreveria o primeiro em silêncio).
create or replace function public.fn_catalog_products_proxima_revisao()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.revision := old.revision + 1;
  return new;
end;
$fn$;

drop trigger if exists trg_catalog_products_proxima_revisao on public.catalog_products;
create trigger trg_catalog_products_proxima_revisao
  before update on public.catalog_products
  for each row execute function public.fn_catalog_products_proxima_revisao();

-- A variação só pertence a um item de serviço DA MESMA organização.
--
-- Sem este gatilho, `pai_id` seria uma FK para qualquer item de qualquer
-- organização: a RLS guardaria a LEITURA, mas o vínculo atravessaria o tenant e
-- a variação apareceria no serviço do vizinho para quem lê as duas. Erro com
-- motivo legível porque quem lê é a rota (422) ou quem opera o banco.
create or replace function public.fn_catalog_products_servico_variacao()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  pai public.catalog_products%rowtype;
begin
  if new.pai_id is null then
    return new;
  end if;

  select * into pai from public.catalog_products where id = new.pai_id;

  if not found then
    raise exception 'variacao_sem_pai: o serviço principal informado não existe nesta organização'
      using errcode = '23503';
  end if;
  if pai.organization_id <> new.organization_id then
    raise exception 'variacao_de_outra_organizacao: a variação precisa ser da mesma organização do serviço principal'
      using errcode = '23514';
  end if;
  -- A variação de uma variação vem ANTES da checagem de tipo: a variação tem
  -- `tipo_servico` nulo (o CHECK a proíbe de carregar tipo), então perguntar
  -- "o pai é serviço?" primeiro responderia `pai_nao_e_servico` para um erro
  -- que é outro — e quem lê a mensagem iria procurar o problema no lugar errado.
  if pai.pai_id is not null then
    raise exception 'variacao_nao_tem_variacao: o item principal já é uma variação'
      using errcode = '23514';
  end if;
  if pai.tipo_servico is null then
    raise exception 'pai_nao_e_servico: uma variação só pode pertencer a um item marcado como serviço'
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_catalog_products_servico_variacao on public.catalog_products;
create trigger trg_catalog_products_servico_variacao
  before insert or update of pai_id on public.catalog_products
  for each row execute function public.fn_catalog_products_servico_variacao();

-- Sem isto o campo existe no banco e o PostgREST segue servindo o schema velho:
-- `?tipo_servico=not.is.null` volta 400 até alguém reiniciar o serviço à mão.
notify pgrst, 'reload schema';
