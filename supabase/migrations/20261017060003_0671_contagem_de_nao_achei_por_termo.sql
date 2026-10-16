-- manifest: **A contagem de uso das capacidades ganha leitura POR TERMO: `fn_agent_tool_usage_por_termo` (#484, fatia do caminho 2).** O (#484) caminho 1 já parou de auditar "não achei" como sucesso (PR #1182), mas o painel agregava só por `tool_name` e não dizia QUAL termo não foi encontrado. A tool passa a declarar o termo (`termoBuscado`) e a auditoria sobe `metadata.termo`; esta migration cria a leitura `fn_agent_tool_usage_por_termo(uuid, uuid, timestamptz)` que agrupa por (tool_name, termo). Sem coluna nova, sem mudança na `fn_agent_tool_usage` que já existe (mudar o GROUP BY dela quebraria `montarUsoDeCapacidades`, que deduplica por nome de tool).

-- ---- contagem de "não achei" POR TERMO no uso das capacidades (migration 0671, #484) ----
--
-- O QUE ESTAVA MORTO
-- ------------------
-- O caminho 1 do #484 (PR #1182) fez o vazio DECLARADO da busca parar de ser
-- auditado como sucesso: `metadata.success = false` com
-- `metadata.desfecho = 'sem_resultado'` e `metadata.motivo`. `fn_agent_tool_usage`
-- (migration 0103) então conta a falha por `metadata->>'success' = 'false'`.
--
-- O que faltava era o TERMO. O painel dizia "crm_search_products: 12 tentativas,
-- 12 falhas" e nada mais: o dono da loja não sabia se faltava cadastrar UM
-- produto ou se a busca estava errando SEMPRE no mesmo termo. O termo já existia
-- no audit dentro de `metadata.args` (lib/mcp/audit.ts, `redactArgs`), mas sob o
-- nome do argumento de cada tool — contar por ele no banco seria gravar
-- `metadata->'args'->>'termo'`, o nome de UMA tool dentro do SQL. A tool passa a
-- DECLARAR o termo (`termoBuscado`, lib/mcp/types.ts) e ele sobe para
-- `metadata.termo`, chave única e independente de tool.
--
-- POR QUE UMA FUNÇÃO NOVA E NÃO UM GROUP BY A MAIS NA 0103
-- -------------------------------------------------------
-- `fn_agent_tool_usage` alimenta `montarUsoDeCapacidades`
-- (lib/ai/agents/uso-de-capacidades.ts), que junta as linhas num `Map` por
-- `tool_name`. Acrescentar `termo` ao GROUP BY dela produziria VÁRIAS linhas por
-- tool, e o `Map` guardaria só a última: os totais da tela ficariam MENORES que
-- a realidade, contando uma fatia de termo como se fosse o uso inteiro. É o
-- defeito que a 0103 existe para não ter. A leitura por termo é uma função
-- SEPARADA, aditiva — a 0103 não muda nem de assinatura nem de resultado.
--
-- O MESMO CAMINHO DE ACESSO DA 0103
-- ---------------------------------
-- O elo continua `api_audit_log.request_id = ai_agent_runs.id`, a janela é
-- aplicada nos dois lados (`r.started_at` e `a.created_at`) e o filtro é por
-- (organização, agente). A única diferença é o `and a.metadata->>'termo' is not
-- null`, que descarta as chamadas de tools que não declaram termo — o agrupamento
-- por termo (SQL) e a RLS (invoker) seguem a régua da 0103.
--
-- security invoker de propósito, como a 0103: pelo service role (a rota já
-- resolve a org do cookie e filtra) a RLS não se aplica; por usuário autenticado,
-- `audit_log_select` continua exigindo admin.
create or replace function public.fn_agent_tool_usage_por_termo(
  p_organization_id uuid,
  p_agent_id        uuid,
  p_since           timestamptz
)
returns table (
  tool_name  text,
  termo      text,
  total      bigint,
  falhas     bigint,
  ultima_vez timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.metadata->>'tool_name'                                          as tool_name,
    a.metadata->>'termo'                                             as termo,
    count(*)::bigint                                                 as total,
    count(*) filter (where a.metadata->>'success' = 'false')::bigint  as falhas,
    max(a.created_at)                                                as ultima_vez
  from public.ai_agent_runs r
  join public.api_audit_log a
    on  a.request_id      = r.id::text
    and a.action          = 'mcp.tool_called'
    and a.organization_id = p_organization_id
    and a.created_at     >= p_since
  where r.organization_id = p_organization_id
    and r.agent_id        = p_agent_id
    and r.started_at     >= p_since
    and a.metadata->>'tool_name' is not null
    and a.metadata->>'termo'     is not null
  group by 1, 2
$$;

comment on function public.fn_agent_tool_usage_por_termo(uuid, uuid, timestamptz) is
  'Uso das capacidades (tools MCP) de um agente agrupado POR TERMO: total, falhas e a última vez de cada termo declarado pela tool (`metadata.termo`). Irmã de fn_agent_tool_usage (que agrega por tool): esta separa "não achei sempre o mesmo termo" de "não achei por sorte".';

-- Doutrina 9: a função nasce com EXECUTE para PUBLIC (padrão do Postgres) e
-- para anon (default ACL do Supabase); sem os dois revoke, o PostgREST a expõe
-- como RPC à anon key.
revoke execute on function public.fn_agent_tool_usage_por_termo(uuid, uuid, timestamptz)
  from public, anon;

grant execute on function public.fn_agent_tool_usage_por_termo(uuid, uuid, timestamptz)
  to authenticated, service_role;
