---
impacto: nada_mudou
secao: corrigido
titulo: O resumo que o agente grava ao fim de cada resposta pede uma correção antes de repetir a resposta inteira
---

Ao terminar cada resposta, o agente grava um resumo em JSON (compromissos,
objeções, próximo passo). Quando esse JSON vinha fora do formato — medido com
um modelo barato no ponto «Fechar o atendimento», que às vezes acrescentava um
campo —, a fila repetia a resposta INTEIRA, a chamada principal do agente
incluída: até 3 vezes numa mensagem, pelo preço de três respostas. Agora o
sistema devolve o JSON recusado ao modelo, dizendo o que estava errado, numa
segunda chamada só do resumo. A resposta inteira só se repete se a correção
também vier fora do formato, como antes. Isso torna seguro usar um modelo
barato em «Fechar o atendimento».
