---
impacto: nada_mudou
secao: corrigido
titulo: A busca das respostas rápidas e da menção passa a achar o nome mesmo quando o acento está só de um lado
---

Duas buscas do campo de mensagem da Inbox comparavam o texto digitado com `includes`, e acento é outra letra para ele: quem digitava `/orcamento` não achava a resposta "Orçamento", e `@andreia` não achava a colega "Andréia". As duas passam a usar a mesma régua de acento da busca da Inbox e da janela Encaminhar (`termoSemAcento`), e a comparação normaliza os dois lados: **quem digita com acento também acha o nome cadastrado sem acento**. O texto exibido não muda — os títulos das respostas e os nomes da equipe continuam como estão cadastrados, com acento, e é esse nome que vai gravado na nota. Caixa (maiúscula e minúscula), busca vazia (mostra a lista inteira), termo sem resultado (lista vazia) e a ordem dos itens continuam como antes, e o atalho das respostas rápidas (`/preco`, `/orcamento`) segue funcionando. Nenhuma configuração muda. Contribuição de @webtecnica (#4070, #4071).
