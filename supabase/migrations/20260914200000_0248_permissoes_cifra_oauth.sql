-- Restore self-host pode deixar as RPCs com dono postgres e o helper privado
-- com dono supabase_admin. SECURITY DEFINER troca a identidade: o dono da RPC
-- precisa executar o helper, mesmo quando o chamador é service_role.
-- A chave continua inacessível diretamente aos papéis da API.
revoke all on function private.fn_oauth_key() from public, anon, authenticated, service_role;
do $migration$
declare v_owner text;
begin
 for v_owner in
  select distinct pg_get_userbyid(p.proowner) from pg_proc p
  where p.oid in ('public.fn_encrypt_oauth(text)'::regprocedure,'public.fn_decrypt_oauth(bytea)'::regprocedure)
 loop
  if v_owner in ('anon','authenticated','service_role') then
   raise exception 'oauth_cipher_owner_must_be_database_operator';
  end if;
  execute format('grant usage on schema private to %I',v_owner);
  execute format('grant execute on function private.fn_oauth_key() to %I',v_owner);
 end loop;
end;
$migration$;
