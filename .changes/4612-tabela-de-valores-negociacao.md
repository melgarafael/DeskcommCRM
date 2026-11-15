---
impacto: nada_mudou
secao: adicionado
titulo: Tabela de valores de negociação: partida e limite por procedimento, importados de planilha
---

O banco passa a guardar uma tabela de valores por organização — procedimento com
código, descrição, valor em US e em reais, com valor de **partida** e valor
**limite** em cada moeda. A importação lê `.csv`/`.xlsx`, devolve a **prévia** do
que entra e do que não entra (com o motivo e o número da linha de cada recusa) e
só grava depois da confirmação; a mesma planilha confirmada duas vezes não entra
de novo, e procedimento repetido não duplica.

Nada muda na tela nesta versão: ainda não há onde abrir a tabela, e o agente
ainda não negocia com ela. A conversa de negociação, o histórico de
contrapropostas e a aprovação acima do limite vêm depois.
Contribuição de @webtecnica (#4643).
