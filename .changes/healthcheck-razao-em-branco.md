---
impacto: nada_mudou
secao: corrigido
titulo: O diagnóstico passa a mostrar por que o agente de atualização falhou, em vez de uma linha em branco
---

Quando o agente que faz a atualização pela tela falhava ao falar com o app, o
`bash hostgator-setup-kit/healthcheck.sh` avisava "o agente falhou recentemente
ao falar com o app:" e, no lugar do motivo, mostrava uma linha vazia. Isso
acontecia sempre que a resposta recebida terminava em quebra de linha (por
exemplo, o "no available server" de um proxy na frente do app).

Agora o diagnóstico mostra a última falha registrada numa linha: a hora, o
endereço chamado, a resposta e o código HTTP. Uma resposta longa (uma página de
erro HTML, por exemplo) aparece cortada em 300 caracteres, em vez de encher a
tela. Nada precisa ser feito na VPS.
