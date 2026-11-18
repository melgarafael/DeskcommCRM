---
impacto: nada_mudou
secao: corrigido
titulo: Faturar em lote não grava mais a comanda na empresa errada
---

Quem participa de mais de uma empresa (ou é administrador da plataforma) podia faturar em lote um atendimento de outra empresa: a tela mostrava o atendimento e o clique criava, na empresa ativa, uma comanda finalizada com item, comissão e um lançamento pago no caixa — dinheiro de um serviço prestado na outra empresa, e o atendimento de origem continuava pendente lá, pronto para ser cobrado de novo.

Agora o lote só enxerga os atendimentos da empresa ativa. Se algum atendimento do lote for de outra empresa, o lote inteiro é recusado com uma mensagem que diz quantos ficaram de fora e nada sobre eles — nem nome, nem valor, nem de qual empresa são —, e nada é gravado. O mesmo vale quando o cliente do atendimento é de outra empresa.

A finalização da comanda também passou a conferir a empresa do atendimento e a do cliente antes de gravar comissão e lançamento, fechando o mesmo caminho para quem chama a finalização pelo balcão ou direto pela API.

Contribuição de @webtecnica, a partir da issue #4845.
