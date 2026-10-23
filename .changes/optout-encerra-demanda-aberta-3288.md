---
impacto: nada_mudou
secao: corrigido
titulo: Quando o contato pede PARAR, a demanda aberta dele é encerrada como encerrada pelo cliente
---

Quando o contato pedia para parar de receber mensagens, o opt-out bloqueava o contato e levava os negócios abertos dele para perdido — mas a demanda aberta continuava no Radar acumulando. Numa medição de um dia, a prospecção abriu 26 demandas, a maioria "derivada" sem card que ninguém ia tratar. Agora o mesmo pedido de parar encerra também as demandas ABERTAS daquele contato, com desfecho encerrada_pelo_cliente, pela mesma porta do botão de encerrar da tela (o CAS de revisão, a linha na timeline e a auditoria ficam por conta do banco). Demanda que já estava encerrada não é tocada, e contato sem demanda aberta percorre o caminho sem erro. A origem do encerramento fica registrada como o mesmo ator de sistema que o opt-out já usa. Nada a fazer na atualização.
