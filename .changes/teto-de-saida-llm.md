---
impacto: nada_mudou
secao: corrigido
titulo: A IA não pede mais o máximo de tokens do modelo em cada resposta
---

Quando a organização não definia um limite de tamanho de resposta, a chamada ao modelo saía sem
limite nenhum. No OpenRouter isso reserva o máximo do modelo (64 mil tokens no Claude Haiku 4.5)
contra o saldo da chave, e uma chave com crédito para milhares de respostas curtas recusava todas
com "can only afford". O agente parava de responder e as sugestões do modo assistido falhavam.
Agora, sem limite configurado, cada resposta pede no máximo 4.096 tokens; quem definiu um limite
próprio continua com o dele.
