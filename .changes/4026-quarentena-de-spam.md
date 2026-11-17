---
impacto: capacidade_nova
secao: adicionado
titulo: O filtro de spam retém a mensagem suspeita numa quarentena, em vez de acordar a equipe
---

Mensagem de entrada que parece golpe — link encurtado, prêmio que ninguém pediu,
"falso suporte" pedindo dados — passa a ficar retida antes de virar trabalho.
Retida, ela **continua gravada e visível** na conversa: nada é apagado e nada sai
da inbox. O que não acontece é a consequência: não abre negócio, não acorda a IA,
não dispara ligação, notificação nem automação.

A fila fica em `/api/v1/quarentena` e mostra a mensagem, o motivo do corte e a
confiança. Quem atende — qualquer pessoa da empresa — vê a fila e libera com um
clique; a liberação roda os efeitos normais, atrasados, nunca perdidos. O filtro
nasce **desligado**: em Configurações › Atendimento, quem administra a empresa
liga o filtro e, se quiser, ajusta o limiar. A resposta da pesquisa de satisfação
é avaliada antes do filtro, para que uma nota "1" não seja confundida com
mensagem curta suspeita.

A tabela `quarentena_de_entrada` guarda o veredito, a confiança e os nomes dos
sinais que produziram o corte — o conteúdo da mensagem continua morando em
`messages`. O contador `perdidas` de `fn_quarentena_resumo` mede linha de
quarentena cuja mensagem não existe mais e tem de ser zero.
