---
impacto: nada_mudou
secao: corrigido
titulo: Oferecer atendimento humano depois de um "Entendi!" não abre mais caso automático
---

Quando o agente só pergunta se o cliente quer falar com a equipe ("Quer que eu encaminhe para a equipe?"), isso não é promessa de atendimento humano, e a mensagem já não exigia caso aberto. Mas bastava uma abertura curta antes da pergunta, como "Entendi! Quer que eu encaminhe para a equipe?", para a pergunta ser lida como promessa: o envio era vetado e, na segunda tentativa, o sistema abria um caso automático e mandava ao cliente a frase fixa de passagem para humano, sem ninguém ter pedido. Agora uma abertura que seja só reconhecimento, de uma lista curta e fechada ("Entendi", "Certo", "Claro", "Ok", "Combinado", "Anotado", "Perfeito", "Beleza", "Tudo bem", "Tudo certo", "Sem problema", ou duas delas separadas por vírgula), não derruba mais a isenção da pergunta.

Qualquer outra frase antes ou depois da pergunta faz a mensagem ser conferida inteira, como antes. Por isso "Entendi! Vou anotar aqui. Quer que eu encaminhe para a equipe?" ainda abre caso: é o lado seguro, e toda promessa que já era vetada continua vetada. "Pode deixar" e "Fica tranquilo" ficaram fora da lista porque soam como garantia. O texto da frase fixa e o resumo do caso automático, que a #3725 também pede, não mudaram. Nada muda na VPS: a correção chega pela atualização normal.

Crédito: @webtecnica.
