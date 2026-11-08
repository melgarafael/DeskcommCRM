---
impacto: nada_mudou
secao: corrigido
titulo: Pedidos de horário que ninguém confirmou voltam a expirar e liberar a agenda
---
A varredura que expira pedidos de agendamento pendentes falhava a cada rodada (erro 500) porque não registrava a data do cancelamento, e o banco recusava. Com isso os pedidos ficavam presos segurando o horário. Agora a expiração grava a data e libera o horário no prazo da organização. Crédito: @felipehenriquess.
