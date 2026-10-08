-- 0585 — índices do caminho quente do agente e da poda diária da fila.
--
-- Cinco buscas rodavam sem índice que as servisse, e todas crescem com o uso:
--
-- 1. `send_ledger` por contato. "1º outbound" (`countPriorAcceptedSends`,
--    disclosure e LGPD) conta envios `accepted` do contato DENTRO da transação
--    que segura o lock do número; `ultimaInboundJaRespondida` procura envio
--    `accepted`/`queued` do mesmo contato a cada turno. Nenhum índice começava
--    por contato (o de busca é (organization_id, created_at)). O predicado
--    cobre os dois status porque `status = 'accepted'` implica
--    `status in ('accepted','queued')`: um índice serve as duas consultas.
--    Custo aceito: `status` entra no predicado, então a troca de status de um
--    envio deixa de ser HOT update — uma escrita a mais por envio, contra uma
--    varredura por contato a cada turno.
-- 2. `llm_calls.job_id`. `recordRunMetrics` soma as chamadas do run por job_id,
--    e o `on delete set null` vindo de `job_queue` faz a poda diária
--    (`fn_podar_fila_de_jobs`, até 1000 jobs por chamada) varrer a tabela uma vez
--    por job apagado.
-- 3/4. `lead_checkpoints.job_id` e `lead_state_transitions.job_id`: o mesmo
--    `on delete set null`, a mesma varredura por job apagado.
-- 5. `event_log` em `processing`. Dois polls fixos procuram eventos presos: o
--    reaper do drain do agente (a cada tick, por event_type) e o do dreno geral
--    (só status + updated_at). Os índices parciais existentes são de `pending`
--    e `dead`. A chave é `event_type`, e NÃO `updated_at`: o trigger
--    `trg_event_log_touch` reescreve updated_at em todo update, e indexá-lo tiraria
--    o HOT update de toda escrita na tabela. `processing` é transitório, então o
--    índice fica pequeno e o filtro de updated_at roda sobre poucas linhas.
--
-- Sem CONCURRENTLY: o runner envolve a migration em transação. A criação trava
-- escrita nessas tabelas pelo tempo de construir cada índice.
-- Sem função nova (nada a revogar de anon).

create index if not exists idx_send_ledger_contato_entregue
  on public.send_ledger (organization_id, contact_id)
  where status in ('accepted', 'queued');

create index if not exists idx_llm_calls_job_id
  on public.llm_calls (job_id)
  where job_id is not null;

create index if not exists idx_lead_checkpoints_job_id
  on public.lead_checkpoints (job_id)
  where job_id is not null;

create index if not exists idx_lead_state_transitions_job_id
  on public.lead_state_transitions (job_id)
  where job_id is not null;

create index if not exists event_log_processing_por_tipo_idx
  on public.event_log (event_type)
  where status = 'processing';
