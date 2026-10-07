-- 0521: os dois avisos reais do Security Advisor do Supabase
--
-- Lido numa instalação v1.69 em 2026-10-02. Os demais avisos são desenho
-- (definer chamável por authenticated que confere a organização; extensões em
-- public; tabelas só do servidor sem política). Estes dois não são:
--
-- (1) `function_search_path_mutable` — 7 funções de public sem `search_path`
--     fixo. Medido no baseline aplicado num Postgres 17 descartável: são
--     exatamente as 7 abaixo. Nenhuma lê tabela sem schema (6 só usam
--     built-ins; `fn_resolve_inbound_number` já qualifica `public.phone_numbers`),
--     então `search_path = ''` não muda comportamento. A que importa é a
--     `fn_resolve_inbound_number`: é SECURITY DEFINER, e definer sem
--     search_path fixo é a classe de bug que o aviso existe para pegar.
--
-- (2) `authenticated_security_definer_function_executable` em duas funções que
--     o código quer só no servidor:
--     - `fn_resolve_inbound_number(text)` — a 0347 revogou de public/anon e
--       concedeu a service_role, mas o grant a authenticated vem do DEFAULT
--       PRIVILEGES (baseline) e ficou. O único call site é o worker de voz
--       (`workers/voice-agent/index.ts`, admin client). Um usuário logado podia
--       descobrir org e agente de qualquer número de qualquer tenant.
--     - `rls_auto_enable()` — removida do baseline em 2026-08-27, mas o
--       Supabase passou a criá-la em projeto novo, com EXECUTE para
--       authenticated. Só existe em alguns bancos: o bloco confere antes.
--
-- Idempotente: `alter function ... set` e `revoke` de privilégio ausente são no-op.

alter function public.fn_agent_versions_immutable() set search_path = '';
alter function public.fn_ai_agent_version_content_immutable() set search_path = '';
alter function public.fn_contato_anonimizado_limpa_campos_personalizados() set search_path = '';
alter function public.fn_degraus_de_lembrete_validos(integer[]) set search_path = '';
alter function public.fn_corpos_de_lembrete_validos(jsonb) set search_path = '';
alter function public.fn_lancamento_pago_e_imutavel() set search_path = '';
alter function public.fn_resolve_inbound_number(text) set search_path = '';

revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end
$$;
