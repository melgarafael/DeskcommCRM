-- ============================================================================
-- 0209 — O PRÓXIMO NÚMERO DO PEDIDO (contador atômico)
--
-- `MAX(numero)+1` na rota tem janela de corrida: dois vendedores finalizando
-- juntos leem o mesmo MAX, um deles toma 409 fantasma. A tabela
-- `commercial_order_counters` (0208) existe para isto, e esta função é o único
-- escritor dela: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` é atômico
-- no Postgres, então dois avanços concorrentes saem com números diferentes.
--
-- SECURITY DEFINER de propósito: o contador não pertence a nenhum papel, e a
-- rota chama com o JWT do usuário. A função NÃO confia no parâmetro sozinho —
-- a primeira coisa que ela faz é conferir que quem chama é membro da org
-- (`fn_user_org_ids`), senão levanta exceção. Parâmetro forjado de outra org
-- morre aqui, não na RLS.
--
-- Grants (item 6 da doutrina de Migrations): revoke das DUAS origens de
-- EXECUTE (`public` e `anon`) e grant só para `authenticated`. Sem o revoke, a
-- função fica chamável pela anon key como RPC.
-- ============================================================================

create or replace function public.fn_proximo_numero_pedido(p_org uuid)
returns integer
  language plpgsql security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_numero integer;
begin
  if not exists (select 1 from public.fn_user_org_ids() where fn_user_org_ids = p_org)
     and not public.fn_is_platform_admin() then
    raise exception 'pedido_numero_org_invalida' using errcode = '42501';
  end if;

  insert into public.commercial_order_counters (organization_id, ultimo_numero, updated_at)
  values (p_org, 1, now())
  on conflict (organization_id)
  do update set ultimo_numero = public.commercial_order_counters.ultimo_numero + 1,
                updated_at = now()
  returning ultimo_numero into v_numero;

  return v_numero;
end;
$$;

alter function public.fn_proximo_numero_pedido(uuid) owner to postgres;

revoke execute on function public.fn_proximo_numero_pedido(uuid) from public, anon;
grant execute on function public.fn_proximo_numero_pedido(uuid) to authenticated;
grant execute on function public.fn_proximo_numero_pedido(uuid) to service_role;

comment on function public.fn_proximo_numero_pedido(uuid) is
  'Avança atomicamente o contador de pedidos da org e devolve o próximo número (PED-0001 na tela). Único escritor de commercial_order_counters; confere membership antes de avançar.';
