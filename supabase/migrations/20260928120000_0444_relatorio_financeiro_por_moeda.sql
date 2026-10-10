-- O relatório financeiro separa as moedas (#1531).
--
-- `financial_entries.currency` e `sales.currency` existem desde que o módulo
-- financeiro nasceu, mas a 0353 e a 0356 somavam `amount_cents` e
-- `total_cents` sem olhar para elas. R$ 150,00 mais 200,00 € viravam
-- "35000", e a tela escrevia isso em real: um número que não existe em moeda
-- nenhuma, com cara de verdade. É a mesma regra que o total da coluna do
-- Kanban já segue (`somaPorMoeda` em `lib/money.ts`): cada moeda no seu balde,
-- nunca uma soma entre elas, nada convertido.
--
-- ═══ POR QUE UM CAMPO NOVO E NÃO TROCAR OS QUE EXISTEM ═══
--
-- O relatório sai por `/api/v1/reports/financeiro`, e a função tem `grant` para
-- `authenticated` — qualquer sessão a chama por RPC. Mudar a forma ou o
-- significado de `faturado_cents` numa minor quebraria quem já lê o campo
-- (docs/doctrine/versionamento.md). Então esta migration é ADITIVA:
--
--   - assinatura, `returns jsonb`, `stable`, INVOKER, `search_path` e grants
--     ficam iguais aos da 0356;
--   - as treze chaves de antes saem das MESMAS expressões, sobre os mesmos
--     CTEs — o único acréscimo neles é `currency` no select de `lancamentos` e
--     de `comandas`;
--   - entra `por_moeda`: para cada moeda com movimento no período, as mesmas
--     onze chaves de dinheiro e de lista do topo, calculadas só com as linhas
--     daquela moeda. Sem movimento, `{}`.
--
-- ═══ O QUE OS CAMPOS DO TOPO SIGNIFICAM COM VÁRIAS MOEDAS ═══
--
-- Exatamente o que sempre significaram: a SOMA DE TODAS AS MOEDAS. Com uma
-- moeda no período, são o valor certo naquela moeda; com duas ou mais, não são
-- valor em moeda nenhuma, e quem precisa do número lê `por_moeda`. As contagens
-- (`comandas_finalizadas`, `quantidade`, `itens`) continuam válidas no topo, e
-- o corte de 10 das listas antigas continua sobre a soma misturada.
--
-- ═══ O TICKET MÉDIO POR MOEDA USA A MESMA CONTA DO TOPO ═══
--
-- `sum / nullif(count, 0)` em numeric, sem arredondar — o topo já sai
-- fracionário hoje, e arredondar só no bloco mudaria a forma do número. Com uma
-- moeda só, `por_moeda[X]` é idêntico ao topo, e o invariante
-- `tests/invariants/relatorio-financeiro-por-moeda.test.ts` prende isso.
--
-- A comissão e o item da comanda não têm moeda própria: herdam a da comanda
-- pelo join com `comandas`, que é de onde o valor deles saiu.

create or replace function public.fn_relatorio_financeiro(
  p_org uuid,
  p_de date,
  p_ate date
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with lancamentos as (
    select direction, amount_cents, currency
      from public.financial_entries
     where organization_id = p_org
       and status = 'paid'
       and entry_date between p_de and p_ate
  ),
  comandas as (
    select id, status, total_cents, currency, reversed_at, payment_method_id, contact_id
      from public.sales
     where organization_id = p_org
       and finalized_at is not null
       and finalized_at::date between p_de and p_ate
  ),
  por_forma as (
    select coalesce(pm.name, 'Sem forma') as nome,
           count(*)                       as quantidade,
           sum(c.total_cents)             as total_cents
      from comandas c
      left join public.payment_methods pm
        on pm.id = c.payment_method_id and pm.organization_id = p_org
     group by 1
  ),
  por_profissional as (
    select co.attendant_user_id,
           count(*)              as itens,
           sum(co.amount_cents)  as comissao_cents
      from public.commissions co
      join public.sale_items si
        on si.id = co.sale_item_id and si.organization_id = p_org
      join comandas s on s.id = si.sale_id
     where co.organization_id = p_org
       and co.status <> 'reversed'
     group by 1
  ),
  por_servico as (
    -- Agrupa pela DESCRIÇÃO congelada no item, e não pelo nome atual do tipo de
    -- evento. É o que o cliente comprou, com o nome que tinha na hora — e é o
    -- único agrupamento que continua verdadeiro depois de alguém renomear um
    -- serviço. O item avulso (sem `event_type_id`) entra por aqui também, em vez
    -- de sumir do relatório.
    select si.description       as nome,
           sum(si.quantity)     as quantidade,
           sum(si.total_cents)  as total_cents
      from public.sale_items si
      join comandas s on s.id = si.sale_id
     where si.organization_id = p_org
     group by 1
  ),
  por_cliente as (
    select c.contact_id,
           count(*)             as comandas,
           sum(c.total_cents)   as total_cents
      from comandas c
     where c.contact_id is not null
     group by 1
  ),
  -- Daqui para baixo, os mesmos agrupamentos com a moeda na chave. Ficam
  -- paralelos aos de cima, em vez de o topo passar a somar os blocos, para que
  -- se prove por leitura que nenhum campo antigo mudou de conta.
  moedas as (
    select currency as moeda from lancamentos
    union
    select currency from comandas
  ),
  forma_por_moeda as (
    select c.currency                     as moeda,
           coalesce(pm.name, 'Sem forma') as nome,
           count(*)                       as quantidade,
           sum(c.total_cents)             as total_cents
      from comandas c
      left join public.payment_methods pm
        on pm.id = c.payment_method_id and pm.organization_id = p_org
     group by 1, 2
  ),
  profissional_por_moeda as (
    select s.currency            as moeda,
           co.attendant_user_id,
           count(*)              as itens,
           sum(co.amount_cents)  as comissao_cents
      from public.commissions co
      join public.sale_items si
        on si.id = co.sale_item_id and si.organization_id = p_org
      join comandas s on s.id = si.sale_id
     where co.organization_id = p_org
       and co.status <> 'reversed'
     group by 1, 2
  ),
  servico_por_moeda as (
    select s.currency           as moeda,
           si.description       as nome,
           sum(si.quantity)     as quantidade,
           sum(si.total_cents)  as total_cents
      from public.sale_items si
      join comandas s on s.id = si.sale_id
     where si.organization_id = p_org
     group by 1, 2
  ),
  cliente_por_moeda as (
    select c.currency           as moeda,
           c.contact_id,
           count(*)             as comandas,
           sum(c.total_cents)   as total_cents
      from comandas c
     where c.contact_id is not null
     group by 1, 2
  )
  select jsonb_build_object(
    'de', p_de,
    'ate', p_ate,
    'entradas_cents', coalesce((select sum(amount_cents) from lancamentos where direction = 'in'), 0),
    'saidas_cents',   coalesce((select sum(amount_cents) from lancamentos where direction = 'out'), 0),
    'saldo_cents',    coalesce((select sum(case when direction = 'in' then amount_cents else -amount_cents end) from lancamentos), 0),
    'comandas_finalizadas', (select count(*) from comandas),
    'comandas_estornadas',  (select count(*) from comandas where reversed_at is not null),
    'faturado_cents',       coalesce((select sum(total_cents) from comandas), 0),
    'ticket_medio_cents',   coalesce((select sum(total_cents) / nullif(count(*), 0) from comandas), 0),
    'por_forma', coalesce((
      select jsonb_agg(jsonb_build_object('nome', nome, 'quantidade', quantidade, 'total_cents', total_cents)
             order by total_cents desc)
        from por_forma
    ), '[]'::jsonb),
    'por_profissional', coalesce((
      select jsonb_agg(jsonb_build_object('attendant_user_id', attendant_user_id, 'itens', itens, 'comissao_cents', comissao_cents)
             order by comissao_cents desc)
        from por_profissional
    ), '[]'::jsonb),
    'por_servico', coalesce((
      select jsonb_agg(jsonb_build_object('nome', nome, 'quantidade', quantidade, 'total_cents', total_cents)
             order by total_cents desc)
        from (select * from por_servico order by total_cents desc limit 10) t
    ), '[]'::jsonb),
    'por_cliente', coalesce((
      select jsonb_agg(jsonb_build_object('contact_id', contact_id, 'comandas', comandas, 'total_cents', total_cents)
             order by total_cents desc)
        from (select * from por_cliente order by total_cents desc limit 10) t
    ), '[]'::jsonb),
    -- O corte de 10 vale POR MOEDA: a lista do real e a do euro são listas
    -- diferentes, e cortar a soma misturada deixaria a moeda menor sem linha.
    'por_moeda', coalesce((
      select jsonb_object_agg(m.moeda, jsonb_build_object(
        'entradas_cents', coalesce((select sum(l.amount_cents) from lancamentos l where l.currency = m.moeda and l.direction = 'in'), 0),
        'saidas_cents',   coalesce((select sum(l.amount_cents) from lancamentos l where l.currency = m.moeda and l.direction = 'out'), 0),
        'saldo_cents',    coalesce((select sum(case when l.direction = 'in' then l.amount_cents else -l.amount_cents end) from lancamentos l where l.currency = m.moeda), 0),
        'comandas_finalizadas', (select count(*) from comandas c where c.currency = m.moeda),
        'comandas_estornadas',  (select count(*) from comandas c where c.currency = m.moeda and c.reversed_at is not null),
        'faturado_cents',       coalesce((select sum(c.total_cents) from comandas c where c.currency = m.moeda), 0),
        'ticket_medio_cents',   coalesce((select sum(c.total_cents) / nullif(count(*), 0) from comandas c where c.currency = m.moeda), 0),
        'por_forma', coalesce((
          select jsonb_agg(jsonb_build_object('nome', f.nome, 'quantidade', f.quantidade, 'total_cents', f.total_cents)
                 order by f.total_cents desc)
            from forma_por_moeda f
           where f.moeda = m.moeda
        ), '[]'::jsonb),
        'por_profissional', coalesce((
          select jsonb_agg(jsonb_build_object('attendant_user_id', p.attendant_user_id, 'itens', p.itens, 'comissao_cents', p.comissao_cents)
                 order by p.comissao_cents desc)
            from profissional_por_moeda p
           where p.moeda = m.moeda
        ), '[]'::jsonb),
        'por_servico', coalesce((
          select jsonb_agg(jsonb_build_object('nome', t.nome, 'quantidade', t.quantidade, 'total_cents', t.total_cents)
                 order by t.total_cents desc)
            from (select * from servico_por_moeda sv where sv.moeda = m.moeda order by sv.total_cents desc limit 10) t
        ), '[]'::jsonb),
        'por_cliente', coalesce((
          select jsonb_agg(jsonb_build_object('contact_id', t.contact_id, 'comandas', t.comandas, 'total_cents', t.total_cents)
                 order by t.total_cents desc)
            from (select * from cliente_por_moeda cl where cl.moeda = m.moeda order by cl.total_cents desc limit 10) t
        ), '[]'::jsonb)
      ))
        from moedas m
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.fn_relatorio_financeiro(uuid, date, date) from public, anon;
grant  execute on function public.fn_relatorio_financeiro(uuid, date, date) to authenticated, service_role;
