---
impacto: nada_mudou
secao: alterado
titulo: Respostas rápidas do Inbox em uma linha, com os grupos em popup
---

A barra de respostas rápidas do Inbox empilhava: ela quebrava linha, então cada
resposta a mais virava mais uma linha acima do campo de digitação — e cada grupo
despejava TODAS as suas respostas na mesma área, com um rótulo em cima. Numa
agência com dezenas de respostas e três grupos, a seção comia a altura da
conversa. Medido no Chromium desta VPS, com 3 grupos de 4 respostas: 176px de
altura em 375px de tela, 86px em 768px e 56px em 1280px.

Agora a barra é uma linha só, com rolagem lateral quando não couber, e o grupo
virou um botão com o nome dele: as respostas do grupo abrem num painel flutuante,
o mesmo popup que o compositor já usa. A mesma medição dá 26px nas três larguras
— uma linha —, e o espaço recuperado é da conversa. Resposta sem grupo continua a
um clique, sem popup no caminho; grupo vazio não vira botão.

Quem nunca criou grupo não vê diferença de conteúdo na barra: os mesmos botões,
na mesma ordem, um pouco mais largos porque não quebram mais linha.

Contribuição de @webtecnica (#3875).
