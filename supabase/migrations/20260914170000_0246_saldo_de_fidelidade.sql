-- O saldo de fidelidade, somado no banco.
--
-- `loyalty_ledger` é um livro-razão: o saldo de um cliente é `sum(points)`, e
-- NUNCA uma coluna guardada — é o invariante 2 do módulo, e o teste de schema o
-- vigia. O que faltava era alguém poder fazer essa soma.
--
-- ═══ POR QUE UMA FUNÇÃO, DE NOVO ═══
--
-- Pela mesma razão da 0244: o PostgREST corta em 1000 linhas sem avisar. Um
-- cliente antigo com muitos movimentos teria o saldo truncado, e o truncamento
-- aqui é pior que no relatório — ele vira prêmio negado a quem tinha direito, no
-- balcão, com a pessoa na frente.
--
-- ⚠️ O SALDO É POR CLIENTE, NUNCA AGREGADO. A validação da migração desta base
-- registrou exatamente isso: o total geral esconde erros que se compensam, e foi
-- por cliente que a conferência de fidelidade teve de ser feita. A função aceita
-- um contato e devolve o dele.
--
-- Invoker, como a 0244: a RLS de `loyalty_ledger` continua decidindo o que cada
-- pessoa enxerga, em vez de o isolamento ser reescrito no corpo.

create or replace function public.fn_saldo_de_fidelidade(p_org uuid, p_contact uuid)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(sum(points), 0)::integer
    from public.loyalty_ledger
   where organization_id = p_org
     and contact_id = p_contact;
$$;

revoke execute on function public.fn_saldo_de_fidelidade(uuid, uuid) from public, anon;
grant  execute on function public.fn_saldo_de_fidelidade(uuid, uuid) to authenticated, service_role;

comment on function public.fn_saldo_de_fidelidade(uuid, uuid) is
  'Saldo de pontos de um contato: sum(points) do livro-razão. Soma no banco porque o PostgREST corta em 1000 linhas sem avisar, e saldo truncado vira prêmio negado a quem tinha direito.';
