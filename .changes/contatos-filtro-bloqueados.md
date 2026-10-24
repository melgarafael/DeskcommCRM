---
impacto: capacidade_nova
secao: adicionado
titulo: A API de contatos filtra quem pediu para não ser incomodado
---

`GET /api/v1/contacts` e a exportação (`/api/v1/contacts/export`) aceitam `?blocked=yes` (só quem pediu para sair — o opt-out do titular) e `?blocked=no` (só quem não pediu). Até aqui o bloqueio aparecia só como marca em cada contato, e para listar quem pediu para sair era preciso percorrer todos. O filtro responde só pelo opt-out: a lista de exclusão de campanha, os contatos anonimizados e quem recusou só o atendimento da IA não entram nele. Sem o parâmetro, a lista segue igual; um valor diferente de `yes`/`no` responde 422.
