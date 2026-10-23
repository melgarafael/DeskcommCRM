---
impacto: nada_mudou
secao: corrigido
titulo: Áudio por URL num número Zernio chega como bolha de voz sem a legenda virar texto
---

Num número Zernio, um áudio enviado por URL com legenda chegava com a legenda colada ao anexo, como `message` da própria mensagem de voz — e num anexo de voz esse texto ou é ignorado pela API ou aparece solto na conversa. Agora a bolha de voz sai sem legenda, igual aos outros canais, mantendo `attachmentType: audio` com `voiceNote: true`. Imagem, vídeo e documento seguem levando a legenda normalmente. Nada a fazer na atualização.

Corrigido por @webtecnica (#3266).
