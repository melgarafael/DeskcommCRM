---
impacto: nada_mudou
secao: corrigido
titulo: Um aviso de atualização antiga que falhou não trava mais o botão de atualizar
---

Quando uma atualização feita pela tela falhava e o sistema voltava sozinho para
a versão anterior, a tela de Atualização passava a mostrar "A atualização para a
versão … não deu certo", sem o botão de atualizar. Se depois alguém atualizasse
por outro caminho (o `update.sh` no terminal, por exemplo), o sistema subia
normalmente, mas o aviso antigo continuava ali. Quando saía uma versão nova, a
tela mostrava de novo a falha de dias atrás e não oferecia o botão, e o único
jeito de sair desse aviso era justamente clicar nele. Isso foi medido numa
instalação real: uma falha de 13/09 impedia atualizar para a 1.27.2 pela tela em
15/09, com a 1.23.0 já no ar desde 14/09.

Agora, quando o servidor informa uma versão diferente das duas envolvidas na
tentativa que falhou, a tela entende que a falha foi superada e volta a oferecer
a atualização normalmente. Uma falha que ainda é o estado atual do servidor
continua sendo mostrada como antes, com o comando para voltar.
