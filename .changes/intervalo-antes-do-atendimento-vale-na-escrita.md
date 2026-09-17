---
impacto: nada_mudou
secao: corrigido
titulo: O intervalo antes do atendimento passou a valer também na hora de marcar
---

Se você configurou um intervalo antes (ou depois) do atendimento — aquele tempo de respiro entre um compromisso e outro —, o vizinho só era levado em conta quando caía dentro do horário consultado. Na hora de MARCAR (pela IA, por token ou por webhook) a conferência olhava só a janela do próprio atendimento, o compromisso vizinho ficava fora dela e o horário era aceito, mesmo invadindo o intervalo que você pediu para guardar; e a lista de horários tinha a mesma falha na borda do período pedido. Agora as duas olham também o intervalo antes e depois. Efeito que você pode notar: pedir à IA para passar um compromisso para o horário logo depois dele, com intervalo configurado, passa a ser recusado, porque o próprio compromisso ainda ocupa o intervalo. Nada para configurar: os agendamentos que já existem seguem como estão.

Crédito: @webtecnica.
