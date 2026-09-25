---
impacto: nada_mudou
secao: corrigido
titulo: A Agenda lembra o tipo de compromisso escolhido depois de recarregar a página
---

Escolher o tipo de compromisso na grade da Agenda morria no recarregamento da página: a tela voltava ao primeiro tipo em ordem alfabética e, quando ele não tinha jornada publicada, mostrava "a jornada de atendimento ainda não foi publicada" para quem estava olhando outro tipo. A escolha passa a ficar na URL (`?tipo=`), no mesmo formato do `?id=` da Inbox — o link aberto em outra aba chega com o mesmo tipo selecionado, e fechar o detalhe de um compromisso não apaga mais a escolha. Quem não escolhe nada continua vendo o primeiro tipo, como sempre. Não há ação para quem opera a VPS.

Contribuição de @webtecnica (#1669).
