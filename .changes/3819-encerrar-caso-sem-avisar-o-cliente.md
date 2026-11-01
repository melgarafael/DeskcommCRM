---
impacto: capacidade_nova
secao: adicionado
titulo: Caso que já se resolveu pode ser encerrado sem mandar mensagem ao cliente
---

Na tela do caso aparece uma nova opção: "Encerrar sem avisar o cliente". Ela serve para o caso que perdeu o sentido: o cliente comprou em outro lugar, a reunião já aconteceu, o assunto andou por fora. Antes, a única forma de tirar um caso da fila era responder, e as três respostas mandavam mensagem ao cliente.

A nota é obrigatória e fica só na linha do tempo do caso. O caso passa a cancelado, os avisos do sino daquele caso somem na mesma hora, e nada é enviado ao cliente. A mesma ação existe na API em `POST /api/v1/ai/cases/{id}/close`.

Você não precisa mudar nada.

Contribuição de @webtecnica (#3819, #3810).
