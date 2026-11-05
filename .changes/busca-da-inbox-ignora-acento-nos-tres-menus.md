---
impacto: nada_mudou
secao: corrigido
titulo: A busca das respostas rápidas, da menção e do encaminhamento passa a achar o nome mesmo quando o acento está só de um lado
---

Três buscas da Inbox comparavam o texto digitado com `includes`, e acento é outra letra para ele: quem digitava `/orcamento` não achava a resposta "Orçamento", `@andreia` não achava a colega "Andréia" e `joao` não achava a conversa de "João". As três passam a usar a régua de acento que o módulo de busca da Inbox já tinha (`termoSemAcento`), e a comparação normaliza os dois lados: **quem digita com acento também acha o nome cadastrado sem acento**. O texto exibido não muda — os títulos, os nomes da equipe e os rótulos das conversas continuam como estão cadastrados, com acento. Caixa (maiúscula e minúscula), busca vazia (mostra a lista inteira), termo sem resultado (lista vazia) e a ordem dos itens continuam como antes, e o atalho das respostas rápidas (`/preco`, `/orcamento`) segue funcionando. Nenhuma configuração muda. Contribuição de @webtecnica (#4070, #4071, #4072).
