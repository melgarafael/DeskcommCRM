---
impacto: nada_mudou
secao: corrigido
titulo: Os relatórios de Perdas e da análise do funil contam além de 1.000 negócios e avisam quando passam do limite
---

Em Métricas, o relatório de Perdas e a análise do funil (`GET /api/v1/metrics/funil`)
liam no máximo 1.000 linhas por consulta, sem avisar. Num mês com mais de 1.000
negócios perdidos, o total, os motivos e os valores somavam só os 1.000 mais
recentes, e o aviso "Cortado no limite de leitura." nunca aparecia. No funil, as
leituras ainda saíam sem ordem, e o pedaço lido podia mudar de uma consulta para
outra.

Agora os dois relatórios leem tudo o que está no período, até 5.000 linhas por
leitura, sempre do mais recente para o mais antigo. Acima disso, a resposta diz
que foi cortada, e a tela de Perdas mostra o aviso. Nada precisa ser feito ao
atualizar.

Contribuição de @webtecnica (#2560), a partir da issue #2548 de @hudson-souza-mkt.
