---
impacto: nada_mudou
secao: alterado
titulo: A resposta do agente com Anthropic custa menos — os passos do laço de ferramentas leem do cache
---

Numa resposta com ferramentas, cada passo reenviava ao provedor o contexto do
cliente, o histórico e os resultados dos passos anteriores a preço cheio. Com
Anthropic, esse trecho passa a ir para o cache de 5 minutos, e o passo seguinte o
lê de lá. O agente vê exatamente o mesmo conteúdo; muda só o que se paga. Medido
numa instalação real antes da mudança: 46% do custo de cada resposta era esse
trecho reenviado.
