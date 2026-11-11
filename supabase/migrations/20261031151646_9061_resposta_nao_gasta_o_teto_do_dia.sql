-- manifest: **Resposta a quem escreveu não é mais segurada pelo teto do dia do número.** O teto de warm-up e o `daily_message_limit` contavam TODO envio do `pacing_ledger`, e `decidePacing` aplicava o teto também com `resposta: true` (a flag só trocava a janela de horário). Medido em produção: o número bateu 20/20 no 4º dia de warm-up e a resposta a dois leads que tinham acabado de escrever foi adiada para o dia seguinte às 9h. Agora o teto mede só DISPAROS (1ª mensagem, follow-up, campanha): `pacing_ledger.resposta` marca a linha gravada pela resposta, `loadPacingState` e `lerEstadoDoPacing` só contam `not resposta`, e `decidePacing` não aplica o teto quando `resposta` é verdadeiro — a janela de resposta e o espaçamento (throttle + jitter) continuam valendo. Coluna nova com default `false`: toda linha antiga e todo escritor que não declara segue contando como disparo. Idempotente; espelho no apêndice do `supabase/baseline.sql`.
-- 9061 — resposta não gasta nem é barrada pelo teto do dia.
--
-- Não cria função: nenhum grant a revogar.
alter table public.pacing_ledger
  add column if not exists resposta boolean not null default false;
comment on column public.pacing_ledger.resposta is
  'true = resposta a quem escreveu: vale para o espaçamento, não para o teto do dia (warm-up/daily_message_limit), que conta só disparos (9061).';
