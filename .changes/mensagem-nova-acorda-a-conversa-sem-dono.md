---
impacto: capacidade_nova
secao: alterado
titulo: Conversa sem responsável volta para a distribuição quando o cliente escreve de novo
---

O pedido de distribuição de uma conversa nascia em um lugar só: no momento em que
ela era criada sem responsável. Uma conversa que já existia e continuava sem
dono **não pedia nada quando o cliente escrevia outra vez** — ela só voltava para
a fila pelo laço de retentativa do distribuidor, que a reagenda de tempos em
tempos, para sempre.

Agora a mensagem nova do cliente em conversa aberta e sem responsável acorda a
distribuição na hora. Cinco mensagens seguidas continuam sendo **um** pedido só, e
a conversa com dono, encerrada, de grupo, ou em número cuja distribuição está
desligada não pede nada. Nada muda no número de tentativas nem no intervalo entre
elas: a mudança é ter por onde acordar a conversa.
