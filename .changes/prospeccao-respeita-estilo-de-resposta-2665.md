---
impacto: nada_mudou
secao: corrigido
titulo: A abertura da campanha de prospecção passou a respeitar o "Estilo de resposta" do agente e a dividir a mensagem fria em várias bolhas
---

A primeira mensagem da campanha de prospecção ignorava a opção "Responder em várias mensagens curtas" da tela do agente: ela saía sempre num balão só, por mais que o agente estivesse configurado para fatiar. A abordagem fria era a única mensagem do sistema que não obedecia ao estilo de resposta, e era justamente a que mais parecia robô — a pessoa recebia um texto longo de uma vez só, no primeiro contato.

Agora a abordagem usa a mesma decisão de fatiamento do turno de conversa (`splitForSend`), lida da versão publicada do agente da campanha. Com o estilo ligado, a mensagem sai em várias bolhas curtas; com o estilo desligado (ou num agente cuja linha não traz esses campos), ela continua saindo em uma só, exatamente como antes. O rodapé de saída vai junto do corpo e, por ser parágrafo próprio, vira a última bolha — a pessoa lê a apresentação e recebe a saída logo em seguida.

Cada bolha é uma mensagem física no mesmo número, então a pausa entre elas sai do ritmo do número (`throttle_ms` + `jitter_max_ms`) em vez de as bolhas saírem no mesmo milissegundo. O recibo e a idempotência da candidatura continuam na primeira bolha, que é a de id estável; as demais são mensagens próprias. Se uma bolha não for confirmada, o envio para na hora e a candidatura cai como falha, como já acontecia no balão único — não se segue mandando bolha atrás de um canal que acabou de recusar.

Nada precisa ser feito ao atualizar: quem tem o estilo desligado continua recebendo a abordagem em uma mensagem. Contribuição de @webtecnica, a partir da issue #2665 (PR #2680).
