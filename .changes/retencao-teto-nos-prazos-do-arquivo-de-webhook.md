---
impacto: nada_mudou
secao: corrigido
titulo: Os dois prazos do arquivo de webhooks ganham o teto de 36500 dias
---

Um `WEBHOOK_LOG_BODY_RETENTION_DAYS=9999999` no `.env` virava um corte em
`-025353-09-14` no DELETE da poda do arquivo de webhooks — uma data que ia ao
PostgREST como corte da poda — e um número ainda maior (`1e9`) lançava
`RangeError: Invalid time value` na montagem da data, derrubando a rodada do
cron `webhook-log-retention`. Os dois prazos do arquivo de webhooks
(`WEBHOOK_LOG_BODY_RETENTION_DAYS` e `WEBHOOK_LOG_ROW_RETENTION_DAYS`) eram os
últimos sem teto: os demais já passavam pelo teto de 36500 dias (100 anos) da
política de retenção. Agora esses dois também: um valor acima do teto é
trocado pelo teto e o boot avisa no log que o número escrito não foi usado,
enquanto um valor dentro do intervalo passa intacto. Nada precisa ser feito ao
atualizar. Contribuição de @webtecnica (#2623, issue #2612).
