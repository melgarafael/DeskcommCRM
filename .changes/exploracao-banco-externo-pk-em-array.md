---
impacto: nada_mudou
secao: corrigido
titulo: Explorar as tabelas do banco externo volta a funcionar (chave primária vinha em formato errado)
---

Ao abrir uma tabela do banco externo cuja chave primária é uma coluna comum, a tela podia cair num erro em vez de mostrar os dados. A causa era de formato: o sistema lia a chave primária como um texto `{id}` em vez de uma lista de colunas, e a grade nova — que usa a chave para identificar cada linha — tropeçava nisso.

A leitura da chave virou uma lista de verdade (e a tela passou a tolerar o formato antigo, para não quebrar durante a atualização). O mesmo conserto melhora a descrição das tabelas que o agente de IA recebe.

Nada muda na forma de usar: abrir as tabelas do banco externo e ler os dados continua igual, agora sem o erro.
