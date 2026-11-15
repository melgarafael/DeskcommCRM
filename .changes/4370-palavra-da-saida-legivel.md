---
impacto: nada_mudou
secao: corrigido
titulo: O texto da opção de parar da campanha não aceita mais a palavra riscada, escondida ou em código
---

Na campanha de prospecção, o texto próprio da opção de parar precisa trazer a palavra que a pessoa responde para sair. Antes, bastava a palavra estar no texto: escrita riscada (`~PARAR~`), atrás de spoiler ou entre crases, ela passava, e no celular do cliente chegava apagada ou escondida. Agora a campanha recusa esse texto ao salvar, com um aviso que diz para tirar a marcação de cima da palavra. Negrito e itálico continuam valendo, e o til de "cerca de" (`~R$ 50`) não conta como riscado. Uma campanha que já estava salva com a palavra escondida passa a enviar a frase padrão de saída no lugar do texto próprio, até o texto ser corrigido. Nada a fazer na VPS. Contribuição de @webtecnica (#4647, #4370).
