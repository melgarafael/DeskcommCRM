---
impacto: nada_mudou
secao: corrigido
titulo: Retenção, escalação e resposta aprovada usam a janela de RESPOSTA pelo tipo
---

Depois que a janela de RESPOSTA (`channel_knobs.resposta_*`) foi separada da de
DISPARO (`window_*`), três consumidores da IA seguiam avaliando apenas a janela
de disparo: a rota de retenção da conversa, o aviso de escalação e o envio de
resposta aprovada. O resultado era a IA ser tratada como bloqueada (ou escalar)
mesmo com a janela de resposta aberta.

Agora cada caminho decide pelo TIPO do envio: retenção avalia "aberta agora"
como resposta, e escalação e resposta aprovada (que respondem a uma mensagem
recebida) tratam o envio como `resposta: true` — respeitando a mesma herança
coluna a coluna de `effectiveKnobs`. Um teste cobre os três caminhos com a
janela de resposta aberta e a de disparo fechada, provando que a resposta sai.

Refs #1985.

Contribuição de @webtecnica (#2031).