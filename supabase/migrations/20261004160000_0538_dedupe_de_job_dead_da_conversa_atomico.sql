-- manifest: **A resposta a caso obsoleto não abre em dobro quando a rota e o worker escrevem no mesmo instante (issue #880, a fatia que a 0491 e a 0527 deixaram).** `avisarRespostaDeCasoObsoleto` (`lib/atendimento/aviso-caso-obsoleto.ts`) deduplica por (organização, kind, conversa) com `insert ... where not exists`, e há dois escritores sem lock em comum: a rota síncrona `POST /api/v1/ai/cases/[id]/reply` (transação explícita) e o worker (`workers/agent-worker/main.ts`, pool). Índice único parcial `agent_inbox_job_dead_conversa_aberto_unico` em `(organization_id, kind, ref_id)` `where status = 'open' and kind = 'job_dead' and ref_kind = 'conversation'` — só a família da conversa entra: `job_dead` de job/cron é registro de ocorrência (na fila, `dead` é terminal), e receber índice mudaria o desfecho de inserts crus que rodam dentro de transações. `status` fora da chave: a linha resolvida sai do índice e a reabertura continua. Cópias abertas repetidas são RESOLVIDAS antes do índice (fica a mais antiga; nenhuma é apagada — régua da 0064). O gravador transacional isola o aviso em savepoint: `23505` não pode derrubar a resolução do caso com o `commit`. Gates: `tests/invariants/job-dead-da-conversa-nao-abre-em-dobro.test.ts`, `tests/invariants/job-dead-da-conversa-atualizacao-resolve-copias.test.ts` e `tests/invariants/resposta-de-caso-obsoleto-sobrevive-a-aviso-repetido.test.ts`. Aditiva e idempotente; apêndice no fim do `baseline.sql`.
-- 0538: o aviso de resposta a caso obsoleto (`job_dead` com ref de conversa)
-- não abre em dobro quando a rota e o worker escrevem no mesmo instante
-- (issue #880, a fatia que a 0491 e a 0527 deixaram de fora).
--
-- O dedupe é uma PERGUNTA e uma ESCRITA separadas: `avisarRespostaDeCasoObsoleto`
-- (`lib/atendimento/aviso-caso-obsoleto.ts`) usa
-- `insertInboxItem(..., 'kind_e_ref')`, cuja guarda é
-- `insert ... select ... where not exists` — e dois escritores chegam por
-- caminhos que NÃO compartilham lock:
--
--   * a rota síncrona `POST /api/v1/ai/cases/[id]/reply`
--     (`registrarRespostaDeCasoObsoleto`, transação explícita); e
--   * o worker de jobs (`workers/agent-worker/main.ts`, pool), quando um
--     `case_reply_turn` falha com fronteira de serviço velha.
--
-- A fila serializa um job por contato (`uniq_job_queue_one_running_per_contact`),
-- e é por isso que os outros dois kinds do modo `kind_e_ref`
-- (`promise_unfulfilled`, `handoff`) não entram aqui: os dois escritores deles
-- vivem DENTRO de jobs de turno. `job_dead` não: a rota é HTTP e roda fora da
-- fila.
--
-- ESCOPO: só `kind = 'job_dead'` e `ref_kind = 'conversation'`. É o único grão de
-- `job_dead` que é ESTADO (um aviso aberto por conversa). Os outros dois refs são
-- registro de ocorrência: `job_queue` (`failJob`/`reapExpiredJobs`,
-- `lib/agent-engine/queue/queue.ts`) só insere no pulo `running -> dead`, e todo
-- statement da fila que mexe em status exige `status = 'running'` (ou `pending`,
-- no claim) — nada sai de `dead`, então é um aviso por job; e `cron_jobs`
-- (`lib/agent-engine/cron/scheduler.ts`) é o mesmo registro no desligamento do
-- cron. Um índice sobre eles não protegeria corrida nenhuma e mudaria o desfecho
-- de inserts crus que rodam DENTRO de transações — o aviso é efeito colateral de
-- um disable que precisa commitar.
--
-- O PREDICADO É PARCIAL (`where status = 'open'`) e `status` NÃO entra na chave:
-- na chave, a linha resolvida ficaria presa para sempre e a reabertura morreria
-- no segundo ciclo de resolver/reabrir. No índice parcial a linha resolvida sai
-- dele e volta quando reabre; o que ele recusa é abrir um aviso para quem já tem
-- um aberto — a mesma chave da guarda do `insertInboxItem`.
--
-- PRÉVIA: as cópias abertas repetidas são RESOLVIDAS (só a mais antiga fica
-- aberta), nunca apagadas — régua da 0064, a mesma da 0491 e da 0527. Sem esta
-- passada o `create unique index` falharia com 23505 em instalação que já rodou
-- a corrida, e a atualização pararia no meio.
--
-- O CAMINHO TRANSACIONAL: a rota roda dentro de uma transação explícita, e ali um
-- `23505` a deixa em estado abortado — o `commit` viraria ROLLBACK silencioso e a
-- resposta que o humano acabou de registrar se perderia. Quem isola o aviso é um
-- savepoint em `registrarRespostaDeCasoObsoleto`
-- (`lib/atendimento/aviso-caso-obsoleto.ts`), não o índice: o banco diz "já
-- existe"; o savepoint garante que isso não é perda.
--
-- Idempotente: `if not exists` no índice e `row_number()` que casa zero linhas na
-- segunda passada. Reaplicar não duplica nem falha.
with repetidas as (
  select id,
         row_number() over (
           partition by organization_id, kind, ref_id
           order by created_at asc, id asc
         ) as ordem
    from public.agent_inbox_items
   where status = 'open'
     and kind = 'job_dead'
     and ref_kind = 'conversation'
)
update public.agent_inbox_items i
   set status = 'resolved',
       resolved_at = now()
  from repetidas r
 where i.id = r.id
   and r.ordem > 1;

create unique index if not exists agent_inbox_job_dead_conversa_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'job_dead' and ref_kind = 'conversation';
