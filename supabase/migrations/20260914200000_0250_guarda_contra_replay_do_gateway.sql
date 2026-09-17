-- ============================================================================
-- 0237 — O GATEWAY DO SUPABASE REEXECUTA 5xx SEM PARAR; UM CONFLITO BENIGNO
--        DERRUBOU O PRODUTO INTEIRO
--
-- ─── O que aconteceu (medido em 2026-09-11 na VPS de produção) ─────────────
--
-- `crm.deskcomm.com.br/app` mostrava "Algo deu errado" para todo mundo. O log
-- do app tinha uma única causa, em todas as rotas e crons:
--
--   PGRST002 "Could not query the database for the schema cache. Retrying."
--
-- O Postgres estava vivo e ocioso (psql pelo pooler respondia em ms). Quem
-- estava morto era o PostgREST: `pg_stat_database` mostrava ~2.300 rollbacks
-- POR SEGUNDO (349 milhões acumulados contra 12 milhões de commits), todos de
-- transações do `authenticator` chamando `fn_followup_patch` e
-- `fn_google_appointment` e abortando com `followup_stale` / errcode 40001.
--
-- Instrumentando a função para expor `request.headers` em `application_name`:
-- eram EXATAMENTE 8 requisições, cada uma com o MESMO `sb-request-id` e o MESMO
-- `cf-ray` em todas as amostras, reexecutadas ~280×/s cada. O `sb-request-id` é
-- UUIDv7 e o instante embutido era 2026-09-09 14:26–14:33 UTC — dois dias antes.
-- A VPS não mandava esses pacotes (tcpdump: 57 pacotes na porta 443 em 14 s,
-- contra 31.839 rollbacks no mesmo intervalo). Quem reexecutava era a camada do
-- Supabase entre o Cloudflare e o PostgREST (cabeçalhos `x-envoy-*`,
-- `cf-worker: supabase.co`), que trata resposta 5xx como falha transitória.
--
-- A cadeia inteira:
--   1. o motor de follow-up chama `fn_followup_patch` com revisão obsoleta →
--      `raise ... errcode='40001'` (um conflito BENIGNO, o cliente sabe tratar);
--   2. o PostgREST mapeia a classe 40 para HTTP **500** (`Error.hs`,
--      `'4':'0':_ -> status500`);
--   3. o gateway reexecuta 5xx sem limite; 8 requisições ocupam o pool inteiro;
--   4. o carregamento do schema cache do PostgREST não consegue conexão e falha;
--      em `AppState.hs`, falha ⇒ `putSchemaCache Nothing` ⇒ TODA requisição
--      responde 503 PGRST002 — inclusive a leitura de `platform_admins` que o
--      layout de `/app` faz, que é a tela do usuário.
--
-- ─── O conserto ─────────────────────────────────────────────────────────────
--
-- Um hook `pgrst.db_pre_request` (o PostgREST o chama ANTES da query de toda
-- requisição, sob o papel da requisição). Ele lê o `sb-request-id` e, se o
-- instante embutido tem mais de 5 minutos, responde `PT409` → HTTP 409. Uma
-- requisição aceita há mais de 5 minutos não tem cliente esperando (o
-- `statement_timeout` do `authenticator` é 8 s); um 4xx não é reexecutado e o
-- loop morre na hora — medido: rollbacks caíram de 24.508 para 1 em 10 s no
-- instante em que a guarda entrou, e o schema cache recarregou em seguida.
--
-- Por que aqui e não no cliente: o cliente que originou as 8 requisições
-- desligou em 9/9; nenhuma mudança de código alcança um replay que vive no
-- gateway. E por que não trocar o 40001 por PT409 nas funções: são 25 funções
-- e 71 pontos de `raise`, com ~20 pontos no cliente que leem `code==="40001"` —
-- é a melhoria certa (conflito benigno não deveria sair como 5xx) e fica
-- registrada como follow-up, mas não é o que apaga o incêndio.
--
-- Instalar o hook NO MEIO da tempestade não funciona sozinho: o `reload config`
-- do PostgREST também precisa de uma conexão do pool. Em produção destravei
-- chamando a guarda por dentro das duas funções reexecutadas por ~60 s e
-- restaurei os corpos originais (diff vazio contra `pg_get_functiondef`). Com o
-- hook já registrado ANTES da próxima tempestade, esse passo não existe mais.
--
-- Diagnóstico e comandos: `docs/runbooks/postgrest-replay-do-gateway.md`.
-- ============================================================================

create or replace function public.fn_pgrst_recusar_replay_do_gateway()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  rid text;
  aceito_ha interval;
begin
  rid := coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'sb-request-id', '');
  -- Só UUIDv7 (versão 7 no 3º grupo) carrega instante; qualquer outro formato passa.
  if rid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-' then
    return;
  end if;
  aceito_ha := now() - to_timestamp((('x' || replace(left(rid, 13), '-', ''))::bit(48)::bigint) / 1000.0);
  if aceito_ha > interval '5 minutes' then
    raise exception 'gateway_replay'
      using errcode = 'PT409',
            detail  = format('sb-request-id %s foi aceito pelo gateway há %s', rid, aceito_ha),
            hint    = 'A requisição original já expirou; esta é uma reexecução do gateway de uma resposta 5xx antiga.';
  end if;
exception
  when sqlstate 'PT409' then
    raise;
  when others then
    -- A guarda nunca derruba uma requisição por defeito próprio (cabeçalho fora do esperado etc.).
    return;
end;
$$;

comment on function public.fn_pgrst_recusar_replay_do_gateway() is
  'pgrst.db_pre_request: responde 409 a requisição que o gateway do Supabase reexecuta há >5 min (sb-request-id UUIDv7 velho), para não alimentar o loop de retry de 5xx que esgota o pool do PostgREST.';

-- Roda sob o papel da REQUISIÇÃO (anon/authenticated/service_role), então os três
-- precisam de EXECUTE; sem isso a própria guarda vira "permission denied" → 5xx.
-- Não é definer e não lê nada além dos GUCs da requisição: expô-la não amplia nada.
revoke all on function public.fn_pgrst_recusar_replay_do_gateway() from public, anon;
grant execute on function public.fn_pgrst_recusar_replay_do_gateway() to anon, authenticated, service_role;

-- O papel `authenticator` só existe onde há PostgREST (Supabase). No Postgres
-- descartável do `test:db` não existe, e um ALTER ROLE sem guarda derrubaria o
-- install fresco (ON_ERROR_STOP=1).
do $$
begin
  if to_regrole('authenticator') is not null then
    execute $c$alter role authenticator set pgrst.db_pre_request = 'public.fn_pgrst_recusar_replay_do_gateway'$c$;
  end if;
end $$;

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
