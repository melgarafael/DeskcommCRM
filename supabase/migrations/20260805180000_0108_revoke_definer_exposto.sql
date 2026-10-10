-- 0108: SECURITY DEFINER exposta a anon (e a authenticated onde não precisava)
--
-- Issue #128. Medido em Postgres 17 descartável com o baseline da main
-- aplicado: das 25 funções `security definer` do schema public, **8** tinham
-- EXECUTE para anon. Entre elas `fn_publish_ai_agent_version`, que ESCREVE
-- (publica versão de agente) e recebe o `p_org_id` por argumento sem checar
-- membership — ou seja, estava exposta como RPC do PostgREST à anon key, que
-- vai para o browser.
--
-- SÃO DUAS ORIGENS de EXECUTE, e é aí que se erra (eu errei na primeira
-- tentativa, e só o `proacl` mostrou):
--
--   (A) grant DIRETO a anon, do `ALTER DEFAULT PRIVILEGES FOR ROLE postgres
--       IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon` (baseline ~3960).
--       Vale para toda função criada DEPOIS dele — isto é, para todo apêndice
--       novo, que por construção nasce no fim do arquivo. `revoke ... from
--       public` NÃO o remove.
--   (B) grant a PUBLIC, que o Postgres dá a QUALQUER função ao criá-la.
--       `revoke ... from anon` NÃO o remove — e no ACL ele aparece como a
--       entrada de grantee vazio: `{=X/postgres,...}`.
--
-- As 8 estavam expostas por (B). Um remédio que trate só uma das origens deixa
-- a função exposta e o gate verde, que é como isto sobreviveu até aqui. Por
-- isso todo revoke abaixo nomeia `public, anon` — e o re-grant explícito
-- devolve EXECUTE a quem de fato precisa.
--
-- Duas regras, porque os dois papéis correm riscos diferentes:
--   anon          → nenhuma definer de public deve ser executável. Sem exceção.
--   authenticated → definer VOLÁTIL (pode escrever) só continua executável se
--                   houver call site com a sessão do usuário. As 5 abaixo só
--                   são chamadas pelo client de service role (verificado em
--                   app/, lib/ e workers/), então o grant era superfície morta
--                   com risco de escrita cross-tenant: um usuário logado no
--                   tenant A podia chamá-las com o org_id do tenant B.
--
-- Ficam com authenticated, com razão: `emit_event` e `fn_conversation_assign`
-- (chamadas com a sessão do usuário em Server Action / rota) e `fn_log_event`
-- (chamada de dentro de triggers, grant declarado pela 0034).
--
-- Idempotente e auto-curativo: `revoke` de privilégio ausente é no-op.

-- ---- anon: nenhuma SECURITY DEFINER de public ----
-- Duas origens de EXECUTE, e cada uma pede um revoke diferente — medir o ACL
-- real (`proacl`) foi o que mostrou isso: `{=X/postgres,...}` é grant a PUBLIC,
-- que `revoke ... from anon` NÃO remove. As duas linhas juntas cobrem os dois
-- caminhos, e o re-grant explícito devolve quem de fato precisa.
revoke execute on function public.fn_is_platform_admin() from public, anon;
revoke execute on function public.fn_user_org_ids() from public, anon;
revoke execute on function public.fn_user_role_in_org(uuid) from public, anon;
revoke execute on function public.fn_user_role_in(uuid) from public, anon;
revoke execute on function public.fn_role_at_least(uuid, text) from public, anon;
revoke execute on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) from public, anon;
revoke execute on function public.fn_emit_conversation_routing() from public, anon;
revoke execute on function public.rls_auto_enable() from public, anon;

-- ---- authenticated: definer volátil sem call site de sessão de usuário ----
revoke execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from authenticated;
revoke execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from authenticated;
revoke execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from authenticated;
revoke execute on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) from authenticated;
revoke execute on function public.activate_kb_version(uuid, uuid) from authenticated;
-- Funções de TRIGGER: ninguém as chama por RPC, e o disparo do trigger não
-- consulta EXECUTE. O grant só existia por herança dos padrões do Postgres.
revoke execute on function public.fn_emit_conversation_routing() from authenticated;
revoke execute on function public.rls_auto_enable() from authenticated;

-- ---- re-grant explícito: quem precisa continua podendo (probe positivo) ----
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to service_role;
grant execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) to service_role;
grant execute on function public.fn_publish_ai_agent_version(uuid, uuid, uuid) to service_role;
grant execute on function public.activate_kb_version(uuid, uuid) to service_role;
grant execute on function public.fn_emit_conversation_routing() to service_role;
grant execute on function public.rls_auto_enable() to service_role;
-- Helpers de RLS: as policies são avaliadas com o papel de quem consulta, então
-- `authenticated` PRECISA de EXECUTE — sem isto toda leitura logada quebra.
grant execute on function public.fn_is_platform_admin() to authenticated, service_role;
grant execute on function public.fn_user_org_ids() to authenticated, service_role;
grant execute on function public.fn_user_role_in_org(uuid) to authenticated, service_role;
grant execute on function public.fn_user_role_in(uuid) to authenticated, service_role;
grant execute on function public.fn_role_at_least(uuid, text) to authenticated, service_role;
