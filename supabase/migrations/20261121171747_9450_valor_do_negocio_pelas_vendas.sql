-- manifest: O valor do negócio segue as vendas registradas — com ao menos uma venda, `crm_leads.value_cents` passa a ser a SOMA das vendas na moeda do negócio, gravada por gatilho a cada venda registrada, alterada ou apagada. O valor que estava DIGITADO fica guardado (`valor_digitado_cents`) e volta quando a última venda é apagada (decisão 2B do doc 396); `valor_pelas_vendas` diz se o Valor está sendo derivado. O gatilho trava a linha do negócio antes de somar, para duas vendas simultâneas não perderem uma da soma. Antes o card mostrava um valor e o painel outro, e havia dois lugares para dizer "quanto vendeu". Idempotente.

alter table public.crm_leads
  add column if not exists valor_pelas_vendas boolean not null default false,
  add column if not exists valor_digitado_cents bigint;

comment on column public.crm_leads.valor_pelas_vendas is
  'true = o Valor (value_cents) é a soma das vendas registradas, gravada pelo gatilho fn_valor_do_negocio_pelas_vendas; o campo fica em leitura.';
comment on column public.crm_leads.valor_digitado_cents is
  'O Valor digitado antes da primeira venda registrada. Volta para value_cents quando a última venda é apagada.';

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
  -- Os negócios afetados: o de antes (UPDATE/DELETE) e o de agora (INSERT/UPDATE),
  -- em ordem de id: venda que troca de negócio trava os dois sempre na mesma ordem.
  for v_lead in
    select distinct x
      from unnest(array[
        case when tg_op <> 'INSERT' then old.lead_id end,
        case when tg_op <> 'DELETE' then new.lead_id end
      ]) as x
     where x is not null
     order by x
  loop
    -- A trava vem ANTES da soma: em READ COMMITTED, duas vendas simultâneas no
    -- mesmo negócio somariam cada uma no seu retrato, e a segunda gravaria um
    -- total sem a primeira. Com a linha travada, a soma de quem espera já
    -- enxerga a venda que acabou de entrar.
    select upper(coalesce(l.currency, o.currency, 'BRL'))
      into v_moeda
      from public.crm_leads l
      join public.organizations o on o.id = l.organization_id
     where l.id = v_lead
       for update of l;
    if not found then
      continue;
    end if;

    -- Só a moeda do negócio entra na soma: somar real com dólar seria inventar número.
    select count(*), coalesce(sum(v.valor_cents) filter (where v.currency = v_moeda), 0)
      into v_qtd, v_total
      from public.vendas_registradas v
     where v.lead_id = v_lead;

    if v_qtd > 0 then
      -- Primeira venda: guarda o valor digitado antes de trocá-lo pela soma.
      update public.crm_leads
         set valor_digitado_cents = case when valor_pelas_vendas then valor_digitado_cents else value_cents end,
             valor_pelas_vendas = true,
             value_cents = v_total
       where id = v_lead
         and (not valor_pelas_vendas or value_cents is distinct from v_total);
    else
      -- A última venda saiu: o valor digitado volta (decisão 2B do doc 396).
      update public.crm_leads
         set value_cents = valor_digitado_cents,
             valor_pelas_vendas = false,
             valor_digitado_cents = null
       where id = v_lead
         and valor_pelas_vendas;
    end if;
  end loop;
  return null;
end;
$$;

revoke execute on function public.fn_valor_do_negocio_pelas_vendas() from public, anon, authenticated;

drop trigger if exists trg_valor_do_negocio_pelas_vendas on public.vendas_registradas;
create trigger trg_valor_do_negocio_pelas_vendas
  after insert or update of lead_id, valor_cents, currency or delete
  on public.vendas_registradas
  for each row execute function public.fn_valor_do_negocio_pelas_vendas();

-- Auto-cura: negócios que já têm venda registrada passam a mostrar a soma, e o
-- valor digitado fica guardado (só na primeira vez: re-aplicar não o sobrescreve).
update public.crm_leads l
   set valor_digitado_cents = case when l.valor_pelas_vendas then l.valor_digitado_cents else l.value_cents end,
       valor_pelas_vendas = true,
       value_cents = s.total
  from (
    select v.lead_id,
           coalesce(sum(v.valor_cents) filter (
             where v.currency = upper(coalesce(l2.currency, o.currency, 'BRL'))
           ), 0) as total
      from public.vendas_registradas v
      join public.crm_leads l2 on l2.id = v.lead_id
      join public.organizations o on o.id = l2.organization_id
     group by v.lead_id
  ) s
 where l.id = s.lead_id
   and (not l.valor_pelas_vendas or l.value_cents is distinct from s.total);
