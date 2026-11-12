---
impacto: capacidade_nova
secao: alterado
titulo: Um só catálogo de variáveis {{...}} para automação, follow-up, campanha e resposta rápida
---

A mesma frase escrita com `{{...}}` saía diferente dependendo da tela. Com o texto `{{saudacao}}, {{primeiro_nome}}! Seu pedido chegou.` e o mesmo contato, a automação e o follow-up mandavam `, Ana! Seu pedido chegou.` (a saudação virava vazio e a vírgula ficava órfã), a resposta rápida mandava `{{saudacao}}` literal para o cliente, e só a campanha escrevia `Boa tarde, Ana! Seu pedido chegou.`

Agora as quatro telas leem a variável do mesmo jeito. Cada uma mantém o que já fazia quando falta o dado (deixar vazio, tirar da frase, deixar a marcação à vista ou pular o envio na campanha), mas `{{saudacao}}` passa a sair também na automação, no follow-up e na resposta rápida, e o formato de data `{{campo|data}}` vale nas quatro.

Na automação, no follow-up, na campanha e nas respostas rápidas, o campo da mensagem ganha o botão "Inserir variável", com busca e grupos, que mostra as variáveis que aquela tela entende e os campos do funil, e uma prévia do texto com um contato de exemplo. Na automação ele substitui os três botões fixos de antes (Nome, Telefone e Título do lead). No passo de modelo aprovado do follow-up, a variável do modelo pode vir de "Variável do sistema". Mensagens já gravadas não precisam ser reescritas e nada muda na VPS.

Contribuição de @webtecnica (#3687).
