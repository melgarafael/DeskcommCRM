---
impacto: nada_mudou
secao: corrigido
titulo: No Instagram e no Facebook, o agente com nota de voz ligada responde em texto em vez de deixar áudios falhados
---

Um agente com "Enviar nota de voz" ligado, atendendo uma conversa de Instagram ou Facebook, gerava a nota de voz e o provedor a recusava (HTTP 400) em toda tentativa: cada nova tentativa do atendimento deixava mais um áudio falhado na conversa, e o cliente ficava sem resposta. A Meta não aceita em mensagem direta os formatos de áudio que o agente produz. Agora, nesses canais, o agente responde em texto desde a primeira vez, sem gastar com a síntese de voz, e a tela do agente avisa, ao lado da chave de voz, que no canal escolhido a resposta sai em texto. Nos números de WhatsApp nada muda. O robô do Telegram, que ainda não envia áudio, passa pela mesma regra.
