-- 0103 — o uso das capacidades do agente, legível na tela.
--
-- O QUE ESTAVA MORTO
-- ------------------
-- Toda chamada de tool do agente já era auditada em `api_audit_log`
-- (`action='mcp.tool_called'`, via lib/mcp/audit.ts) desde a Spec 11. Um grep no
-- repo inteiro por 'mcp.tool_called' mostrava só o EMISSOR: nenhum leitor, em
-- nenhuma tela. Log invisível é log morto — invariante 3 da doutrina do sistema
-- vivo. Quem liga uma capacidade para o agente não tinha como saber se ela é
-- usada, se falha, ou se está ali só ocupando uma das 20 vagas.
--
-- POR QUE UMA FUNÇÃO NO BANCO, E NÃO DUAS QUERIES NO NODE
-- ------------------------------------------------------
-- Não existe FK entre `api_audit_log` e `ai_agent_runs` (o audit é append-only e
-- genérico), então o PostgREST não embute a relação. Amarrar os dois exigiria
-- trazer os ids dos runs do agente e mandá-los de volta num `in(...)`: um tenant
-- PME roda ~300 atendimentos/dia, o que dá ~9.000 runs em 30 dias — uma query
-- string de centenas de kB, ou uma varredura do audit inteiro no Node. As duas
-- saídas são piores que uma agregação de uma linha no banco.
--
-- O elo é `api_audit_log.request_id = ai_agent_runs.id`: o runtime nativo usa o
-- id do run como requestId ao montar o McpContext (lib/ai/runtime/agent.ts).
-- `request_id` é text e `id` é uuid — daí o cast explícito.
--
-- CAMINHO DE ACESSO, MEDIDO
-- -------------------------
-- Os runs saem de `ai_agent_runs_agent_idx (agent_id, started_at desc)`. O lado
-- do audit é o que decide o custo, e `api_audit_log` guarda TODA mutação da API
-- por 5 anos — varrê-la inteira seria uma conta que só piora com o tempo.
--
-- A janela é aplicada nos DOIS lados (`r.started_at` e `a.created_at`), o que
-- deixa o planner cortar por `idx_audit_action_time (action, created_at desc)`.
-- Medido em pgvector/pgvector:pg17, base com 708.020 linhas em `api_audit_log`
-- (10,2% delas `mcp.tool_called`, proporção realista — tool call é minoria no
-- audit) e 36.000 runs; o agente medido tem 9.000 runs e 18.000 chamadas na
-- janela. Melhor de 3 execuções:
--
--   sem a janela no audit                    345,7 ms
--   com a janela nos dois lados              224,0 ms
--   + índice parcial (request_id) p/ tool    165,0 ms   ← NÃO adotado
--
-- O índice dedicado dá mais 26%, e foi descartado de propósito: `api_audit_log`
-- é append-only de escrita altíssima (toda mutação da API passa por ela), e
-- pagar manutenção de índice em todo INSERT para economizar 60 ms numa aba que
-- se abre de vez em quando é a troca errada. Se algum dia a aba ficar lenta com
-- volume real, o índice é a primeira coisa a tentar — e esta medição é a
-- linha de base para comparar.
--
-- Efeito colateral aceito: um run iniciado ANTES da janela cujas chamadas caem
-- dentro dela fica de fora. Runs duram segundos; a fronteira erra por segundos.
--
-- `em_teste` conta o que veio de execução de teste (`is_dry_run`). Sem essa
-- separação a tela mentiria do jeito mais convidativo: "usada 4 vezes" quando as
-- 4 foram o próprio dono clicando em Testar, e nenhum cliente real foi atendido.
--
-- security invoker de propósito: chamada pelo service role (rota já resolve a
-- organização do cookie e filtra explicitamente), a RLS não se aplica; chamada
-- por um usuário autenticado, a policy `audit_log_select` continua valendo e
-- exige admin. Defesa em profundidade, sem SECURITY DEFINER para manter.

create or replace function public.fn_agent_tool_usage(
  p_organization_id uuid,
  p_agent_id        uuid,
  p_since           timestamptz
)
returns table (
  tool_name  text,
  total      bigint,
  falhas     bigint,
  em_teste   bigint,
  ultima_vez timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.metadata->>'tool_name'                                          as tool_name,
    count(*)::bigint                                                  as total,
    count(*) filter (where a.metadata->>'success' = 'false')::bigint   as falhas,
    count(*) filter (where r.is_dry_run)::bigint                       as em_teste,
    max(a.created_at)                                                 as ultima_vez
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
  group by 1
$$;

comment on function public.fn_agent_tool_usage(uuid, uuid, timestamptz) is
  'Uso das capacidades (tools MCP) de um agente: total, falhas, quantos vieram de execução de teste e a última vez. Elo audit<->run é api_audit_log.request_id = ai_agent_runs.id.';

grant execute on function public.fn_agent_tool_usage(uuid, uuid, timestamptz)
  to authenticated, service_role;

notify pgrst, 'reload schema';
