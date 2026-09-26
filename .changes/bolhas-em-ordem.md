---
impacto: nada_mudou
secao: corrigido
titulo: Com "responder em várias mensagens curtas" ligado, cada parágrafo vira uma bolha, na ordem certa
---

A opção do agente "Responder em várias mensagens curtas (como uma pessoa
digita)" dizia ao modelo para preferir várias mensagens a um texto único, e o
modelo mandava duas ou três de uma vez — que podiam chegar ao cliente fora de
ordem (a lista de dados de entrega embaralhada, por exemplo). Agora o agente
escreve uma resposta só e o sistema manda cada parágrafo como uma bolha, na
ordem e no ritmo de quem digita, como a tela já prometia; resposta curta, de
uma ideia só, continua saindo numa bolha só, em vez de virar saudação, resposta
e pergunta em três mensagens. O tamanho máximo por bolha passa a valer só para
o parágrafo que sozinho é longo demais: antes, parágrafos curtos eram juntados
até esse tamanho, e com o padrão quase nenhuma resposta era dividida, enquanto
com um valor baixo o resumo do pedido era cortado no meio de uma linha.
O teto de mensagens por turno (`MAX_SENDS_PER_TURN`, padrão 3) vale também para
as bolhas: o que passar dele segue junto na última, sem perder texto e na ordem.

Contribuição de @jmpo (#1724).
