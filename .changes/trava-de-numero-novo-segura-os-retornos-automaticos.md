---
impacto: exige_acao
secao: alterado
titulo: A trava de número novo passa a segurar os retornos automáticos até você liberar o número na Central
---

Todo número de WhatsApp conectado nasce com a trava de número novo, que deveria segurar os retornos automáticos (os acompanhamentos que o sistema manda por conta própria) até alguém liberar o número na Central. Ela não segurava nenhum: o retorno automático saía mesmo com o número ainda em aquecimento, que é o perfil que o WhatsApp bane. Agora ela segura. Responder quem escreveu continua funcionando normalmente.

Na atualização, a trava sai sozinha do número que já está formado: aquele em que o controle de ritmo de envio já não põe limite de aquecimento (o número declarado em uso há 31 dias ou mais em "Este número é usado desde", ou com "pular o aquecimento" ligado, ou com degraus próprios que já chegaram em "sem limite"), ou cuja primeira mensagem enviada saiu há 31 dias ou mais. Cada número solto fica registrado na auditoria com o motivo, e o item dele na Central é fechado. Uma trava por saúde ruim do número (muitos bloqueios ou pouca resposta) nunca é solta sozinha.

O item "Número novo aguardando liberação" na Central passa de informação para aviso e diz que os retornos automáticos daquele número estão parados até você liberar. Quando você libera, os retornos que estavam esperando voltam espaçados, um a cada 5 minutos por número e dentro da janela de envio, em vez de saírem todos de uma vez. Contribuição de @Sandersono (#2327), que achou e consertou a trava que não segurava.

## Requer atenção

Se algum número seu ainda não cumpre essas condições (em geral, o que começou a enviar há menos de 31 dias), os retornos automáticos dele param depois da atualização e esperam na fila, sem se perder. Abra a **Central**, procure o aviso "Número novo aguardando liberação (go-live)" e marque como resolvido quando o número estiver pronto para disparar. Nenhum arquivo precisa ser editado.
