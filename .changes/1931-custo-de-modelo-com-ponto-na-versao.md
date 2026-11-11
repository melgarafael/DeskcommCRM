---
impacto: nada_mudou
secao: corrigido
titulo: O custo das chamadas de IA volta a ser calculado quando o modelo vem com ponto na versão (ex.: claude-haiku-5.5 pelo OpenRouter)
---

Chamadas feitas com um nome de modelo escrito com ponto na versão não achavam a
linha de preço, que é escrita com hífen, e ficavam com o custo em branco nos dois
caminhos que ainda não tratavam essa diferença. Agora o nome com ponto casa com o
preço. Vale para as chamadas novas; as já registradas sem custo não são
recalculadas. Contribuição de @webtecnica, a partir da medição de @mbiero.
