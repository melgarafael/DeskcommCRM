-- manifest: **Os avisos de orçamento de IA (`budget_exceeded` e `budget_warning`) não abrem em dobro quando dois turnos concorrentes avaliam o gasto ao mesmo tempo (issue #880, a última família — grão (organização, kind), exatamente como o corpo da issue propôs).** Os escritores deduplicam por (organização, kind) com pergunta-e-escrita: a CTE `avisa` de `SQL_ORCAMENTO` (`lib/agent-engine/edge/llm/orcamento.ts`, executada por `run-model-call.ts`), o insert do `budget_exceeded` (`run-model-call.ts`), o `abrirItemDeOrcamento` (`workers/ai-response-worker.ts`, via PostgREST — o comentário dele declara a corrida) e o insert de migração do próprio `baseline.sql`. Todos rodam concorrentes: o worker roda jobs em PARALELO e dois drains podem avaliar a mesma organização. Índice único parcial `agent_inbox_budget_aberto_unico` em `(organization_id, kind)` `where status = 'open' and kind in ('budget_exceeded','budget_warning')`. `status` fora da chave: a linha resolvida sai do índice e a reabertura continua. Cópias abertas repetidas são RESOLVIDAS antes do índice (fica a mais antiga; nenhuma é apagada — régua da 0064). Os dois inserts do engine ganham `on conflict ... do nothing`: a decisão do orçamento viaja no MESMO statement da CTE e um `23505` cru descartaria o veredito (o `catch` do chamador segue a chamada sem teto; a recusa por bloqueio é que não pode se perder). O `abrirItemDeOrcamento` já trata o erro (loga e segue). Aditiva e idempotente; apêndice no fim do `baseline.sql`. Gates: `tests/invariants/budget-nao-abre-em-dobro.test.ts` e `tests/invariants/budget-atualizacao-resolve-copias.test.ts`.
-- 0540: os avisos de orçamento de IA não abrem em dobro
-- (issue #880, a última família; as anteriores foram 0491, 0527, 0538 e 0539).
--
-- O GRÃO É (ORGANIZAÇÃO, KIND), e não o título: `budget_exceeded` e
-- `budget_warning` são DOIS avisos — um relata que a IA parou, o outro que o
-- gasto passou do aviso e ela SEGUE — e os dois podem estar abertos juntos. Por
-- isso a chave é o par, e não (organização, kind, título) como na 0539: o
-- título do aviso de limiar varia com a posição do gasto.
--
-- QUATRO ESCRITORES, TODOS COM PERGUNTA E ESCRITA SEPARADAS:
--
--   * a CTE `avisa` de `SQL_ORCAMENTO` (`lib/agent-engine/edge/llm/orcamento.ts`,
--     executada em `run-model-call.ts`) faz `where not exists (... kind =
--     'budget_warning' ...)` numa ponta e o insert na outra;
--   * o insert do `budget_exceeded` no mesmo `run-model-call.ts` repete o
--     desenho;
--   * `abrirItemDeOrcamento` (`workers/ai-response-worker.ts`) faz SELECT e
--     depois INSERT pelo PostgREST — o comentário da própria função declara a
--     corrida ("dois drains simultâneos podem abrir dois itens iguais lá e
--     aqui");
--   * o insert de migração do `baseline.sql` (a pausa antiga desligada) é
--     one-shot do `update.sh`, sem concorrência, e tem a MESMA guarda.
--
-- E ELES SÃO CONCORRENTES: o worker roda jobs em PARALELO (main.ts chama
-- `runJob` até `QUEUE_MAX_CONCURRENCY` sem await), então dois turnos de
-- organizações diferentes — ou da mesma — avaliam o orçamento no mesmo instante;
-- e o ai-response-worker é outro processo. A issue #880 propôs exatamente este
-- índice ("Índice único parcial (organization_id, kind) where status = 'open'
-- para os kinds deduplicados por kind, com captura de `23505` no insert").
--
-- A DECISÃO DO ORÇAMENTO VIAJA NO MESMO STATEMENT DO INSERT (`SQL_ORCAMENTO`):
-- um `23505` cru derrubaria a consulta inteira, o `catch` do chamador seguiria a
-- chamada SEM TETO, e a recusa por bloqueio se perderia. Por isso os dois
-- inserts do engine ganham `on conflict ... do nothing`: o veredito volta e a
-- linha duplicada simplesmente não entra. O `abrirItemDeOrcamento` já loga o
-- erro e SEGUE — não muda.
--
-- PRÉVIA: as cópias abertas repetidas são RESOLVIDAS (só a mais antiga fica
-- aberta), nunca apagadas — régua da 0064, a mesma das 0491/0527/0538/0539.
-- Sem esta passada o `create unique index` falharia com 23505 em instalação que
-- já rodou a corrida, e a atualização pararia no meio.
--
-- ESCOPO: só os dois kinds de orçamento. Com esta fatia, todo grão de dedupe
-- desta tabela tem índice ou é comprovadamente serializado/terminal: `kind` →
-- aqui; `kind_e_titulo` → 0491 (event_dead) e 0539 (título, `other`);
-- `kind_e_ref` → 0538 (job_dead de conversa) e a fila serializa os turnos por
-- contato; `kind_ref_e_titulo` → o espelho de stage roda dentro do turno
-- serializado; e os registros de ocorrência (`job_queue`/`cron_jobs`) são
-- terminais por construção.
--
-- Idempotente: `if not exists` no índice e `row_number()` que casa zero linhas
-- na segunda passada. Reaplicar não duplica nem falha.
with repetidas as (
  select id,
         row_number() over (
           partition by organization_id, kind
           order by created_at asc, id asc
         ) as ordem
    from public.agent_inbox_items
   where status = 'open'
     and kind in ('budget_exceeded','budget_warning')
)
update public.agent_inbox_items i
   set status = 'resolved',
       resolved_at = now()
  from repetidas r
 where i.id = r.id
   and r.ordem > 1;

create unique index if not exists agent_inbox_budget_aberto_unico
  on public.agent_inbox_items (organization_id, kind)
  where status = 'open' and kind in ('budget_exceeded','budget_warning');
