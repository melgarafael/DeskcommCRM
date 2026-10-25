---
impacto: capacidade_nova
secao: adicionado
titulo: O funil de entrada escolhe em que etapa a conversa nova do Inbox vira card
---

Até aqui, a conversa nova do Inbox virava card sempre na primeira etapa aberta do funil padrão, e separar quem *chegou* de quem *está sendo atendido* dependia de arrastar o card à mão. Agora, em **Configurações › Funis**, a edição do funil de entrada (o marcado como padrão, e também o funil de clientes) tem **Novas conversas do Inbox entram em…**, com as etapas abertas daquele funil (nem arquivada, nem ganho, nem perdido) e o item **Primeira etapa do funil (padrão)**.

Quem não mexe em nada continua igual: sem escolha, o card nasce na primeira etapa, como sempre. Se a etapa escolhida deixar de valer — arquivada, apagada ou fechada —, o card **não deixa de nascer**: ele cai na primeira etapa, a tela do funil mostra um aviso dizendo isso e o servidor registra no log. Voltar ao padrão não esquece a etapa escolhida, então religar é um clique.

Não é preciso mexer em nada na VPS: o ajuste mora nas configurações do funil e não há mudança de banco. Contribuição de @webtecnica (#3250, issue #3011).
