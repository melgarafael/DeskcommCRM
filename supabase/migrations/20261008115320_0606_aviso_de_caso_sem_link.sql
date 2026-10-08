-- manifest: aviso interno opcional sem link para operação local, preservando guardas da configuração.
alter table public.config_aviso_de_caso add column if not exists sem_link boolean not null default false;

-- Reutiliza as guardas canônicas no mesmo ato transacional; a função antiga
-- continua compatível com clientes que não conhecem o modo local.
create or replace function public.fn_definir_aviso_de_caso_local(
  p_org uuid, p_channel uuid, p_telefone text, p_rotulo text,
  p_ligado boolean, p_confirma_contato boolean default false,
  p_sem_link boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_resultado jsonb;
begin
  v_resultado := public.fn_definir_aviso_de_caso(
    p_org, p_channel, p_telefone, p_rotulo, p_ligado, p_confirma_contato);
  update public.config_aviso_de_caso
     set sem_link = coalesce(p_sem_link, false)
   where organization_id = p_org;
  return v_resultado;
end;
$$;
revoke execute on function public.fn_definir_aviso_de_caso_local(uuid,uuid,text,text,boolean,boolean,boolean) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso_local(uuid,uuid,text,text,boolean,boolean,boolean) to authenticated;
