-- manifest: **Motivo novo `verificacao_manual` na passagem para humano (follow-up do #2885, PR #3052 de @guptasp82-jpg).** O CHECK de `passagens_de_atendimento.motivo_codigo` aceita `verificacao_manual`, gravado quando um fluxo determinístico coleta dados campo a campo e passa a conversa para uma pessoa conferir — distinto de `requested_human`, porque o cliente não pediu atendente. Só alarga o vocabulário: nenhuma linha existente viola o CHECK novo. Par de `MOTIVOS_DA_PASSAGEM`/`FRASE_DO_MOTIVO` em `lib/escalacao/passagem.ts`, cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`. No `baseline.sql`, o valor entra no bloco único de `passagens_de_atendimento_motivo_codigo_check` (e no CHECK inline do `create table`); o apêndice só registra isso em comentário.

-- 0693 — MOTIVO NOVO NA PASSAGEM: `verificacao_manual`
--
-- Um fluxo DETERMINÍSTICO (coleta campo a campo, um por turno) encerra em
-- handoff com os campos que já foram perguntados. A linha em
-- `passagens_de_atendimento` precisa de um motivo canônico que diga o que
-- houve: o cliente NÃO pediu uma pessoa (`requested_human` mentiria na
-- primeira frase de quem assume), um fluxo coletou dados e passou para
-- verificação humana.
--
-- Par obrigatório de `lib/escalacao/passagem.ts` (MOTIVOS_DA_PASSAGEM +
-- FRASE_DO_MOTIVO): as colunas com CHECK apontam para o vocabulário
-- TypeScript, e `tests/invariants/vocabulario-banco-x-typescript.test.ts` é o
-- que cobra a paridade. A lição da lista é a de sempre — TS e banco mudam no
-- MESMO commit, ou o INSERT falha com 23514 no caminho pouco exercitado que
-- existe justamente para o caso raro.

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_motivo_codigo_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_motivo_codigo_check
  check (motivo_codigo in (
    'requested_human','suspected_optout','orcamento_de_ia','low_sentiment',
    'low_confidence','critical_stage','legal_mention','refund_mention',
    'caso_escalado','verificacao_manual'));

notify pgrst, 'reload schema';
