---
impacto: nada_mudou
secao: corrigido
titulo: O dossiê do follow-up não lê mais falha do motor como contato com o cliente
---
Quem abria o dossiê de um follow-up que falhou lia "Última falha … (tentativa 2 de 5)" e podia concluir que o cliente fora procurado duas vezes. Aquela contagem é do motor tentando de novo processar a mesma etapa do fluxo depois de uma falha — quase sempre uma etapa sem saída ligada. O dossiê agora diz "Falha ao processar a etapa … (nova tentativa automática 2 de 5)", o campo "Passos dados" vira "Etapas executadas" e o desfecho sai por extenso ("Encerrado sem conversão") em vez do código cru. Falha de envio pelo canal continua contada à parte e, quando esgota, avisada na Central, como antes. Não é preciso fazer nada na instalação.

Contribuição de @webtecnica (#2081), a partir da issue de @hudson-souza-mkt (#2014).
