---
impacto: nada_mudou
secao: corrigido
titulo: O erro de envio no inbox para de sair da tela
---

Quando o provedor recusava uma mensagem, o inbox mostrava o motivo num balão de uma linha só: o texto do provedor é longo, o balão crescia para a direita e o fim da frase ficava fora da tela — em 1280, 1366 e em 1440 px. O operador via "Falhou" e um começo de explicação, sem o resto, que é justamente a parte que diz o que fazer.

O balão agora quebra em várias linhas dentro de uma largura máxima. A correção foi feita na classe base do balão, e não no ponto que mostrou o defeito: assim vale para todo balão do produto, inclusive os que mostram texto que vem de fora (a mensagem de erro do provedor, que não está no código e não tem tamanho previsto). Nada muda para os balões curtos.

Crédito: @webtecnica.
