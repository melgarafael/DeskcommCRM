---
impacto: capacidade_nova
secao: corrigido
titulo: A atualização passa a ser executada pela própria versão que está instalando
---

A atualização carregava os próprios ajudantes **antes** de baixar o código novo. Quem executava era sempre a versão **anterior** — então toda correção no instalador chegava uma atualização atrasada, e a versão que trazia o conserto era instalada pela versão que ainda tinha o defeito.

Havia uma segunda aresta: baixar o código novo trocava o arquivo do script **enquanto ele estava sendo lido**.

Agora, logo depois de baixar o código novo, a atualização **recomeça na versão nova** — sem refazer o backup e sem repetir passos na tela. Nada muda para quem opera: o botão é o mesmo.
