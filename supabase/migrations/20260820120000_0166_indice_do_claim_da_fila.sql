-- 0166 — O CLAIM DA FILA CONTAVA `running` VARRENDO A TABELA INTEIRA.
--
-- ═══ O DEFEITO MEDIDO ═══
--
-- `claimJobs` (lib/agent-engine/queue/queue.ts) abre a rodada com o cap global:
--
--     select count(*)::int as n from job_queue where status = 'running'
--
-- `job_queue` tinha quatro índices — `job_queue_pkey`, `idx_job_queue_claim`
-- (parcial de `status = 'pending'`), `uniq_job_queue_one_running_per_contact`
-- (parcial de `status = 'running' AND contact_id IS NOT NULL`) e
-- `uniq_job_queue_source_event` — e NENHUM serve esse predicado. O parcial das
-- lanes chega perto e não vale: o predicado dele é mais ESTREITO que o da
-- pergunta (exclui `contact_id is null`, que é todo `watchdog`/`flywheel`), então
-- o planejador não pode responder por ele. Sobra Seq Scan.
--
-- Medido em pgvector/pgvector:pg17 com este baseline aplicado, 50.000 linhas
-- `done` + 4 `running`:
--
--     sem este índice   Seq Scan, Rows Removed by Filter: 50000, buffers 715
--     com este índice   Index Only Scan, buffers 3
--
-- ═══ O CUSTO NÃO DEPENDE DE LINHA VIVA, DEPENDE DE BLOAT ═══
--
-- Medido na mesma sessão, apagando as 50.004 linhas dentro de uma transação e
-- perguntando de novo: **715 buffers, zero linha viva**. Seq Scan visita página,
-- não tupla — uma fila com histórico já drenado paga o mesmo pedágio que uma
-- fila cheia, e paga a cada rodada de claim, para sempre. É o mesmo raciocínio
-- da 0258 (o relógio da fila): a fila é escrita o tempo todo e nada no produto a
-- poda.
--
-- ═══ O QUE ESTE ÍNDICE NÃO CONSERTA ═══
--
-- O `/healthz` do worker (workers/agent-worker/main.ts) e o snapshot de métricas
-- (lib/agent-engine/obs/metrics.ts) perguntam
-- `select status, count(*) from job_queue group by status`. Esse `group by`
-- precisa de TODOS os status, e um índice parcial de `running` cobre um só —
-- medido, o plano continua HashAggregate sobre Seq Scan, 715 buffers, com e sem
-- este índice. Não é regressão nem esquecimento: é fora do escopo desta
-- migration, e o `/healthz` roda por probe do Docker (a cada 30s), não no
-- caminho quente do claim.
--
-- ═══ POR QUE `create index if not exists` NÃO BASTA SOZINHO ═══
--
-- Ele casa por NOME, não por definição — medido em pg17:
--
--   (1) índice homônimo na PRÓPRIA `job_queue` com outra definição
--       → `NOTICE: relation ... already exists, skipping`, o índice velho fica.
--         NOTICE nem chega ao filtro do `update.sh` (que só olha ERROR|FATAL):
--         no-op perfeitamente silencioso.
--   (2) índice homônimo em OUTRA tabela (nome de índice é único por SCHEMA)
--       → mesmo no-op — e o `comment on index` abaixo acerta o índice ERRADO,
--         ou seja o delator fica cego.
--
-- O bloco `do $$` trata os dois, e trata cada um como merece: (1) é lixo com o
-- nosso nome, então ele é derrubado e recriado; (2) é índice de outra pessoa,
-- então ele NÃO é apagado — a atualização grita com a razão escrita e o
-- operador decide. `raise exception` aqui é o comportamento certo justamente
-- porque o `update.sh` roda SEM `ON_ERROR_STOP`: o erro aparece na tela dele e o
-- resto do baseline segue.
--
-- ═══ O `comment on index` É DELATOR, NÃO ENFEITE ═══
--
-- Se o índice não existir, ele levanta
-- `ERROR: relation "idx_job_queue_running" does not exist` — conferido contra o
-- filtro real do `update.sh` (`already exists|multiple primary keys|multiple
-- default values|is already a member|already a partition`): esse texto NÃO casa
-- com nenhum termo benigno, então aparece ao operador. Um `already exists` seria
-- engolido. É a diferença entre um índice que não chegou ao clone e um índice
-- que não chegou ao clone EM SILÊNCIO.
--
-- Custo: 16 kB medidos (`pg_relation_size`) com 4 linhas `running`; o índice só
-- indexa as linhas em voo, que são no máximo `QUEUE_MAX_CONCURRENCY`.
--
-- Aditivo e idempotente: sem constraint nova, sem backfill, sem dado tocado.

do $$
declare
  v_relkind "char";
  v_def     text;
  v_tabela  text;
begin
  -- Consulta `pg_class` e não `pg_indexes`: o nome pode estar tomado por algo
  -- que nem é índice, e é justamente esse caso que precisa gritar.
  select c.relkind,
         case when c.relkind in ('i', 'I') then pg_get_indexdef(c.oid) end,
         t.relname
    into v_relkind, v_def, v_tabela
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_index i on i.indexrelid = c.oid
    left join pg_class t on t.oid = i.indrelid
   where n.nspname = 'public'
     and c.relname = 'idx_job_queue_running';

  if v_relkind is null then
    return;                       -- nome livre: o `create` abaixo faz o trabalho
  end if;

  if v_relkind not in ('i', 'I') or v_tabela is distinct from 'job_queue' then
    raise exception
      'o nome idx_job_queue_running já está tomado em public (relkind=%, tabela=%). '
      'Nome de índice é único por SCHEMA, então o create index if not exists desta '
      'atualização vira no-op silencioso e o claim da fila continua varrendo a tabela '
      'inteira a cada rodada. Não apago o objeto porque ele não é nosso: renomeie-o e '
      'rode a atualização de novo.', v_relkind, coalesce(v_tabela, '(nenhuma)');
  end if;

  -- Nosso nome, nossa tabela, definição divergente ⇒ lixo de um clone que
  -- criou o índice à mão. Derruba para o `create` abaixo valer.
  if v_def !~ 'USING btree \(status\)' or v_def !~ 'WHERE \(status = ''running''' then
    execute 'drop index public.idx_job_queue_running';
  end if;
end
$$;

create index if not exists idx_job_queue_running
  on job_queue (status) where status = 'running';

comment on index idx_job_queue_running is
  'Cap global do claim: select count(*) from job_queue where status = ''running'' '
  '(lib/agent-engine/queue/queue.ts). Sem ele o claim faz Seq Scan a cada rodada — '
  '715 buffers com 50 mil linhas, e o mesmo custo com zero linha viva, porque Seq '
  'Scan visita página e não tupla. Este COMMENT é o delator do bloco: índice ausente '
  'vira "relation does not exist", que NÃO casa com o filtro benigno do update.sh e '
  'chega ao operador; "already exists" seria engolido.';
