-- As travas do modo somente leitura do suporte cobrem TODA tabela da organização,
-- e a instalação nova chega ao mesmo conjunto de travas que a atualização.
--
-- A 0220 plantou as três políticas restritivas `support_write_{insert,update,delete}`
-- (as que fazem `fn_support_write_allowed` valer na escrita) com uma enumeração do
-- catálogo num bloco `do` avulso. Uma enumeração só alcança as tabelas que existem
-- no instante em que ela roda. Esta migration a transforma na função
-- `public.fn_aplicar_travas_de_suporte()`, sem parâmetro, e a chama DEPOIS de toda
-- tabela: a do schema aplicado por migrations e, no `baseline.sql`, no fim do
-- arquivo.
--
-- ─── a regra de seleção (a MESMA da 0220, sem mudança) ────────────────────────
--
-- Tabela comum (`relkind = 'r'`) de `public`, com RLS ligada, que tenha a coluna
-- `organization_id` — ou a própria `organizations`, cuja organização é a `id`.
--   - `authenticated` tem INSERT, UPDATE ou DELETE nela → as três restritivas;
--   - não tem nenhum dos três (tabela só do servidor) → nenhuma `support_write_*`,
--     que é o contrato mais restritivo e o que a 0220 já fazia.
--
-- Idempotente: `drop policy if exists` antes de cada `create policy`; reaplicar
-- converge para o mesmo catálogo.
--
-- ─── quem pode chamar ─────────────────────────────────────────────────────────
--
-- Só quem aplica o schema, que é o dono das tabelas: criar política exige ser dono.
-- Nenhum papel de cliente precisa dela, e ela NÃO é `security definer` — executada
-- por outro papel, falharia no primeiro `drop policy`. Mesmo assim o EXECUTE sai
-- das duas origens (CLAUDE.md, migrations item 9): o grant a PUBLIC da criação e
-- o grant direto do `alter default privileges` do Supabase, que também alcança
-- `authenticated` e `service_role`.

create or replace function public.fn_aplicar_travas_de_suporte()
returns void
language plpgsql
set search_path = public
as $f$
declare r record; v_col text;
begin
 for r in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and c.relrowsecurity
 and (exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped) or c.relname='organizations')
 loop
 v_col:=case when r.relname='organizations' then 'id' else 'organization_id' end;
 if not (has_table_privilege('authenticated',r.oid,'insert') or has_table_privilege('authenticated',r.oid,'update') or has_table_privilege('authenticated',r.oid,'delete')) then
   execute format('drop policy if exists support_write_insert on public.%I',r.relname);
   execute format('drop policy if exists support_write_update on public.%I',r.relname);
   execute format('drop policy if exists support_write_delete on public.%I',r.relname);
   continue; -- tabela server-only mantém ZERO policies, contrato mais restritivo
 end if;
 execute format('drop policy if exists support_write_insert on public.%I',r.relname);
 execute format('create policy support_write_insert on public.%I as restrictive for insert to authenticated with check (public.fn_support_write_allowed(%I))',r.relname,v_col);
 execute format('drop policy if exists support_write_update on public.%I',r.relname);
 execute format('create policy support_write_update on public.%I as restrictive for update to authenticated using (public.fn_support_write_allowed(%I)) with check (public.fn_support_write_allowed(%I))',r.relname,v_col,v_col);
 execute format('drop policy if exists support_write_delete on public.%I',r.relname);
 execute format('create policy support_write_delete on public.%I as restrictive for delete to authenticated using (public.fn_support_write_allowed(%I))',r.relname,v_col);
 end loop;
end $f$;

revoke execute on function public.fn_aplicar_travas_de_suporte() from public, anon, authenticated, service_role;

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
