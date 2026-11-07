-- manifest: Catálogo de serviços como módulo opcional (#3372, #3480, doc 212 = A/A): `fn_catalogo_servicos_provisionar()` cria `catalog_service_details` (1:1 com `catalog_products`, SEM preço) só onde o módulo é instalado; `fn_catalogo_servicos_salvar` grava item e detalhe numa transação, com a família travada e a regra do sinal fixo conferida no estado final. `catalog_products` não muda e nenhuma instalação muda sozinha.
--
-- 9248 — o serviço nasce como módulo opcional (ADR-0002).
--
-- A base é de @webtecnica (#3480): tipo, unidade, prazo, sinal, instruções à IA e
-- variação como item próprio do catálogo. O doc 212 decidiu o destino (módulo
-- opcional) e o preço (fica onde está). Por isso:
--
--   - o serviço e cada variação continuam sendo linhas de `catalog_products`, com
--     nome, código e PREÇO lá — a fonte de preço não muda;
--   - o que é de serviço mora em `catalog_service_details`, uma linha por item,
--     criada só por `fn_modulo_instalar('catalogo_servicos', …)`;
--   - esta migration cria FUNÇÕES e tabela nenhuma (ADR-0002, D2/D7).
--
-- Se o detalhe faltar, o item segue na busca como produto comum: o join é do
-- módulo, nunca uma condição para o produto existir.

-- ─── 1 · a conferência dos vínculos ────────────────────────────────────────
-- `catalog_products` não tem chave (organization_id, id), e uma provisionadora
-- não pode acrescentá-la ao núcleo (D4). A conferência é gatilho na tabela do
-- módulo: o detalhe nunca aponta para item ou principal de outra organização, e
-- o vínculo não muda depois de criado (trocar a família de uma variação é
-- apagar e cadastrar de novo, não editar).
create or replace function public.fn_catalogo_servicos_conferir_vinculos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  if tg_op = 'UPDATE' then
    if row(new.organization_id, new.product_id, new.pai_product_id)
       is distinct from row(old.organization_id, old.product_id, old.pai_product_id) then
      raise exception 'catalogo_servicos_vinculo_imutavel' using errcode = '23514';
    end if;
    return new;
  end if;
  if not exists (select 1 from public.catalog_products
                  where organization_id = new.organization_id and id = new.product_id) then
    raise exception 'catalogo_servicos_vinculo_invalido' using errcode = '23503';
  end if;
  -- A variação pertence a um PRINCIPAL da mesma organização: variação de
  -- variação não existe, porque o principal é quem diz tipo, unidade e sinal.
  if new.pai_product_id is not null
     and not exists (select 1 from public.catalog_service_details
                      where organization_id = new.organization_id
                        and product_id = new.pai_product_id
                        and pai_product_id is null) then
    raise exception 'catalogo_servicos_vinculo_invalido' using errcode = '23503';
  end if;
  return new;
end $f$;
revoke execute on function public.fn_catalogo_servicos_conferir_vinculos() from public, anon, authenticated, service_role;

-- ─── 2 · a provisionadora (ADR-0002, D2) ───────────────────────────────────
-- Sem parâmetro, idempotente, só `service_role`. Escrita só pelo servidor:
-- `authenticated` lê os detalhes da própria organização e não grava nada. Isso
-- fecha o contorno que uma policy de escrita por papel abriria — gravar o sinal
-- pelo PostgREST sem passar pela trava da família (`fn_catalogo_servicos_salvar`).
--
-- Os CHECKs são escritos para NUNCA darem NULL: toda comparação vem depois de um
-- `is not null` na mesma conjunção. Um CHECK que resulta em NULL passa (é assim
-- que o Postgres trata), e a versão anterior aceitava `tipo NULL + prazo 5`.
create or replace function public.fn_catalogo_servicos_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.catalog_service_details (
    -- 1:1 com o item. Apagar o item apaga o detalhe; o preço nunca mora aqui.
    product_id uuid not null,
    organization_id uuid not null references public.organizations(id) on delete cascade,

    -- Variação: aponta para o detalhe do principal. Apagar o principal apaga o
    -- detalhe das variações, e os itens delas voltam a ser produtos comuns do
    -- catálogo, com nome e preço intactos. Nenhum item é apagado em cascata.
    pai_product_id uuid,

    -- Só o principal tem tipo, unidade, prazo, sinal e instruções.
    tipo text,
    unidade text,
    prazo_dias_uteis integer,
    sinal_tipo text,
    sinal_percentual numeric(5, 2),
    sinal_cents bigint,
    -- Orientam a conversa e NUNCA vão ao cliente.
    instrucoes_ia text,
    -- Só lê (oferecer na conversa): nasce ligado. No principal vale para a
    -- família inteira; na variação, só para ela.
    ia_oferece boolean not null default true,

    -- Só cresce, e só por `fn_catalogo_servicos_salvar`. Edição com revisão velha = 409.
    revision integer not null default 1,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint catalog_service_details_pkey primary key (product_id),
    constraint catalog_service_details_product_fkey
      foreign key (product_id) references public.catalog_products(id) on delete cascade,
    constraint catalog_service_details_pai_fkey
      foreign key (pai_product_id) references public.catalog_service_details(product_id) on delete cascade,

    -- Principal: tipo e unidade da mesma família. Variação: nada de serviço.
    constraint catalog_service_details_forma_check check (
      (pai_product_id is null and tipo is not null and unidade is not null and (
           (tipo = 'hora_marcada' and unidade in ('sessao', 'hora'))
        or (tipo = 'projeto' and unidade in ('valor_fechado', 'hora'))
        or (tipo = 'recorrente' and unidade in ('mes', 'trimestre', 'ano'))
      ))
      or (pai_product_id is not null and tipo is null and unidade is null
          and prazo_dias_uteis is null and sinal_tipo is null and sinal_percentual is null
          and sinal_cents is null and instrucoes_ia is null)
    ),
    constraint catalog_service_details_prazo_check check (
      prazo_dias_uteis is null
      or (tipo is not null and tipo = 'projeto' and prazo_dias_uteis between 1 and 3650)
    ),
    constraint catalog_service_details_sinal_check check (
      (sinal_tipo is null and sinal_percentual is null and sinal_cents is null)
      or (sinal_tipo is not null and sinal_tipo = 'percentual' and sinal_percentual is not null
          and sinal_percentual between 1 and 100 and sinal_cents is null)
      or (sinal_tipo is not null and sinal_tipo = 'fixo' and sinal_cents is not null
          and sinal_cents > 0 and sinal_percentual is null)
    ),
    constraint catalog_service_details_pai_check check (
      pai_product_id is null or pai_product_id <> product_id
    ),
    constraint catalog_service_details_instrucoes_check check (
      instrucoes_ia is null or length(instrucoes_ia) <= 2000
    ),
    constraint catalog_service_details_revision_check check (revision >= 1)
  );

  create index if not exists catalog_service_details_principais_idx
    on public.catalog_service_details (organization_id, product_id)
    where pai_product_id is null;
  create index if not exists catalog_service_details_variacoes_idx
    on public.catalog_service_details (organization_id, pai_product_id)
    where pai_product_id is not null;

  alter table public.catalog_service_details enable row level security;
  drop policy if exists catalog_service_details_select on public.catalog_service_details;
  create policy catalog_service_details_select
    on public.catalog_service_details
    for select using (
      public.fn_is_platform_admin()
      or organization_id in (select public.fn_user_org_ids())
    );
  revoke all on table public.catalog_service_details from anon, authenticated, service_role;
  grant select on table public.catalog_service_details to authenticated;
  grant select, insert, update, delete on table public.catalog_service_details to service_role;

  drop trigger if exists trg_catalogo_servicos_conferir_vinculos on public.catalog_service_details;
  create trigger trg_catalogo_servicos_conferir_vinculos
    before insert or update on public.catalog_service_details
    for each row execute function public.fn_catalogo_servicos_conferir_vinculos();

  comment on table public.catalog_service_details is
    'Catálogo de serviços (módulo opcional, ADR-0002): tipo, unidade, prazo, sinal e instruções de um item de catalog_products. Sem preço: o preço é o do item.';

  perform public.fn_proteger_modulo_provisionado();
end
$f$;
revoke execute on function public.fn_catalogo_servicos_provisionar() from public, anon, authenticated;
grant execute on function public.fn_catalogo_servicos_provisionar() to service_role;

-- ─── 3 · a escrita numa transação só, com a família travada ────────────────
-- Item (`catalog_products`) e detalhe nascem e mudam juntos: não existe serviço
-- pela metade, e o código repetido que derruba o item não deixa detalhe órfão.
--
-- O sinal FIXO não pode passar do menor preço da família (principal e
-- variações). A regra lê linhas irmãs, então não cabe num CHECK; ela roda aqui,
-- DEPOIS de gravar, sobre o estado final, com o principal travado — duas
-- edições da mesma família (o sinal de um lado, o preço de uma variação do
-- outro) passam em fila e a segunda vê a primeira. Recusa desfaz tudo.
--
-- `p_id` nulo cria; preenchido edita só as chaves presentes em `p_item` e
-- `p_detalhe`. A organização vem do servidor (cookie validado), nunca do corpo.
-- `record`, nunca `%rowtype`: a função existe onde a tabela não existe (D7).
create or replace function public.fn_catalogo_servicos_salvar(
  p_org uuid, p_id uuid, p_item jsonb, p_detalhe jsonb, p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  d record;
  v_id uuid;
  v_principal uuid;
  v_sinal record;
  v_menor bigint;
  v_revisao integer;
begin
  if to_regclass('public.catalog_service_details') is null then
    raise exception 'catalogo_servicos_nao_instalado' using errcode = 'P0002';
  end if;

  if p_id is null then
    v_principal := nullif(p_detalhe->>'pai_product_id', '')::uuid;
  else
    select product_id, pai_product_id into d from public.catalog_service_details
     where organization_id = p_org and product_id = p_id;
    if not found then
      raise exception 'servico_nao_encontrado' using errcode = 'P0002';
    end if;
    v_principal := coalesce(d.pai_product_id, d.product_id);
  end if;

  if v_principal is not null then
    perform 1 from public.catalog_service_details
     where organization_id = p_org and product_id = v_principal and pai_product_id is null
     for update;
    if not found then
      raise exception 'servico_principal_nao_encontrado' using errcode = 'P0002';
    end if;
  end if;

  if p_id is null then
    insert into public.catalog_products
      (organization_id, codigo, nome, descricao, preco_cents, moeda, origem, controla_estoque, quantidade)
    values
      (p_org, p_item->>'codigo', p_item->>'nome', nullif(p_item->>'descricao', ''),
       (p_item->>'preco_cents')::bigint, p_item->>'moeda', 'manual', false, 0)
    returning id into v_id;

    insert into public.catalog_service_details
      (product_id, organization_id, pai_product_id, tipo, unidade, prazo_dias_uteis,
       sinal_tipo, sinal_percentual, sinal_cents, instrucoes_ia, ia_oferece)
    values
      (v_id, p_org, v_principal, p_detalhe->>'tipo', p_detalhe->>'unidade',
       (p_detalhe->>'prazo_dias_uteis')::integer, p_detalhe->>'sinal_tipo',
       (p_detalhe->>'sinal_percentual')::numeric, (p_detalhe->>'sinal_cents')::bigint,
       nullif(p_detalhe->>'instrucoes_ia', ''), coalesce((p_detalhe->>'ia_oferece')::boolean, true));
  else
    v_id := p_id;
    -- A revisão é lida DEPOIS da trava: a comparação vale para o estado que
    -- esta transação vai mudar, não para um que outra acabou de trocar.
    select revision into v_revisao from public.catalog_service_details
     where organization_id = p_org and product_id = p_id;
    if v_revisao is distinct from p_expected_revision then
      raise exception 'servico_revisao_velha' using errcode = 'PT409', detail = coalesce(v_revisao::text, '');
    end if;

    update public.catalog_products set
      codigo = case when p_item ? 'codigo' then p_item->>'codigo' else codigo end,
      nome = case when p_item ? 'nome' then p_item->>'nome' else nome end,
      descricao = case when p_item ? 'descricao' then nullif(p_item->>'descricao', '') else descricao end,
      preco_cents = case when p_item ? 'preco_cents' then (p_item->>'preco_cents')::bigint else preco_cents end
    where organization_id = p_org and id = p_id;

    update public.catalog_service_details set
      tipo = case when p_detalhe ? 'tipo' then p_detalhe->>'tipo' else tipo end,
      unidade = case when p_detalhe ? 'unidade' then p_detalhe->>'unidade' else unidade end,
      prazo_dias_uteis = case when p_detalhe ? 'prazo_dias_uteis' then (p_detalhe->>'prazo_dias_uteis')::integer else prazo_dias_uteis end,
      sinal_tipo = case when p_detalhe ? 'sinal_tipo' then p_detalhe->>'sinal_tipo' else sinal_tipo end,
      sinal_percentual = case when p_detalhe ? 'sinal_tipo' then (p_detalhe->>'sinal_percentual')::numeric else sinal_percentual end,
      sinal_cents = case when p_detalhe ? 'sinal_tipo' then (p_detalhe->>'sinal_cents')::bigint else sinal_cents end,
      instrucoes_ia = case when p_detalhe ? 'instrucoes_ia' then nullif(p_detalhe->>'instrucoes_ia', '') else instrucoes_ia end,
      ia_oferece = case when p_detalhe ? 'ia_oferece' then (p_detalhe->>'ia_oferece')::boolean else ia_oferece end,
      revision = revision + 1,
      updated_at = now()
    where organization_id = p_org and product_id = p_id;
  end if;

  v_principal := coalesce(v_principal, v_id);
  select sinal_tipo, sinal_cents into v_sinal from public.catalog_service_details
   where organization_id = p_org and product_id = v_principal;
  if v_sinal.sinal_tipo = 'fixo' then
    select min(p.preco_cents) into v_menor
      from public.catalog_service_details s
      join public.catalog_products p on p.organization_id = s.organization_id and p.id = s.product_id
     where s.organization_id = p_org and (s.product_id = v_principal or s.pai_product_id = v_principal);
    if v_menor is not null and v_sinal.sinal_cents > v_menor then
      raise exception 'servico_sinal_acima_do_preco' using errcode = '23514';
    end if;
  end if;

  select revision into v_revisao from public.catalog_service_details
   where organization_id = p_org and product_id = v_id;
  return jsonb_build_object('product_id', v_id, 'principal_id', v_principal, 'revision', v_revisao);
end $f$;
revoke execute on function public.fn_catalogo_servicos_salvar(uuid, uuid, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function public.fn_catalogo_servicos_salvar(uuid, uuid, jsonb, jsonb, integer) to service_role;

notify pgrst, 'reload schema';
