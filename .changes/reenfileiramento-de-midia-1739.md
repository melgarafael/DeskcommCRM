---
impacto: nada_mudou
secao: corrigido
titulo: Mídia já removida pode ser enfileirada de novo e a fila deixa de crescer sem teto
---

A fila de remoção de mídia guarda cada arquivo por `object_path` e a 0432 pedia
`on conflict (bucket, object_path) do nothing`. Como o worker marca a linha
como `deleted` e a linha nunca sai da fila, um arquivo NOVO gravado naquele
mesmo caminho era ignorado em silêncio: não entrava mais na retenção nem na
anonimização da LGPD, e nenhuma das duas conseguia alcançá-lo depois.

Agora o conflito reabre a linha só quando ela já terminou — `deleted` ou
`skipped` volta a `pending` com as tentativas zeradas — e não toca em `pending`
nem `failed` em curso, que é justamente o `where` que garante isso. O cron
diário de retenção passa também a expurgar linha `deleted` com mais de 90 dias,
para a fila deixar de crescer sem teto. Nada a fazer para quem já roda o
sistema.
