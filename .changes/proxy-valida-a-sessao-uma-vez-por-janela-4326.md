---
impacto: nada_mudou
secao: alterado
titulo: A sessão é conferida uma vez por janela, não em toda requisição
---

Toda requisição que passa pelo portão do app ia ao serviço de autenticação só para confirmar a sessão — inclusive os contadores da casca, que batem a cada 30 segundos, em cada aba aberta. Agora o portão reaproveita por 30 segundos a mesma validação que a tela já reaproveitava: com a sessão intacta, o custo cai de uma ida por requisição para uma por janela. Sair da conta continua derrubando a sessão na hora, e a permissão de administrador de plataforma continua sendo conferida a cada requisição. Nada a fazer na VPS.

Crédito: @webtecnica.
