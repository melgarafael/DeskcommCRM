-- 0423 — Corrige uma função de gatilho deixada por instalações legadas.
--
-- A função não faz parte do baseline atual, mas existe em bancos que vieram
-- do CRM anterior. Sem search_path fixo, objetos criados no schema da sessão
-- podem alterar a resolução de nomes da função. A guarda por to_regprocedure
-- mantém a migration segura tanto nesses bancos quanto num install fresco.
do $$
begin
  if to_regprocedure('public.fn_espelha_nome_e_name()') is not null then
    alter function public.fn_espelha_nome_e_name()
      set search_path = public, pg_temp;
  end if;
end $$;
