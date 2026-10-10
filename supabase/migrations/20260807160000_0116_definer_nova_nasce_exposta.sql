-- 0116: função NOVA nasce exposta a anon em quem ATUALIZA (a 0108 fechou só o estoque)
--
-- A 0108 (issue #128) revogou EXECUTE de anon numa LISTA de 8 funções. A lista
-- estava certa para o banco em que foi medida — um Postgres descartável com o
-- baseline da main aplicado do zero. O que ela não cobre é o caminho de quem
-- JÁ tinha o produto instalado, que é o self-hoster real.
--
-- ── O mecanismo, medido (não deduzido) ─────────────────────────────────────
--
-- O baseline tem, por paridade com o Supabase:
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT ALL ON FUNCTIONS TO anon;        (e a irmã, TO authenticated)
--
-- Isso NÃO é uma linha de script cujo efeito acaba quando ela passa: grava uma
-- entrada em `pg_default_acl`, que fica no catálogo do banco PARA SEMPRE. Numa
-- instalação nova não incomoda, porque o dump cria as funções ANTES dessa linha.
-- Depois que ela roda uma vez, toda função criada em `public` a partir dali
-- nasce com EXECUTE para anon — inclusive as de toda migration futura.
--
-- Prova (Postgres 17 descartável, baseline instalado, depois:)
--
--     create function public.fn_prova_de_conceito() returns int
--       language sql security definer as $$ select 1 $$;
--
--     -> has_function_privilege('anon', ..., 'EXECUTE') = TRUE
--     -> acl = {=X/postgres,postgres=X/postgres,anon=X/postgres,...}
--
-- ── O estoque encontrado numa VPS real (2026-08-07) ────────────────────────
--
-- Instalação em produção que veio acompanhando a main desde julho, comparada
-- linha a linha com o que um `install` fresco produz. Sete divergências, todas
-- na direção PERMISSIVA:
--
--   anon ganhou EXECUTE em 6:  activate_kb_version, fn_decrypt_oauth,
--     fn_encrypt_oauth, fn_lgpd_cascade_redact_contact,
--     fn_update_budget_consumption, retrieve_top_k_chunks
--   authenticated ganhou em 5: fn_audit_log_row, fn_decrypt_oauth,
--     fn_encrypt_oauth, fn_lgpd_cascade_redact_contact,
--     fn_update_budget_consumption
--
-- `fn_decrypt_oauth` executável pela anon key — que vai para o browser — é o
-- mesmo desenho que a 0108 chamou de letal, reaberto pelo caminho de update.
--
-- ── Por que uma VARREDURA e não uma segunda lista ──────────────────────────
--
-- Uma lista conserta o estoque de hoje e reabre no próximo `create function`.
-- O bloco abaixo é auto-curativo: varre TODA `security definer` de public e tira
-- anon, preservando quem de fato tinha acesso. Funciona para função que ainda
-- não existe, que é o ponto.
--
-- ── Por que não desfazer o ALTER DEFAULT PRIVILEGES ────────────────────────
--
-- Seria tratar a origem, e foi a primeira coisa que tentei. Não serve: aquela
-- linha vem do `pg_dump` do Supabase, no CORPO do baseline, e é reescrita a cada
-- re-aplicação. Um revoke do default seria desfeito pelo próximo `update.sh` e o
-- buraco voltaria. A varredura roda no FIM do apêndice, depois de tudo que cria
-- função — então cura no mesmo run em que o defeito nasce.
--
-- Idempotente: revoke de privilégio ausente é no-op; o bloco pode rodar sempre.

-- ---- regra 1 (anon): varredura auto-curativa, sem exceção ----
-- Duas origens de EXECUTE, e é onde a 0108 documenta que se erra:
--   (A) grant DIRETO a anon, do ALTER DEFAULT PRIVILEGES — `revoke from public`
--       NÃO o remove;
--   (B) grant a PUBLIC que o Postgres dá a toda função ao criá-la, do qual anon
--       HERDA — `revoke from anon` NÃO o remove.
-- Por isso o revoke nomeia os dois. E como (B) também era o que dava acesso a
-- `authenticated`/`service_role` em algumas funções, o privilégio EFETIVO de cada
-- um é medido ANTES e devolvido explicitamente depois: a varredura tira anon sem
-- tirar leitura de ninguém.
do $$
declare
  f record;
  tinha_auth boolean;
  tinha_service boolean;
begin
  -- Clone sem os roles do Supabase (Postgres cru): nada a fazer, e perguntar
  -- por um role inexistente é erro, não no-op.
  if to_regrole('anon') is null then
    return;
  end if;

  for f in
    select p.oid, p.oid::regprocedure as assinatura
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
  loop
    tinha_auth := to_regrole('authenticated') is not null
                  and has_function_privilege('authenticated', f.oid, 'EXECUTE');
    tinha_service := to_regrole('service_role') is not null
                     and has_function_privilege('service_role', f.oid, 'EXECUTE');

    execute format('revoke execute on function %s from public, anon', f.assinatura);

    if tinha_auth then
      execute format('grant execute on function %s to authenticated', f.assinatura);
    end if;
    if tinha_service then
      execute format('grant execute on function %s to service_role', f.assinatura);
    end if;
  end loop;
end $$;

-- ---- regra 2 (authenticated): as 5 que o update abriu e o install não abre ----
-- Aqui NÃO cabe varredura: `authenticated` PRECISA de EXECUTE nos helpers de RLS
-- (as policies são avaliadas com o papel de quem consulta) e em `retrieve_top_k_chunks`
-- — num install fresco ele tem, e tirar quebraria a busca logada. É julgamento por
-- função, como na 0108. O alvo de cada linha abaixo é o valor que um `install`
-- fresco produz, medido, não escolhido.
revoke execute on function public.fn_audit_log_row() from authenticated;
revoke execute on function public.fn_decrypt_oauth(bytea) from authenticated;
revoke execute on function public.fn_encrypt_oauth(text) from authenticated;
revoke execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) from authenticated;
revoke execute on function public.fn_update_budget_consumption() from authenticated;

-- Quem de fato chama estas 5 é o client de service role (worker/rotas de servidor)
-- e, no caso de `fn_audit_log_row`, o TRIGGER — que não consulta EXECUTE para
-- disparar. O grant explícito abaixo é o probe positivo: se um dia o revoke acima
-- passar longe demais, isto documenta quem tinha de continuar podendo.
grant execute on function public.fn_audit_log_row() to service_role;
grant execute on function public.fn_decrypt_oauth(bytea) to service_role;
grant execute on function public.fn_encrypt_oauth(text) to service_role;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_update_budget_consumption() to service_role;

notify pgrst, 'reload schema';
