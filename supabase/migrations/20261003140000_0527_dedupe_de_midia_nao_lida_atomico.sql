-- manifest: **O aviso `midia_nao_lida` não abre em dobro com dois workers concorrentes (issue #880, a parte que o #1928 deixou de fora).** `avisarMidiaNaoLida` (`workers/media-derive-worker.ts`) consultava "já existe aviso aberto?" e só depois inseria, com o lote de derivação em paralelo: dois workers liam "não existe" e abriam dois avisos. Índice único parcial `agent_inbox_midia_nao_lida_aberto_unico` em (organization_id, kind) `where status = 'open' and kind = 'midia_nao_lida'` — a chave NÃO leva o título (ao contrário da 0491): o select já ignora `tipo` e o título varia com a mídia, o código quer UM aviso aberto por organização. Predicado parcial e `status` fora da chave: a linha resolvida sai do índice e a reabertura continua funcionando. As cópias abertas repetidas são RESOLVIDAS antes do índice (fica a mais antiga; nenhuma é apagada — régua da 0064). O gravador trata `23505` como "o aviso já estava aberto". Aditiva e idempotente; apêndice no fim do `baseline.sql`. Gate: `tests/invariants/midia-nao-lida-nao-abre-em-dobro.test.ts`.
-- 0527: o aviso `midia_nao_lida` não abre em dobro com dois workers
-- concorrentes (issue #880, o resto que o #1928 deixou de fora).
--
-- O dedupe deste aviso é uma PERGUNTA e uma ESCRITA separadas: `avisarMidiaNaoLida`
-- (`workers/media-derive-worker.ts`) consulta "já existe aviso aberto desta
-- organização?" e só depois insere. O lote de derivação roda em paralelo, então
-- dois workers podem ler "não existe" antes de qualquer escrita e abrir dois
-- avisos idênticos — a mesma corrida que a 0491 fechou para `event_dead`, por
-- outro caminho (lá era `insert ... where not exists` sem índice que o
-- sustentasse; aqui é o select-e-insere à mão).
--
-- A CHAVE É (organização, kind), SEM o título. Em `event_dead` o título entra na
-- chave porque duas famílias daquele aviso precisam conviver abertas (a IA que
-- deixou de responder e a mídia/automação — cabeçalho da 0491). Aqui não: o
-- `select` de `avisarMidiaNaoLida` não olha `tipo` nem título, e o título varia
-- com a mídia ("...ler foto...", "...ler áudio..."). O que o código já quer é UM
-- aviso aberto por organização, seja qual for a mídia — este índice é a forma
-- atômica disso, e não uma regra nova.
--
-- O PREDICADO É PARCIAL (`where status = 'open'`) e `status` NÃO entra na chave:
-- na chave, ele guardaria uma linha resolvida por (organização, kind) para
-- sempre e a reabertura morreria no segundo ciclo de resolver/reabrir. No índice
-- parcial a linha resolvida sai dele e volta quando reabre; o que ele recusa é
-- abrir um aviso para quem já tem um aberto.
--
-- ESCOPO: só `kind = 'midia_nao_lida'`. Os outros dedupes desta tabela querem
-- VÁRIAS linhas abertas com o mesmo `kind` — `job_dead`, `promise_unfulfilled`,
-- `handoff` e outros deduplicam por (kind, ref) ou por (kind, ref, título), uma
-- por conversa ou por lead (ver o cabeçalho da 0491 e `InboxDedupe` em
-- `lib/agent-engine/db/repository.ts`). Um índice por (organização, kind) para
-- todos apagaria aviso legítimo de outro cliente: some sinal em vez de sobrar
-- ruído. Cada família entra com a chave dela.
--
-- PRÉVIA: as cópias abertas repetidas são RESOLVIDAS (só a mais antiga fica
-- aberta), nunca apagadas — mesma régua da 0064 usada na 0491. Sem esta passada
-- o `create unique index` falharia com 23505 em instalação que já rodou a
-- corrida, e a migration pararia no meio.
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
     and kind = 'midia_nao_lida'
)
update public.agent_inbox_items i
   set status = 'resolved',
       resolved_at = now()
  from repetidas r
 where i.id = r.id
   and r.ordem > 1;

create unique index if not exists agent_inbox_midia_nao_lida_aberto_unico
  on public.agent_inbox_items (organization_id, kind)
  where status = 'open' and kind = 'midia_nao_lida';
