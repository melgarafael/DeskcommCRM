---
impacto: nada_mudou
secao: corrigido
titulo: Link do cliente com UUID não é confundido com vazamento de vocabulário interno
---
O detector de vocabulário interno passa a ignorar o UUID que faz parte de um
link `http(s)://`, para que links legítimos de portais e formulários com o
identificador no caminho cheguem ao cliente. O UUID solto no corpo da mensagem,
num caminho sem esquema ou colado a um «@», continua sendo barrado.

Contribuição de @ararquitetura (do #4951).
