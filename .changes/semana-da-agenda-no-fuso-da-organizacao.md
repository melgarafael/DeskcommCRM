---
impacto: nada_mudou
secao: corrigido
titulo: A semana que a Agenda abre passa a ser a do fuso da ORGANIZAÇÃO, em teste que pina a borda do sábado à noite (regressão da #1350)
---

A Agenda desenhava a primeira semana no relógio do PROCESSO do servidor (UTC, no
contêiner). Das 21h de sábado à meia-noite no fuso da organização — o Brasil
inteiro e todo o mundo a oeste de UTC — o servidor já tinha virado domingo e
abria a semana SEGUINTE, com os compromissos dela; a tela saltava para a semana
certa só na hidratação.

O conserto (já em `main`, nos PRs #1353 e #1386) resolve a semana no fuso da
ORGANIZAÇÃO por `semanaSemente(agora, fuso)`, com o `agora` injetado, e o
cliente ancora na mesma data via prop. Esta mudança adiciona o teste que pina
exatamente a borda que abriu a issue: com o instante fixo em `2026-09-20T00:00:00Z`
(domingo para o UTC, ainda sábado para a organização), a semente devolve a
semana do sábado (13–19) e o discriminador é explícito (`SP != UTC`) — o caso é
verde em qualquer dia e em qualquer fuso do runner, e reprovaria se alguém
voltasse a calcular a semana sem ler o fuso pedido.

Refs #1350.

Contribuição de @webtecnica (#2046).