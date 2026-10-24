---
impacto: nada_mudou
secao: corrigido
titulo: O ChatGPT por assinatura que estoura a janela de uso com HTTP 400 passa a cair na chave de reserva
---

O ChatGPT por assinatura avisa que a janela de uso acabou com um HTTP 400 ("Subscription Sharing usage limit"), e esse 400 era lido como erro do nosso pedido: a chave de reserva nem era tentada.

Agora, com a chave openai da organização cadastrada como reserva, a chamada é refeita nela e o agente segue respondendo.

Sem chave de reserva, o turno ainda falha como antes; a passagem automática para um humano nesse caso continua pendente na #3371.

Contribuição de @webtecnica (#3374).
