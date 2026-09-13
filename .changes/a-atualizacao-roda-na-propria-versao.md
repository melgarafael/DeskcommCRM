---
impacto: capacidade_nova
secao: corrigido
titulo: A atualização passa a ser executada pela própria versão que está instalando
---

Medido numa instalação real: uma versão trouxe uma pausa dos serviços antes de mexer no banco, e depois de atualizar as peças que deviam ter parado estavam de pé havia mais de duas horas. **A pausa não rodou.**

A causa não era daquela entrega — é de como a atualização sempre funcionou. Ela carrega os próprios ajudantes na **primeira linha**, e só baixa o código novo alguns passos depois. Quem executava a atualização era sempre a versão **anterior**, aplicando o banco da versão nova.

O efeito, escrito sem rodeio: **toda correção no instalador chegava um update atrasada**. A versão que traz o conserto era instalada pela versão que ainda tem o defeito.

Havia uma segunda aresta na mesma pedra: baixar o código novo **troca o arquivo do script enquanto ele está sendo lido**. O interpretador acompanha o arquivo por posição, e um arquivo de tamanho diferente faz a leitura continuar no meio de uma linha. Nunca quebrou por sorte, não por desenho.

Agora, logo depois de baixar o código novo, a atualização **recomeça na versão nova** — sem refazer o backup, sem repetir passos na tela e sem risco de laço.

Nada muda para quem opera: o botão é o mesmo e nenhum passo manual foi acrescentado.
