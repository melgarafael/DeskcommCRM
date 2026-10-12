-- manifest: **O export de titular passa a ser reivindicado pelo worker com marcador atômico (issue #2751).** Medido na prova pela tela do #2669 (vps-teste, banco fresco do baseline, 11/10): um único pedido de dados LGPD gerou **duas** exportações — o webhook da Nuvemshop (`app/api/v1/webhooks/nuvemshop/customer-data-request/route.ts`) e a aprovação (`app/api/v1/lgpd/requests/[id]/approve/route.ts`) emitem `lgpd.data_request_received` cada um, os dois eventos são drenados em paralelo (o laço do worker e o cron, `lib/event-log/drain.ts`) e `processLgpdExport` (`workers/lgpd-export-worker.ts`) só pulava pedido `completed`: as duas execuções liam o mesmo `attempts` e as duas exportavam (`attempts=2`, dois `lgpd.export_generated`). A coluna `lgpd_requests.export_claimed_at` (nullable) é o marcador: o worker move o pedido para `processing` **condicionado** a `export_claimed_at is null or < now() - 10 min` — a mesma janela do reaper do `event_log` — e quem não reivindica sai `skipped` com o motivo. `status` sozinho não servia: a aprovação também grava `processing`, e é por isso que o marcador é do worker, não do fluxo. Retry: a falha que devolve o pedido a `received` zera o marcador; a reivindicação vencida é retomada pelo próximo evento (invariante 4 do Sistema Vivo). Número `0652`: a `0646` do PR original colidiu com o catálogo GPT-6 (#2750), que entrou antes na `main`; renumerado na triagem. Fora do recorte: unificar os emissores (decisão de produto) e a constraint de `pending_review` (PR em andamento). Gates: `workers/lgpd-export-worker.test.ts` (dois eventos do mesmo pedido → UMA exportação; reivindicação vencida retomada; falha limpa o marcador) e o baseline reaplicado com `ON_ERROR_STOP=1` no `pnpm test:db`.

-- 0652: o export do titular é reivindicado pelo worker (issue #2751).
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- o export do titular é reivindicado pelo worker (migration 0652, issue #2751) ----
-- O worker de exportação LGPD só pulava pedido `completed`, então dois eventos
-- do MESMO pedido — o webhook da Nuvemshop e a aprovação emitem
-- `lgpd.data_request_received` cada um — drenados em paralelo (o laço do worker
-- e o cron) liam o mesmo `attempts` e exportavam duas vezes: `attempts=2` e
-- dois `lgpd.export_generated`, com o PDF montado em dobro.
--
-- A reivindicação abaixo é ATÔMICA e exclusiva: só quem consegue gravar
-- `export_claimed_at` exporta; o segundo evento vira `skipped`. O marcador é do
-- WORKER porque a aprovação TAMBÉM grava `processing` (é o estado que a tela
-- mostra) — `status` sozinho não distingue "aprovado, ainda na fila" de
-- "exportando agora". A janela de 10 min espelha o reaper do `event_log`
-- (`PROCESSING_STALE_MS`, `lib/event-log/drain.ts`): processo derrubado no meio
-- é retomado pelo próximo evento; a falha que devolve o pedido a `received`
-- LIMPA a reivindicação, para o retry não esperar a janela.

alter table public.lgpd_requests
  add column if not exists export_claimed_at timestamptz;

comment on column public.lgpd_requests.export_claimed_at is
  'Instante da reivindicação do worker de exportação (issue #2751): só quem grava este marcador exporta o pedido. Reivindicação mais velha que 10 min é considerada órfã (processo derrubado) e pode ser retomada; a falha que devolve o pedido a received zera o marcador para o retry imediato.';
