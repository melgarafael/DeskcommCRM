---
impacto: capacidade_nova
secao: corrigido
titulo: "Enviar link ao cliente" para de travar 20 segundos e passa a dizer por que recusou
---

Quando "Enviar link ao cliente" recusava, a tela dizia só **"Erro inesperado"** e o registro do servidor gravava sempre a mesma palavra — o sistema sabia o motivo e o apagava ao anotá-lo. Uma investigação inteira não achou nada nos registros por causa disso.

Agora cada recusa tem nome e explicação própria: o atendimento mudou de conversa, o compromisso foi remarcado, há um conflito que precisa de escolha. E quando a recusa é definitiva, a tela **para de convidar a tentar de novo**.

O link da reunião nunca entra no registro, mesmo quando vem dentro da mensagem de erro.
