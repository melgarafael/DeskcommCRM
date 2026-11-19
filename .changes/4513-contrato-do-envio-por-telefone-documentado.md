---
impacto: nada_mudou
secao: alterado
titulo: O contrato do envio por telefone está escrito para quem escreve o conector
---

A rota `POST /api/v1/messages` aceita `phone_number` no lugar de
`conversation_id` desde a versão anterior, mas isso só se descobria lendo a
rota. Quem escreve o conector — hoje o `deskcomm` do DeskVoice — copiava o
formato antigo (`{ to, text, callId }`), mandava `callId` no topo e via o id da
ligação desaparecer em silêncio.

O guia `docs/integracao/envio-de-mensagem-por-telefone.md` passa a descrever os
dois modos, a tradução do corpo do conector (`to` → `phone_number`, `text` →
`body`, `callId` → `metadata.call_id`), a tabela de recusas com os códigos que se
tratam, o que a `Idempotency-Key` cobre nas 24 h, e o que o contrato
deliberadamente NÃO faz (canal explícito e recusa de número de outra
organização continuam decisão do mantenedor). Nenhuma rota, schema ou resposta
mudou; uma cerca nova confere cada valor do guia contra o código que o cumpre.
