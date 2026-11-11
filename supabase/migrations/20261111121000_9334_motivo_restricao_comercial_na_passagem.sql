-- manifest: **Motivo novo `restricao_comercial` na passagem para humano (Spec 34).** O CHECK de `passagens_de_atendimento.motivo_codigo` aceita `restricao_comercial`, gravado quando a trava de valores e negociação barra a resposta da IA e a conversa vai para a equipe — antes o cartão dizia "o assistente não teve confiança suficiente", o que não é o que aconteceu: foi uma regra da organização que o impediu de falar. Só alarga o vocabulário: nenhuma linha existente viola o CHECK novo. Par de `MOTIVOS_DA_PASSAGEM`/`FRASE_DO_MOTIVO` em `lib/escalacao/passagem.ts`, cobrado por `tests/invariants/vocabulario-banco-x-typescript.test.ts`. No `baseline.sql`, o valor entra no bloco único de `passagens_de_atendimento_motivo_codigo_check` (e no CHECK inline do `create table`); o apêndice só registra isso em comentário.

-- MOTIVO NOVO NA PASSAGEM: `restricao_comercial`
--
-- Quando a trava "valores e negociação só com a equipe" barra a resposta da IA e
-- o cliente tinha perguntado de preço, a conversa passa para a equipe. O motivo
-- gravado era `low_confidence` ("o assistente não teve confiança suficiente"),
-- que manda quem assume procurar uma dúvida da IA onde havia uma regra da
-- organização. O motivo próprio diz o que houve.
--
-- Par obrigatório de `lib/escalacao/passagem.ts` (MOTIVOS_DA_PASSAGEM +
-- FRASE_DO_MOTIVO): TS e banco mudam no MESMO commit, ou o INSERT falha com
-- 23514 no caminho pouco exercitado.

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_motivo_codigo_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_motivo_codigo_check
  check (motivo_codigo in (
    'requested_human','suspected_optout','orcamento_de_ia','low_sentiment',
    'low_confidence','critical_stage','legal_mention','refund_mention',
    'caso_escalado','verificacao_manual','restricao_comercial'));

notify pgrst, 'reload schema';
