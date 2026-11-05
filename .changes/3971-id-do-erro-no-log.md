---
impacto: nada_mudou
secao: corrigido
titulo: O ID que o aviso de erro mostra sempre existe no log do servidor
---

Quando uma chamada à API falhava, a tela mostrava `ID: <uuid>` e a orientação era procurar esse ID no log. Na prática ele quase nunca estava lá: só cerca de 1 em cada 5 rotas gravava o próprio `requestId`, e quando a rota não passava um, o `fail()` gerava um UUID novo só para o cabeçalho — um ID que não existia em lugar nenhum.

Agora o ID é resolvido uma vez e é o mesmo nos dois lugares: toda resposta de erro **5xx** que passa pelo `fail()` grava uma linha de log com esse ID, o código e o status. As rotas que já registravam o próprio erro antes de responder continuam com uma linha só — a delas, que traz a causa e a organização; a linha genérica do `fail()` não é duplicada. Recusas **4xx** continuam sem log, porque são esperadas e encheriam o log justamente onde ele precisa ser lido.

Havia uma segunda causa, achada na prova pela tela: o filtro que roda antes de toda requisição gravava o próprio ID na resposta, e esse valor vencia o da rota. Sob `/api/`, o `X-Request-Id` da resposta agora é o que a rota grava no log e na auditoria; nas demais páginas ele continua saindo como antes. Por isso, sob `/api/`, só as respostas que passam pelo `ok()`/`fail()` levam o `X-Request-Id` (as poucas rotas que montam a resposta à mão, como a verificação de saúde, os webhooks de entrada e os retornos de login de integrações, ficam sem ele até serem migradas), e o `X-Request-Id` que um integrador manda só volta quando é um UUID e a rota usa esse id; nas demais, volta o id que a rota usou, que é o que está no log.

O aviso genérico «Erro inesperado. Tente novamente.» também passou a mostrar o `ID:` quando o erro traz um. O corpo das respostas não mudou, e nada precisa ser feito na instalação. Crédito: @webtecnica (#3991).
