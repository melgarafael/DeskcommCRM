---
impacto: nada_mudou
secao: corrigido
titulo: A IA não é mais pausada por engano quando o eco de uma mensagem enviada chega durante o próprio envio
---

Toda mensagem que o CRM envia pelo WhatsApp volta como um "eco" pelo webhook. O eco chegava enquanto o envio era confirmado e a IA era pausada por 1 hora, como se uma pessoa tivesse respondido pelo celular. Em versões anteriores à 1.60.0, a mensagem também aparecia duas vezes na conversa. O cliente que respondia nesse intervalo ficava sem resposta. Isso foi medido numa campanha real: o eco chegou 14 segundos depois do envio, e a confirmação caiu no meio do processamento dele.

Agora o eco é reconhecido nessa janela também: a linha duplicada sai e a IA continua atendendo. A limpeza do eco depois do envio também passou a reconhecer, pelo final do id, o eco que volta com o contato identificado de outro jeito (`@lid` de um lado, `@c.us` do outro), inclusive ecos gravados no formato antigo, de antes da 1.60.0.

Não há nada a configurar na atualização.
