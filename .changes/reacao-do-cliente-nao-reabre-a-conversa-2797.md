---
impacto: nada_mudou
secao: corrigido
titulo: A reação do cliente no WhatsApp (👍) não reabre mais a conversa nem conta como mensagem recebida
---

Quando o cliente reagia a uma mensagem com um emoji, a reação entrava como se fosse uma mensagem recebida: reabria a conversa encerrada, abria uma demanda nova, disparava o evento que acorda a notificação, o webhook de saída e o follow-up, e invalidava o rascunho de resposta. Agora a reação é gravada como uma linha ligada à mensagem reagida, para o WhatsApp por QR e para a API oficial, e não conta como fala do cliente em nenhum desses caminhos. Na Inbox, o emoji aparece como uma pequena marca no canto da mensagem reagida, e não como um balão novo do cliente; quando o cliente tira a reação, a marca some em até um minuto, ou na hora ao reabrir a conversa. O follow-up que espera uma resposta também passou a ignorar a reação: um 👍 depois de um "SIM" não esconde mais o "SIM". O WAHA passa a assinar o evento `message.reaction`; o `update.sh` recria o contêiner com a assinatura nova, a sessão é retomada sozinha e não pede QR de novo. Uma migration (0684) põe o corte nos três gatilhos de mensagem recebida.

Contribuição de @webtecnica (refs #2797).
