-- O relatório ganha as duas perguntas que faltavam: QUAL serviço e QUAL cliente.
--
-- A 0353 respondeu "quanto entrou" e "de que forma". Faltavam as duas que
-- decidem o que o negócio faz na semana seguinte:
--
--   - **por serviço**: onde o faturamento realmente nasce. Sem isso, a resposta
--     para "o que eu devo oferecer mais?" é palpite;
--   - **por cliente**: quem sustenta a casa. É também o que torna possível
--     reparar em quem parou de vir.
--
-- ═══ POR QUE `create or replace` E NÃO UMA FUNÇÃO NOVA ═══
--
-- É o MESMO relatório, e quebrar em duas funções faria a tela pedir dois
-- períodos e devolver dois recortes que podem discordar se alguém fechar uma
-- comanda entre as duas chamadas. Um período, uma leitura, uma resposta.
--
-- A assinatura não muda, então o apêndice do baseline substitui o corpo antigo
-- sem migração de dado e sem quebrar quem já chamava.
--
-- ═══ O CORTE DE 10 É DO RELATÓRIO, NÃO DA VERDADE ═══
--
-- `limit 10` nas duas listas existe porque a tela mostra dez linhas, e não
-- porque dez seja a resposta. O agregado que importa (faturado, saldo) continua
-- somando TUDO — o corte está na lista, nunca no total, que é exatamente a
-- diferença entre resumir e truncar.

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
    select direction, amount_cents
      from public.financial_entries
     where organization_id = p_org
       and status = 'paid'
       and entry_date between p_de and p_ate
  ),
  comandas as (
    select id, status, total_cents, reversed_at, payment_method_id, contact_id
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
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.fn_relatorio_financeiro(uuid, date, date) from public, anon;
grant  execute on function public.fn_relatorio_financeiro(uuid, date, date) to authenticated, service_role;
