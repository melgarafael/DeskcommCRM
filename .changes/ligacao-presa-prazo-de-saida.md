---
impacto: nada_mudou
secao: corrigido
titulo: Ligação que ficava tocando para sempre agora tem prazo de saída
---

Quando o aviso de que a ligação caiu não chegava — worker de voz reiniciando ou
fora do ar naquele instante —, a chamada ficava em "tocando" na tela de Chamadas
para sempre, sem nada que a destravasse. Agora o CRM varre de 5 em 5 minutos e
encerra a ligação que está tocando há mais de 15 minutos, gravando o motivo
"encerrada por prazo, sem evento de queda" — quem abrir a ligação depois vê que
não foi o cliente que desligou. O prazo é a variável `VOICE_CALL_STUCK_AFTER_MIN`
(vazio = 15 minutos); **aumente-a se o seu tronco toca por muito tempo**. A
ligação **já atendida nunca é encerrada por idade**, e as que ficaram presas
antes da atualização são destravadas sozinhas na primeira varredura: nada a fazer
à mão.
