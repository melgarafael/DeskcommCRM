---
impacto: nada_mudou
secao: corrigido
titulo: A conversa encerrada volta a reabrir quando a mensagem do cliente chega atrasada
---
Quando a mensagem do cliente chega ao número de atendimento depois de a conversa
ter sido encerrada, mas com o horário de envio anterior ao encerramento — o
comum em entrega atrasada do canal, em lote do provedor ou com o relógio do
aparelho do cliente atrás —, a conversa voltava a ficar encerrada com a mensagem
dentro dela. A aba Fila não a mostrava, e o atendente perdia o cliente sem que
nada aparecesse como erro em lugar nenhum. Agora a conversa reabre e volta para
a Fila, independentemente da ordem em que a mensagem chegou; o horário original
continua sendo o que ordena a conversa e o que marca o começo do novo
atendimento. Reenvio da mesma mensagem pelo canal não abre atendimento novo, nem
uma segunda mensagem atrasada da mesma conversa reabre duas vezes. Na
atualização não há nada a fazer. Crédito: @webtecnica.
