---
impacto: nada_mudou
secao: corrigido
titulo: A ajuda de "esperar a resposta por" no follow-up voltava a português mesmo em espanhol
---

O texto de ajuda do campo "Esperar a resposta por (minutos)" (nos construtores de
classificação e de resposta correspondida do fluxo de follow-up) era uma string pronta em
português — composta uma vez, no idioma do arquivo, citando o rótulo da aresta e o mínimo em
minutos. Com o idioma em espanhol, ela continuava aparecendo em português, porque nunca
passava por `t()`: só existia como texto fixo.

Virou uma função que compõe a frase no idioma de quem está olhando, citando o mesmo rótulo
traduzido que a aresta mostra no canvas do fluxo. Nenhum comportamento muda para quem usa
português.
