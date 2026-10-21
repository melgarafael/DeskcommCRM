---
impacto: nada_mudou
secao: corrigido
titulo: A abertura da campanha de prospecção passou a respeitar o "Estilo de resposta" do agente e a dividir a mensagem fria em várias bolhas
---

A primeira mensagem da campanha de prospecção ignorava a opção "Responder em várias mensagens curtas" da tela do agente: ela saía sempre num balão só, por mais que o agente estivesse configurado para fatiar. A abordagem fria era a única mensagem do sistema que não obedecia ao estilo de resposta, e era justamente a que mais parecia robô — a pessoa recebia um texto longo de uma vez só, no primeiro contato.

Agora a abordagem usa a mesma decisão de fatiamento do turno de conversa (`splitForSend`), lida da versão publicada do agente da campanha. Com o estilo ligado, a mensagem sai em várias bolhas curtas; com o estilo desligado (ou num agente cuja linha não traz esses campos), ela continua saindo em uma só, exatamente como antes. A abordagem sai em no máximo 3 mensagens, o mesmo teto do turno de conversa; o que passar segue junto na última. Quando a campanha oferece a saída na primeira mensagem, o rodapé (o "responda PARAR") vai na PRIMEIRA bolha: se qualquer bolha seguinte não sair — veto do canal, status não confirmado, ou a pessoa respondendo no meio —, quem recebeu a apresentação não fica sem caminho de volta numa mensagem fria.

Cada bolha é uma mensagem física no mesmo número, então a pausa entre elas sai do ritmo do número (`throttle_ms` + `jitter_max_ms`) em vez de as bolhas saírem no mesmo milissegundo. O recibo e a idempotência da candidatura continuam na primeira bolha, que é a de id estável; as demais são mensagens próprias. A checagem de "esta conversa ainda é fria" acompanha a primeira bolha — é ela que recusa conversa que já foi atendida —, e entre as seguintes vale uma conferência leve: se a pessoa respondeu (inclusive "PARAR"), se o contato foi bloqueado ou se um humano assumiu a conversa, a abordagem para, mas só naquele contato — a campanha segue. Se uma bolha depois da primeira não for confirmada, o envio para na hora; como a primeira já chegou, a candidatura conta como abordada (a saída continua garantida, inclusive quando a campanha a oferece na segunda mensagem) e a mensagem que falhou fica marcada na conversa; a trilha de auditoria registra quantas bolhas saíram, de quantas.

Nada precisa ser feito ao atualizar: quem tem o estilo desligado continua recebendo a abordagem em uma mensagem. Contribuição de @webtecnica, a partir da issue #2665 (PR #2680).
