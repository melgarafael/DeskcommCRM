-- manifest: **O Efi Bank entra como provedor de cobrança, no encaixe que já existe.** `cobranca_assinaturas.provedor` e `webhook_events_log_provider_check` ganham `'efi'`, e o índice único `uniq_webhook_events_log_cobranca` passa a cobrir o provedor novo (o `23505` dele é a idempotência do aviso). Alargamento puro de vocabulário: nenhuma linha que passava deixa de passar, nenhum backfill, nenhuma função e nenhuma policy tocadas.
--
-- ── Por que o banco muda ─────────────────────────────────────────────────────
--
-- O adaptador (`lib/cobranca/provedores/efi.ts`) implementa `AdaptadorDeCobranca`
-- e é registrado no ponto único (`lib/cobranca/provedores/index.ts`). O checkout
-- grava `provedor = 'efi'` em `cobranca_assinaturas` e a rota do aviso grava
-- `provider = 'efi'` em `webhook_events_log`: sem os dois CHECKs alargados, os
-- dois INSERTs morrem com 23514 — medido, não suposto.
--
-- ── O que NÃO muda ───────────────────────────────────────────────────────────
--
-- O índice parcial é recriado com a MESMA definição mais `'efi'`; as linhas dos
-- outros dois provedores continuam cobertas pelo mesmo predicado. `provedor`
-- segue anulável (a empresa em teste grátis sem provedor). Nada de coluna nova:
-- o Efi não tem cadastro de cliente, então `provedor_cliente_id` guarda a nossa
-- empresa (`org:<uuid>`) — texto, como já era.
--
-- No `supabase/baseline.sql`, os dois blocos de CHECK e o índice são os MESMOS
-- de sempre, editados no lugar (regra do #159: um bloco por constraint, nunca um
-- bloco novo no fim). Idempotente: `drop constraint if exists` + `add`,
-- `drop index if exists` + `create`.
--
-- Gates: tests/invariants/vocabulario-banco-x-typescript.test.ts,
-- tests/invariants/cobranca-webhook-e-avisos.test.ts,
-- tests/unit/baseline-constraint-reconstruida.test.ts,
-- tests/unit/colisao-de-migration-roda-no-ci.test.ts.

-- ── A. a assinatura pode ser do Efi ─────────────────────────────────────────
-- Lista COMPLETA do bloco único do baseline, mais 'efi'. Alargamento puro.
alter table public.cobranca_assinaturas
  drop constraint if exists cobranca_assinaturas_provedor_check;
alter table public.cobranca_assinaturas
  add constraint cobranca_assinaturas_provedor_check check (provedor in ('stripe', 'asaas', 'efi'));

-- ── B. o arquivo do webhook aceita o aviso do Efi ────────────────────────────
-- Lista COMPLETA do bloco único do baseline (0151, alargado pela 0387 e pela
-- 0601), mais 'efi'. A linha de cobrança nasce com organization_id NULO,
-- cabeçalhos NULOS e corpo `{id,type}`: é ponteiro, não o corpo do provedor.
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'stripe', 'asaas', 'efi'
  ));

-- ── C. um evento de cobrança, uma linha — inclusive o do Efi ─────────────────
-- O Efi manda o MESMO token de notificação para toda mudança de estado daquela
-- cobrança; o adaptador compõe o id do evento com uma janela de 1 minuto
-- (`efi:<token>:<janela>`), então a reentrega do mesmo aviso cai neste 23505 e
-- uma mudança posterior acorda a leitura de novo. Sem o provedor no predicado,
-- o aviso do Efi não teria idempotência NENHUMA.
drop index if exists public.uniq_webhook_events_log_cobranca;
create unique index uniq_webhook_events_log_cobranca
  on public.webhook_events_log (provider, external_id)
  where provider in ('stripe', 'asaas', 'efi');
