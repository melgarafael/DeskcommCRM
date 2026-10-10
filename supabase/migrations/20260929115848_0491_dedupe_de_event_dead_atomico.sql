-- 0491: o aviso `event_dead` não abre em dobro com dois drenos concorrentes
-- (issue #880).
--
-- O dedupe de `agent_inbox_items` era uma PERGUNTA e uma ESCRITA separadas: o
-- dreno consulta "já existe um aviso aberto?" e só depois insere
-- (`lib/event-log/drain.ts`, `avisarEventoMorto`) — e o `insert … where not
-- exists` de `insertInboxItem` (`lib/agent-engine/db/repository.ts`) já juntava
-- as duas numa instrução só, mas sem índice nenhum que sustentasse a condição.
-- O cron `event-log-drain` (`app/api/v1/cron/event-log-drain/route.ts`) e o
-- drain-loop do worker (`lib/event-log/drain-loop.ts`) rodam `drainEventLog` ao
-- mesmo tempo: os dois leem "não existe" antes de qualquer escrita e os dois
-- inserem. Dois avisos idênticos para o mesmo problema — e Central repetida é
-- Central que ninguém abre, que é como o alerta morre pela segunda vez.
--
-- A CHAVE É (organização, kind, TÍTULO) e não (organização, kind): `event_dead`
-- tem duas famílias que precisam conviver abertas na mesma organização — o da
-- IA que deixou de responder e o de mídia/automação (`lib/event-log/
-- aviso-de-evento-morto.ts`, "as duas famílias"). Um índice só por
-- (organização, kind) recusaria a segunda.
--
-- O PREDICADO É PARCIAL (`where status = 'open'`) e não `status` na chave: na
-- chave ele guardaria UMA linha resolvida por (organização, kind, título) para
-- sempre, e a reabertura (`PATCH /api/v1/ai/inbox/[id]`, "resolver por engano
-- não pode esconder alerta") morreria no segundo ciclo de resolver/reabrir. No
-- índice parcial a linha resolvida SAI do índice e volta quando reabre; o que
-- ele recusa é reabrir para um slot que já tem um aviso aberto igual, que é
-- exatamente o par que a issue quer impedir.
--
-- ESCOPO: só `kind = 'event_dead'`. Os outros dedupes desta tabela querem
-- VÁRIAS linhas abertas com o mesmo título — `job_dead`, `promise_unfulfilled`,
-- `handoff` e `other` deduplicam por (kind, ref) ou por (kind, ref, título),
-- uma por conversa ou por lead. Um índice global (organização, kind, título)
-- apagaria aviso legítimo de outro cliente, que é pior do que repetir: some
-- sinal em vez de sobrar ruído.
--
-- PRÉVIA: as cópias abertas repetidas são RESOLVIDAS (só a mais antiga fica
-- aberta), nunca apagadas — mesma régua da 0064 ("dedupe prévio, demais viram
-- cancelada, nunca delete"). Sem esta passada o `create unique index` falharia
-- em instalação que já rodou a corrida, com 23505, e a migration pararia no
-- meio.
--
-- Idempotente: `if not exists` no índice e `row_number()` que casas zero linhas
-- na segunda passada. Reaplicar não duplica nem falha.
with repetidas as (
  select id,
         row_number() over (
           partition by organization_id, kind, title
           order by created_at asc, id asc
         ) as ordem
    from public.agent_inbox_items
   where status = 'open'
     and kind = 'event_dead'
)
update public.agent_inbox_items i
   set status = 'resolved',
       resolved_at = now()
  from repetidas r
 where i.id = r.id
   and r.ordem > 1;

create unique index if not exists agent_inbox_event_dead_aberto_unico
  on public.agent_inbox_items (organization_id, kind, title)
  where status = 'open' and kind = 'event_dead';
