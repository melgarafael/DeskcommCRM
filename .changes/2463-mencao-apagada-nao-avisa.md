---
impacto: nada_mudou
secao: corrigido
titulo: Menção apagada numa nota interna deixa de avisar a pessoa
---

Numa nota interna, a lista de menções era um histórico do que já tinha sido clicado: apagar
o trecho `@Ana Lima` tirava o nome do texto, mas a escolha continuava guardada e a nota
salva levava o id de quem não estava mais lá. Com duas pessoas de mesmo nome cadastrado,
o caso ficava pior — apagar a primeira menção de duas deixava o aviso para a primeira, e a
segunda, que era a que continuava escrita, não recebia nada.

Agora a lista de menções é derivada do texto, a cada tecla: cada escolha guarda a posição
onde foi escrita, e apagar aquele trecho tira a pessoa da lista e do aviso. Quem ficou no
texto continua recebendo; quem foi apagado não recebe mais nada. A nota já gravada não
muda — o que era texto continua texto.

Contribuição de @webtecnica (#2463).
