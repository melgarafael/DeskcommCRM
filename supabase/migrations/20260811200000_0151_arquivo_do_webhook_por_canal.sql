-- ============================================================================
-- 0151 — O ARQUIVO DO WEBHOOK ACEITA OS CANAIS QUE ENTRARAM DEPOIS.
--
-- `webhook_events_log` é o único lugar onde o corpo CRU do que o provedor
-- mandou fica guardado. A rota do canal por QR grava lá desde sempre; a rota
-- genérica de canal (`/api/v1/webhooks/channel/[token]`), por onde entram os
-- canais oficiais, nunca gravou nada. Barrido feito antes desta migration:
-- zero escritores naquele caminho.
--
-- O efeito não é abstrato. O comentário de `lib/waha/ingest.ts` mostra que a
-- decisão sobre identidades opacas (`@lid`) só foi possível porque esse arquivo
-- existia em produção — "76 de 76", contados no banco. O instrumento que
-- respondeu aquela pergunta falta justamente no canal NOVO, que é onde ainda há
-- pergunta em aberto: se mensagem de grupo chega, de qual host vem o anexo.
--
-- ─── Por que uma migration, e não gravar 'generic' ─────────────────────────
--
-- Porque 'generic' seria uma string que mente. A coluna diz QUAL provedor
-- mandou, e escrever "genérico" para um canal que se sabe qual é reintroduz o
-- anti-pattern nº 1 da doutrina no exato lugar que existe para investigar.
--
-- ─── Por que é seguro ──────────────────────────────────────────────────────
--
-- É um ALARGAMENTO. Um CHECK que aceita MAIS valores não pode ser violado por
-- linha nenhuma que já passava pelo antigo — diferente de uma constraint que
-- restringe, esta não precisa de backfill nem de deduplicação antes.
--
-- A lista é a do baseline mais os dois canais do seam. Quem acrescentar um
-- canal daqui em diante mexe em DOIS lugares: o bloco único do apêndice do
-- `baseline.sql` e esta lista — e o gate
-- `tests/unit/baseline-constraint-reconstruida.test.ts` é quem cobra que a
-- constraint não seja reconstruída em série.
-- ============================================================================

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio'
  ));
