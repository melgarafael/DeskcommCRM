-- manifest: índice parcial da FILA DE ESPERA do Inbox — a lista e a contagem da aba param de varrer o histórico encerrado e passam a ler só as conversas sem dono e abertas (#4325, item 2).
-- 9357 — índice da fila de espera do Inbox (#4325, item 2).
--
-- ─── O que estava sem caminho indexado ──────────────────────────────────────
--
-- A aba Fila pede `comando_da_conversa in ('aguardando','ninguem')` e ordena por
-- `awaiting_since asc, id asc` (`ORDEM_DA_ESPERA`, lib/inbox/comando-da-conversa.ts).
-- O pré-filtro do item 1 (commit b64b3c4f64) já impede a função de rodar em linha
-- que ela recusaria, mas NENHUM índice servia o conjunto resultante:
--
--   * `idx_conversations_open_unassigned` é da Fila antiga — parcial em
--     `status = 'open'`, ordenado por `last_inbound_at`;
--   * `conversations_org_sector_awaiting` é parcial em `sector_id is not null`.
--
-- Sobravam varredura sequencial da organização inteira (o histórico encerrado é a
-- maior parte das linhas) e um `Sort` por cima. Medido neste repositório, pg15,
-- baseline aplicado, 120.000 conversas (96.000 encerradas, 23.880 com dono, 120 na
-- fila), `explain (analyze, buffers)`:
--
--   lista da Fila (limit 51)   Seq Scan, 120.000 linhas lidas  4.343 buffers
--   lista da Fila (limit 51)   Bitmap no índice, 120 linhas      685 buffers
--   contagem da Fila           Seq Scan, 120.000 linhas lidas  4.139 buffers
--   contagem da Fila           Bitmap no índice, 120 linhas      485 buffers
--
-- O "depois" não cresce com o histórico: com 60.000 conversas o mesmo plano mediu
-- 686 buffers (o "antes" caiu para 2.714). Custo que depende do tamanho da FILA,
-- não do tamanho do histórico, é o que a issue pede.
--
-- ─── Por que PARCIAL, e por que estas colunas ───────────────────────────────
--
-- O predicado do índice é EXATAMENTE o pré-filtro do item 1 — `assigned_to_user_id
-- is null` e `status not in ('closed','archived','resolved')` —, então o planner
-- prova a implicação e usa o índice sem `enable_seqscan`. As três colunas são a
-- chave da consulta: igualdade de organização, ordem de espera e desempate por id.
-- Parcial porque a fila é uma fração mínima da tabela: o índice só indexa as
-- linhas que a aba pode devolver, e a troca de `status` para encerrado continua
-- sendo HOT update (a linha sai do índice, não é reescrita nele).
--
-- ⚠️ O índice NÃO substitui a função: `comando_da_conversa` é `stable security
-- definer` e o Postgres não a abre em predicados. Ele só é usado porque o
-- pré-filtro deixa os predicados equivalentes escritos na consulta. Sem o
-- pré-filtro o plano volta a ser Seq Scan mesmo com o índice criado — medido:
-- 2.126 ms e 60.000 avaliações da função no controle.
--
-- Sem CONCURRENTLY: o runner envolve a migration em transação. A criação trava
-- escrita em `conversations` pelo tempo de construir o índice (a tabela é grande;
-- o self-host aplica no `update.sh`, fora de horário de pico).
-- Sem função nova (nada a revogar de anon).

create index if not exists idx_conversations_fila_espera
  on public.conversations (organization_id, awaiting_since, id)
  where assigned_to_user_id is null
    and status not in ('closed', 'archived', 'resolved');

-- O delator do espelho: sem o índice, este COMMENT levanta "relation does not
-- exist" no `update.sh` (texto que NÃO casa com o filtro benigno do reaplicador e
-- chega ao operador), enquanto "already exists" seria engolido em silêncio.
comment on index public.idx_conversations_fila_espera is
  'Fila de espera do Inbox (#4325): casa o pré-filtro do comando (sem dono, fora do histórico encerrado) e a ordem ORDEM_DA_ESPERA (awaiting_since asc, id asc). Medido: lista da Fila 4.343 -> 685 buffers com 120 mil conversas.';
