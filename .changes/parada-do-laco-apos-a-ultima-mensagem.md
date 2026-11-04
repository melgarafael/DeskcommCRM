---
impacto: capacidade_nova
secao: adicionado
titulo: Opção para o agente encerrar o atendimento logo após a última mensagem (desligada por padrão)
---

Depois de responder ao cliente, o agente chama o modelo mais uma vez só para encerrar o turno. Essa chamada não produz nada e, no turno medido, gasta cerca de metade dos tokens de entrada da chamada principal do agente (perto de 38% dos tokens do turno inteiro). A variável `AGENT_STOP_AFTER_FINAL_SEND` permite pular essa chamada quando o próprio modelo declara que a mensagem enviada é a última. O agente não pula a chamada se a mensagem anuncia algo que ainda não foi feito, como passar para a equipe, agendar um retorno ou verificar a agenda.

O padrão é `off`, que mantém tudo como antes. `observe` só registra no traço do turno se o modelo marcaria a mensagem como final, sem mudar o laço, e serve para a avaliação descrita em `docs/runbooks/parada-apos-envio.md`. `on` liga a parada. A opção vale só para resposta a mensagem do cliente. Follow-up, resposta de caso, rascunho assistido e o "Testar" não mudam. Para mudar o valor, edite o `.env` e reinicie o worker.
