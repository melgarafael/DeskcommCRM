---
impacto: nada_mudou
secao: corrigido
titulo: O registro do turno adiado deixa de aparecer como falha interna
---

Quando o agente adiava um turno (limite de envio, fora da janela de horário, envio vetado ou passagem para uma pessoa), a consulta de registros de turno da API mostrava o código `internal_error`, o mesmo de uma falha de verdade. Agora mostra `job_settled`, e dá para separar o turno adiado do defeito. Nada muda na VPS. Crédito: @webtecnica.
