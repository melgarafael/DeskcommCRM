-- ============================================================================
-- 0263 — A PODA DE NONCES FALA A LÍNGUA DO CRON
--
-- `fn_expurgar_nonces_de_oauth` nasceu na 0190 com `(p_dias, p_lote)`. As três
-- irmãs de retenção (`fn_podar_fila_de_jobs`, `fn_expurgar_auditoria_vencida`,
-- `fn_expurgar_espelho_da_agenda`) recebem `(p_retencao_dias, p_limite)`. O
-- cron `data-retention` tem UM laço (`drenar`) que chama as quatro com esses
-- nomes. No PostgREST, argumento nomeado que não existe vira 400 — então a
-- quarta poda nunca rodava, e `calendar_oauth_nonces` crescia para sempre.
--
-- CREATE OR REPLACE não troca nome de argumento. DROP + CREATE, mesmos tipos
-- (int, int), mesmos grants da 0192. Corpo idêntico: piso de 1 dia, lote.
-- ============================================================================

drop function if exists public.fn_expurgar_nonces_de_oauth(int, int);

create function public.fn_expurgar_nonces_de_oauth(
  p_retencao_dias int,
  p_limite int default 500
)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_removidas int;
  v_dias int := greatest(coalesce(p_retencao_dias, 1), 1);
  v_limite int := greatest(coalesce(p_limite, 500), 1);
begin
  with alvo as (
    select nonce
      from public.calendar_oauth_nonces
     where expira_em < now() - make_interval(days => v_dias)
     limit v_limite
  )
  delete from public.calendar_oauth_nonces n
   using alvo
   where n.nonce = alvo.nonce;

  get diagnostics v_removidas = row_count;
  return v_removidas;
end$$;

revoke execute on function public.fn_expurgar_nonces_de_oauth(int, int)
  from public, anon, authenticated;
grant execute on function public.fn_expurgar_nonces_de_oauth(int, int) to service_role;
