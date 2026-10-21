---
impacto: capacidade_nova
secao: adicionado
titulo: Campo personalizado pode exigir um formato, com a frase de erro que você escrever
---
Um campo personalizado do funil pode ganhar duas propriedades opcionais: `padrao` (o formato esperado, como expressão regular) e `mensagem_padrao` (a frase que aparece para quem digitar fora dele). O formato é conferido no formulário (que mostra a frase sob o campo e não salva), na API (que responde 422 com a mesma frase) e na gravação pelo assistente de IA (que pergunta de novo ao cliente em vez de gravar o valor torto). Ao editar uma ficha, só o valor que muda é conferido: trocar outro dado não é barrado por um campo antigo que você não tocou. Pelo mesmo motivo, transferir, clonar ou retomar um negócio leva os valores que ele já tinha sem conferi-los de novo no funil de destino. Um formulário de captação que manda um valor fora do formato não perde o lead: o negócio nasce com o valor como veio, e o formato passa a ser cobrado quando alguém editar esse campo. Sem as propriedades, nada muda. Nada a fazer na atualização.

Contribuição de @webtecnica (#2814), a partir da issue #2730.
