-- manifest: `fn_finalizar_comanda` recusa com `agendamento_de_outra_organizacao`
-- (ou `contato_de_outra_organizacao`) quando a comanda da empresa aponta para
-- atendimento ou cliente de OUTRA empresa (#4845). Nada muda na comanda da
-- própria empresa: a finalização, a comissão, o lançamento e a conclusão do
-- agendamento continuam iguais.
--
-- ⚠️ POR QUE ISTO É SCHEMA E NÃO SÓ CÓDIGO. A rota `financeiro/comandas/
-- faturar-lote` passou a ler os agendamentos com `.eq("organization_id", org)`
-- e a recusar o lote inteiro quando algum id é de fora, mas ela NÃO é a única
-- porta para o dinheiro: `financeiro/comandas/[id]/finalizar` chama esta mesma
-- função, e ela é `grant execute ... to authenticated` — pelo PostgREST,
-- qualquer sessão com papel `agent` na empresa alcança o RPC direto. A guarda
-- na rota sozinha deixaria a segunda porta aberta.
--
-- POR QUE A FUNÇÃO E NÃO UM TRIGGER. O defeito é da TRANSIÇÃO que cria
-- dinheiro, e ela acontece inteira aqui (venda, comissões, lançamento, ponto e
-- conclusão do agendamento na mesma transação). Um trigger em `sales` recusaria
-- a mesma linha, mas o caminho de leitura continuaria devolvendo a comanda
-- criada pela rota de balcão antes da finalização, e o recado chegaria longe do
-- ponto onde a decisão foi tomada.
--
-- O QUE NÃO MUDA: assinatura, `security definer`, `search_path`, os grants, o
-- `for update`, a idempotência (`finalized` devolve `ja_finalizada` sem
-- escrever) e as demais recusas nomeadas. O corpo parte da 0619 vigente.

create or replace function public.fn_finalizar_comanda(
  p_org uuid,
  p_sale uuid,
  p_payment_method uuid,
  p_loyalty_points integer default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  -- ⚠️ `record` e NÃO `public.sales%rowtype`, por D7 da ADR-0002: a tabela é do
  -- módulo e não existe onde ele não está instalado, e `%rowtype` é resolvido na
  -- CRIAÇÃO da função (medido em Postgres 15: `relation does not exist`).
  -- `record` não é um afrouxo: os campos são lidos por nome, e a função só roda
  -- onde a comanda existe — o guard logo abaixo recusa o resto.
  v_sale       record;
  v_conta      uuid;
  v_plano      uuid;
  v_total      bigint;
  v_item       record;
  v_entry      uuid;
begin
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'agent') then
    raise exception 'comanda_forbidden' using errcode = '42501';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;

  -- FOR UPDATE: duas finalizações simultâneas da mesma comanda geravam
  -- lançamento em dobro. O lock é o que torna esta função idempotente de fato,
  -- e não só na intenção.
  select * into v_sale from public.sales
   where id = p_sale and organization_id = p_org
   for update;

  if not found then
    raise exception 'comanda_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_sale.status = 'finalized' then
    -- Não é erro: quem chamou duas vezes recebe o mesmo desfecho.
    return jsonb_build_object('sale_id', v_sale.id, 'ja_finalizada', true);
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'comanda_cancelada' using errcode = '22023';
  end if;

  -- ─── #4845 — a comanda não fatura o atendimento de OUTRA empresa ───────────
  --
  -- A função é SECURITY DEFINER e conferia a empresa da COMANDA (`p_sale`), da
  -- forma de pagamento e da conta de destino — nunca a do `appointment_id` nem
  -- a do `contact_id` que a comanda carrega. Como ela grava `commissions` e um
  -- `financial_entries` PAGO na `p_org`, uma comanda da A apontando para um
  -- atendimento da B criava dinheiro na A por um serviço prestado na B.
  --
  -- Pior: o passo que marca o agendamento filtra `organization_id = p_org`,
  -- então o da B continuava `confirmed` e podia ser faturado outra vez lá. O
  -- índice único é por `(organization_id, appointment_id)`, logo nada impedia
  -- a cobrança dupla.
  --
  -- A guarda é do BANCO porque a função não tem um chamador só: `faturar-lote`
  -- e `comandas/[id]/finalizar` a chamam, e ela é EXECUTÁVEL por
  -- `authenticated` — pelo PostgREST, qualquer sessão com papel `agent` numa
  -- empresa alcança o RPC direto. Consertar apenas a rota deixaria a segunda
  -- porta aberta.
  --
  -- Roda ANTES de qualquer escrita (venda, comissões, lançamento, ponto,
  -- agendamento) e o erro não diz nada sobre a outra empresa: nem nome, nem
  -- valor, nem de quem é o id.
  if v_sale.appointment_id is not null and not exists (
    select 1 from public.calendar_appointments
     where id = v_sale.appointment_id and organization_id = p_org
  ) then
    raise exception 'agendamento_de_outra_organizacao' using errcode = '42501';
  end if;

  if v_sale.contact_id is not null and not exists (
    select 1 from public.contacts
     where id = v_sale.contact_id and organization_id = p_org
  ) then
    raise exception 'contato_de_outra_organizacao' using errcode = '42501';
  end if;

  select account_id into v_conta from public.payment_methods
   where id = p_payment_method and organization_id = p_org and is_active;
  if not found then
    raise exception 'forma_de_pagamento_invalida' using errcode = '22023';
  end if;
  if v_conta is null then
    -- A forma existe e não diz para onde o dinheiro vai. Recusar aqui é melhor
    -- que escolher uma conta por conta própria.
    raise exception 'forma_sem_conta'
      using errcode = '22023',
            hint = 'Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações → Financeiro.';
  end if;

  select coalesce(sum(total_cents), 0) into v_total
    from public.sale_items where sale_id = p_sale;
  v_total := greatest(v_total - coalesce(v_sale.discount_cents, 0), 0);

  -- (1) a venda
  update public.sales
     set status = 'finalized',
         finalized_at = now(),
         payment_method_id = p_payment_method,
         total_cents = v_total
   where id = p_sale;

  -- (2) a comissão por item, com o percentual CONGELADO na inclusão
  for v_item in
    select * from public.sale_items where sale_id = p_sale and attendant_user_id is not null
  loop
    insert into public.commissions
      (organization_id, sale_item_id, attendant_user_id, percent, amount_cents)
    values (
      p_org, v_item.id, v_item.attendant_user_id, v_item.commission_percent,
      -- Sobre o item, NUNCA sobre o desconto da comanda: um desconto de caixa
      -- não pode reduzir o que quem atendeu combinou.
      floor(v_item.total_cents * v_item.commission_percent / 100.0)
    )
    on conflict (sale_item_id) do nothing;
  end loop;

  -- (3) a entrada na conta que a FORMA DE PAGAMENTO determina
  select id into v_plano from public.account_plans
   where organization_id = p_org and direction = 'in' and is_active
   order by created_at limit 1;

  insert into public.financial_entries
    (organization_id, account_id, account_plan_id, sale_id, direction, amount_cents,
     currency, description, status, paid_at, origin, created_by_user_id)
  values (
    p_org, v_conta, v_plano, p_sale, 'in', greatest(v_total, 1),
    v_sale.currency, format('Comanda #%s', v_sale.number), 'paid', now(), 'sale', auth.uid()
  )
  returning id into v_entry;

  -- (4) o ponto de fidelidade, idempotente pela chave da comanda
  if p_loyalty_points > 0 and v_sale.contact_id is not null then
    insert into public.loyalty_ledger
      (organization_id, contact_id, points, reason, sale_id, idempotency_key, created_by_user_id)
    values (
      p_org, v_sale.contact_id, p_loyalty_points, 'Comanda finalizada', p_sale,
      format('sale:%s', p_sale), auth.uid()
    )
    on conflict do nothing;
  end if;

  -- (5) o agendamento conclui — e SÓ se ainda estiver de pé.
  if v_sale.appointment_id is not null then
    update public.calendar_appointments
       set status = 'completed', outcome_recorded_at = now()
     where id = v_sale.appointment_id
       and organization_id = p_org
       -- A guarda que o sistema de origem não tinha em todos os caminhos:
       -- cancelado e faltou são desfechos DECIDIDOS, e faturar não os desfaz.
       and status not in ('cancelled', 'no_show');
  end if;

  return jsonb_build_object(
    'sale_id', v_sale.id,
    'number', v_sale.number,
    'total_cents', v_total,
    'entry_id', v_entry
  );
end $$;

revoke execute on function public.fn_finalizar_comanda(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.fn_finalizar_comanda(uuid, uuid, uuid, integer) to authenticated;
