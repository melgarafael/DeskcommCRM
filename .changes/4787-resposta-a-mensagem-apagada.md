---
impacto: nada_mudou
secao: corrigido
titulo: A conversa não oferece mais "Responder a esta mensagem" para a mensagem que o contato apagou, e o servidor recusa o envio que a cita
---

Na conversa, o menu de uma mensagem que o contato apagou continuava com "Responder a esta mensagem" — Encaminhar, Reagir e Baixar já saíam do menu, e essa ação ficava. Quem clicasse veria a citação de um texto que estava fora do ar, e a resposta levava ao canal uma referência a uma mensagem que não existe mais do outro lado. Agora a ação não aparece na mensagem apagada, assim como as outras três.

O servidor passou a recusar o envio com citação a uma mensagem apagada, com erro nomeado e frase que diz o que fazer: a resposta sai sem citá-la. Isso vale também quando a citação foi escolhida antes da exclusão — o contato apaga, o id continua no campo, e o envio é recusado antes de qualquer chamada ao canal. O texto escrito continua no campo, a citação é retirada e basta enviar de novo.

Nada muda para a mensagem que não foi apagada: citar continua funcionando igual. O texto retido de uma mensagem apagada pelo contato continua legível para os perfis autorizados na empresa, pela mesma porta de sempre. Nenhuma ação é necessária na atualização.

Contribuição de @webtecnica (#4787).
