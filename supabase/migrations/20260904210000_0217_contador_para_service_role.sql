-- ============================================================================
-- 0217 — SIDECAR INTERNO TAMBÉM NUMERA (service_role no contador)
--
-- A `fn_proximo_numero_pedido` (0209) confere membership via `auth.uid()`.
-- Chamada com service_role (tool de IA, worker), `auth.uid()` é NULL e a
-- função recusava — mesmo a org sendo a do contexto confiável.
--
-- Service role BYPASSA toda RLS por desenho: exigir membership dele seria
-- mais restritivo que o resto do banco, sem ganhar nada (quem tem a service
-- key já lê/escreve tudo). O firewall continua valendo para `authenticated`:
-- usuário forjando outra org morre no 42501 como antes.
-- ============================================================================

create or replace function public.fn_proximo_numero_pedido(p_org uuid)
returns integer
  language plpgsql security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_numero integer;
begin
  if (auth.jwt() ->> 'role') <> 'service_role'
     and not exists (select 1 from public.fn_user_org_ids() where fn_user_org_ids = p_org)
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

-- Mesma razão para a irmã das cargas.
create or replace function public.fn_proximo_numero_carga(p_org uuid)
returns integer
  language plpgsql security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_numero integer;
begin
  if (auth.jwt() ->> 'role') <> 'service_role'
     and not exists (select 1 from public.fn_user_org_ids() where fn_user_org_ids = p_org)
     and not public.fn_is_platform_admin() then
    raise exception 'carga_numero_org_invalida' using errcode = '42501';
  end if;

  insert into public.commercial_shipment_counters (organization_id, ultimo_numero, updated_at)
  values (p_org, 1, now())
  on conflict (organization_id)
  do update set ultimo_numero = public.commercial_shipment_counters.ultimo_numero + 1,
                updated_at = now()
  returning ultimo_numero into v_numero;

  return v_numero;
end;
$$;

alter function public.fn_proximo_numero_carga(uuid) owner to postgres;

revoke execute on function public.fn_proximo_numero_carga(uuid) from public, anon;
grant execute on function public.fn_proximo_numero_carga(uuid) to authenticated;
grant execute on function public.fn_proximo_numero_carga(uuid) to service_role;
