---
impacto: nada_mudou
secao: corrigido
titulo: O controle Confidence threshold sai do editor de agente — ele não controlava nada
---

Na aba RAG do editor de agente havia um campo "Confidence threshold (0–1)" que prometia passar a conversa para uma pessoa quando a resposta ficasse abaixo do limiar. Ele gravava o valor, mostrava "salvo" e não mudava nada: o único trecho do produto que lia esse número era um bloco do motor antigo que não roda mais desde 07/09. Quem editava um agente de voz mexia num botão que não controlava nada. O campo saiu da tela e o número saiu do formulário; o motor antigo, se algum dia voltar, segue com o limiar que ele já usava quando o campo estava vazio. Nada muda na operação de quem usa o produto hoje.

Contribuição de @webtecnica.
