---
impacto: nada_mudou
secao: corrigido
titulo: O media-derive-worker não grava mais transcrição em mensagem já anonimizada
---

O `media-derive-worker`, ao derivar a transcrição (áudio/OCR) de uma mídia,
gravava o resultado final com um UPDATE que não considerava que a mensagem
pudesse ter sido redigida no ínterim. Na corrida `lê → anonimiza → grava`, a
cascata LGPD já tinha zerado o `body` da mensagem, mas o worker regravava o
`media_derived_text` ali — o token mais sensível (o texto do áudio/OCR). A
varredura diária (passo 9 de `lib/lgpd`) só conserta em D+1.

Agora o UPDATE final traz a guarda `body IS DISTINCT FROM '[mensagem anonimizada]'` no WHERE
do PostgREST e confere o resultado da escrita: se a anonimização redigiu a
mensagem entre a leitura e a gravação, zero linhas são casadas e nada é
gravado — o worker responde `skipped`/`message_redacted` em vez de afirmar
sucesso sobre uma escrita recusada.

Refs #1991.

Contribuição de @webtecnica (#2030).
