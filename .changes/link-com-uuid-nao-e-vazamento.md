---
impacto: nada_mudou
secao: corrigido
titulo: Link do cliente com UUID não é confundido com vazamento de vocabulário interno
---
O detector de vocabulário interno passa a ignorar UUIDs que façam parte de uma
URL ou endereço, preservando links legítimos de portais e formulários com
identificadores no caminho. Identificadores opacos soltos no corpo da mensagem
continuam sendo barrados normalmente.

Contribuição de @ararquitetura.
