---
impacto: nada_mudou
secao: corrigido
titulo: A mensagem que chega pelo tempo real entra no fim da conversa, com o nome de quem enviou
---

No Inbox, a conversa aberta recebe a mensagem pelo tempo real sem pedir a lista de novo — mas a linha nova entrava no COMEÇO do fio, acima do histórico, enquanto a tela desenha da mais antiga para a mais nova: a mensagem que a pessoa acabou de enviar aparecia no lugar errado. Agora ela entra no fim, onde o envio pelo campo de texto já a punha.

Duas correções vieram junto, na mesma janela de meio segundo entre o evento e a resposta do envio: o balão otimista (`temp-…`) continua visível enquanto a mensagem real chega pelo canal, em vez de a mesma mensagem aparecer duas vezes até o `POST` responder; e o balão volta a dizer **quem** da equipe enviou — o nome é do campo derivado que só a rota preenchia, e o evento do canal passa a herdá-lo do próprio fio e da sessão de quem está na conversa. Quem não tem nome resolvido continua em "Atendente", que é a informação verdadeira.

Crédito: @webtecnica (#4325, #4504).
