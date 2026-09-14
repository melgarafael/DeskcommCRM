-- O relatório do faturamento, agregado NO BANCO.
--
-- ═══ POR QUE UMA FUNÇÃO, E NÃO QUATRO CONSULTAS NA ROTA ═══
--
-- O PostgREST devolve no máximo 1000 linhas por requisição, e isso não é erro:
-- é resposta bem-sucedida, truncada, sem aviso nenhum. Somar em TypeScript o que
-- ele devolve produz um número menor que o verdadeiro, com cara de certo.
--
-- Não é hipótese. Na migração de dados desta mesma base, a primeira medição do
-- saldo devolveu R$ 141.436,00 — as primeiras mil linhas — quando o valor era
-- R$ 641.103,60. Um relatório de faturamento que erre assim é pior que um
-- relatório que não existe, porque alguém decide com ele.
--
-- Agregar no banco não tem essa borda: `sum()` percorre tudo e devolve uma linha.
--
-- ═══ INVOKER, E NÃO DEFINER ═══
--
-- A função NÃO é `security definer`. As quatro tabelas que ela lê têm RLS, e
-- como invoker a política de cada uma continua valendo — quem chamar por outra
-- organização recebe zero, não erro e não dado alheio. Uma `definer` aqui teria
-- de reimplementar o isolamento no corpo, e essa é a segunda cópia da regra que
-- mais cedo ou mais tarde diverge da primeira.
--
-- O filtro por `organization_id` continua explícito em toda subconsulta, porque
-- a doutrina pede e porque ele é o que torna o plano de execução previsível.
--
-- ═══ O QUE ENTRA NA SOMA ═══
--
-- Só lançamento `paid`. Uma conta a pagar que vence semana que vem não é
-- dinheiro que saiu, e misturá-la ao realizado faz o saldo do mês responder por
-- coisas que não aconteceram.
--
-- O estorno entra naturalmente: ele é um lançamento de direção contrária, então
-- a mesma soma já o desconta. É o que faz "nada é apagado" e "o total está
-- certo" serem a mesma frase.

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
    select status, total_cents, reversed_at, payment_method_id
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
    -- A comissão do período é a das comandas finalizadas nele, e `reversed` fica
    -- de fora: ela existiu, continua registrada, e não é mais devida.
    select co.attendant_user_id,
           count(*)              as itens,
           sum(co.amount_cents)  as comissao_cents
      from public.commissions co
      join public.sale_items si
        on si.id = co.sale_item_id and si.organization_id = p_org
      join public.sales s
        on s.id = si.sale_id and s.organization_id = p_org
     where co.organization_id = p_org
       and co.status <> 'reversed'
       and s.finalized_at is not null
       and s.finalized_at::date between p_de and p_ate
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
    -- Ticket médio sobre comanda finalizada. `nullif` porque um mês sem venda
    -- dividiria por zero, e o erro chegaria à tela como falha do relatório.
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
    ), '[]'::jsonb)
  );
$$;

-- Nasce exposta pelas DUAS origens: o `ALTER DEFAULT PRIVILEGES` do baseline
-- concede a `anon` toda função criada depois dele, e o Postgres concede a PUBLIC
-- ao criar. Revogar uma não remove a outra.
revoke execute on function public.fn_relatorio_financeiro(uuid, date, date) from public, anon;
grant  execute on function public.fn_relatorio_financeiro(uuid, date, date) to authenticated, service_role;

comment on function public.fn_relatorio_financeiro(uuid, date, date) is
  'Agregados do faturamento num período. Agrega no banco de propósito: o PostgREST corta em 1000 linhas sem avisar, e somar na aplicação devolve um número menor com cara de certo. Invoker: a RLS de cada tabela continua valendo.';
