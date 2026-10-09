-- manifest: **Os avisos da Central cuja chave é o TÍTULO (`kind` `other` sem ref própria ou ancorados na credencial de IA) não abrem em dobro quando dois escritores concorrem (issue #880; a nota do próprio `lib/ai/decisao/aviso.ts` pedia exatamente este índice).** `avisarFaltaDeSaldo` (saldo), o aviso do Jev (`lib/ai/decisao/aviso.ts`), a recusa por endereço sem chave da empresa (`run-model-call.ts`) e o laço do event-log (`aviso-do-laco.ts`) deduplicam com pergunta-e-escrita por título (`select`-e-`insert`/`where not exists`) e rodam concorrentes — o worker roda jobs em PARALELO (`runJob` não é awaited) e o aviso do Jev é aberto por dois drenos. Índice único parcial `agent_inbox_other_por_titulo_aberto_unico` em `(organization_id, kind, title)` `where status = 'open' and kind = 'other' and (ref_kind is null or ref_kind = 'ai_provider_credential')` — o `ref_kind` é o discriminador: os avisos de grão PRÓPRIO ficam fora (`lead` abre um por negócio com o MESMO título; `agent_case`, `number_health`, `janela_de_envio_fechada`, `cache_hit_ratio` e as escalações também). A pergunta de NULLS da #880 não se aplica: as refs não entram na chave (o grão é o título). `status` fora da chave: a linha resolvida sai do índice e a reabertura continua. Cópias abertas repetidas são RESOLVIDAS antes do índice (fica a mais antiga; nenhuma é apagada — régua da 0064). Os quatro escritores tratam `23505` como "já havia aviso" (o `insertInboxItem` devolve `null`; os outros logam e seguem). Aditiva e idempotente; apêndice no fim do `baseline.sql`. Gates: `tests/invariants/avisos-other-por-titulo-nao-abrem-em-dobro.test.ts` e `tests/invariants/avisos-other-por-titulo-atualizacao-resolve-copias.test.ts`.
-- 0539: os avisos da Central cuja chave é o TÍTULO não abrem em dobro
-- (issue #880, a família que a 0491, a 0527, a 0538 e agora esta fecham).
--
-- QUATRO ESCRITORES, UM GRÃO SÓ. Todos deduplicam por (organização, kind,
-- título) e todos fazem PERGUNTA e ESCRITA separadas:
--
--   * `avisarFaltaDeSaldo` (`lib/agent-engine/queue/espera-de-saldo.ts`) usa o
--     modo `kind_e_titulo` do `insertInboxItem` — a guarda é `insert ... where
--     not exists`, mas sem índice que a sustente em corrida;
--   * o aviso do Jev (`lib/ai/decisao/aviso.ts`) faz SELECT e depois INSERT, e
--     a nota do PRÓPRIO arquivo já dizia: "Fecha de vez só com índice único
--     parcial (org, título) em `kind='other' and status='open'`, que é migration
--     e exige antes deduplicar os avisos abertos de todo clone";
--   * a recusa por endereço sem chave da empresa
--     (`lib/agent-engine/edge/llm/run-model-call.ts`) repete o desenho — o
--     comentário do aviso do Jev cita as duas como a MESMA corrida;
--   * o laço do event-log (`lib/event-log/aviso-do-laco.ts`) faz select-e-insert
--     por título e já filtra as organizações que têm aviso aberto.
--
-- E ELES SÃO CONCORRENTES: o worker roda jobs em PARALELO (main.ts chama
-- `runJob` sem await, até `QUEUE_MAX_CONCURRENCY`), então duas falhas de saldo
-- de contatos diferentes da MESMA organização se encontram; e o aviso do Jev é
-- aberto pelo dreno do cron e pelo dreno do worker. Dois avisos idênticos na
-- Central é o defeito que a família #880 inteira combate: Central repetida é
-- Central que ninguém abre.
--
-- O DISCRIMINADOR É O `ref_kind` (a resposta medida à pergunta da #880). Os
-- outros escritores de `kind='other'` têm grão PRÓPRIO e ficam FORA:
--
--   * `lead` (`move-lead-stage.ts`, `aviso-de-etapa.handler.ts`): abre UM por
--     negócio, e o título se repete entre dois leads com o mesmo motivo — um
--     índice por (organização, título) recusaria o aviso do segundo;
--   * `agent_case` (escalação de caso), `number_health` (hold de saúde),
--     `janela_de_envio_fechada` (pacing), `cache_hit_ratio` (métricas),
--     `jailbreak_escalation` e `lgpd_escalation` (guardrails) — cada um com a
--     chave própria.
--
-- NULLS: as referências NÃO entram na chave, então a pergunta de `NULLS NOT
-- DISTINCT` da #880 não se aplica aqui — a chave é o título, e o que o índice
-- separa é o GRÃO (título vs. ref própria).
--
-- PRÉVIA: as cópias abertas repetidas são RESOLVIDAS (só a mais antiga fica
-- aberta), nunca apagadas — régua da 0064, a mesma da 0491/0527/0538. Sem esta
-- passada o `create unique index` falharia com 23505 em instalação que já rodou
-- a corrida, e a atualização pararia no meio.
--
-- O CONFLITO É DESFECHO NORMAL nos quatro escritores: o `insertInboxItem`
-- captura `23505` e devolve `null`; o Jev loga e segue (contrato: nunca lança);
-- o `run-model-call` loga e segue; o `aviso-do-laco` loga e segue. Nenhum
-- derruba o caminho que estava avisando.
--
-- ESCOPO: só `kind='other'`. Os `budget_exceeded`/`budget_warning` (grão
-- (organização, kind), com `abrirItemDeOrcamento` no ai-response-worker como
-- escritor concorrente) são a fatia irmã — ficam para a migração deles.
--
-- Idempotente: `if not exists` no índice e `row_number()` que casa zero linhas
-- na segunda passada. Reaplicar não duplica nem falha.
with repetidas as (
  select id,
         row_number() over (
           partition by organization_id, kind, title
           order by created_at asc, id asc
         ) as ordem
    from public.agent_inbox_items
   where status = 'open'
     and kind = 'other'
     and (ref_kind is null or ref_kind = 'ai_provider_credential')
)
update public.agent_inbox_items i
   set status = 'resolved',
       resolved_at = now()
  from repetidas r
 where i.id = r.id
   and r.ordem > 1;

create unique index if not exists agent_inbox_other_por_titulo_aberto_unico
  on public.agent_inbox_items (organization_id, kind, title)
  where status = 'open' and kind = 'other' and (ref_kind is null or ref_kind = 'ai_provider_credential');
