---
impacto: nada_mudou
secao: corrigido
titulo: O visto azul chega ao cliente também nas conexões por QR sem "Guardar histórico"
---

Nas conexões por QR Code (WAHA NOWEB) com "Guardar histórico" desligado, que é o padrão, o cliente ficava nos dois tiques cinza depois da resposta do agente ou do atendente. O pedido de "li a conversa" saía sem dizer quais mensagens, e o WAHA sem histórico guardado recusava esse pedido com erro 400. Como a marcação falha sem barulho, nada aparecia na tela.

Agora a resposta diz ao canal quais mensagens do cliente ela está lendo: as que chegaram depois do último envio que saiu de verdade (sem reações e mensagens de sistema, até 30). Com esses ids o WAHA marca a leitura sem precisar do histórico guardado. Quando não há mensagem nova do cliente, como na segunda bolha da mesma resposta, nenhum pedido de visto sai. Grupos continuam sem visto. Envios que chamam o canal sem passar pelo envio de mensagens do CRM continuam pedindo como antes.

Contribuição de @yunshu0909, a partir da issue #5015.
