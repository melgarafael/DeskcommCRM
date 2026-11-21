-- manifest: O valor do negócio segue as vendas registradas — com ao menos uma venda, `crm_leads.value_cents` passa a ser a SOMA das vendas na moeda do negócio, gravada por gatilho a cada venda registrada, alterada ou apagada; apagar a última venda deixa o negócio sem valor. Negócio sem venda registrada fica como era (valor digitado). Antes o card mostrava um valor e o painel outro, e havia dois lugares para dizer "quanto vendeu". Idempotente.

create or replace function public.fn_valor_do_negocio_pelas_vendas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead  uuid;
  v_moeda text;
  v_qtd   integer;
  v_total bigint;
begin
  -- Os negócios afetados: o de antes (UPDATE/DELETE) e o de agora (INSERT/UPDATE).
  for v_lead in
    select distinct x
      from unnest(array[
        case when tg_op <> 'INSERT' then old.lead_id end,
        case when tg_op <> 'DELETE' then new.lead_id end
      ]) as x
     where x is not null
  loop
    select upper(coalesce(l.currency, o.currency, 'BRL'))
      into v_moeda
      from public.crm_leads l
      join public.organizations o on o.id = l.organization_id
     where l.id = v_lead;
    if not found then
      continue;
    end if;

    -- Só a moeda do negócio entra na soma: somar real com dólar seria inventar número.
    select count(*), coalesce(sum(v.valor_cents) filter (where v.moeda = v_moeda), 0)
      into v_qtd, v_total
      from public.vendas_registradas v
     where v.lead_id = v_lead;

    update public.crm_leads
       set value_cents = case when v_qtd > 0 then v_total else null end
     where id = v_lead
       and value_cents is distinct from (case when v_qtd > 0 then v_total else null end);
  end loop;
  return null;
end;
$$;

revoke execute on function public.fn_valor_do_negocio_pelas_vendas() from public, anon, authenticated;

drop trigger if exists trg_valor_do_negocio_pelas_vendas on public.vendas_registradas;
create trigger trg_valor_do_negocio_pelas_vendas
  after insert or update of lead_id, valor_cents, moeda or delete
  on public.vendas_registradas
  for each row execute function public.fn_valor_do_negocio_pelas_vendas();

-- Auto-cura: negócios que já têm venda registrada passam a mostrar a soma.
update public.crm_leads l
   set value_cents = s.total
  from (
    select v.lead_id,
           coalesce(sum(v.valor_cents) filter (
             where v.moeda = upper(coalesce(l2.currency, o.currency, 'BRL'))
           ), 0) as total
      from public.vendas_registradas v
      join public.crm_leads l2 on l2.id = v.lead_id
      join public.organizations o on o.id = l2.organization_id
     group by v.lead_id
  ) s
 where l.id = s.lead_id
   and l.value_cents is distinct from s.total;
