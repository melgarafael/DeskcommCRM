---
impacto: capacidade_nova
secao: corrigido
titulo: Áudio, foto, vídeo e documento recebidos pelo WhatsApp oficial agora aparecem
---

Quem usa o canal **oficial do WhatsApp** (a API da Meta) recebia a mensagem, mas
**não o arquivo**: o áudio, a foto, o vídeo ou o documento simplesmente não
apareciam na conversa — e nada na tela dizia que havia algo ali.

A causa: o aviso que a Meta manda não traz o arquivo, traz um código para
buscá-lo. O sistema guardava a mensagem e descartava o código, então não havia
como ir atrás do arquivo depois.

Agora o código é guardado, o arquivo é baixado em segundo plano e passa a
aparecer na conversa como qualquer outra mídia. O download só aceita o endereço
de mídia da própria Meta, por conexão segura.

Você não precisa fazer nada para adotar. Mensagens novas passam a trazer a mídia
a partir desta versão; as antigas, que perderam o código, não têm como ser
recuperadas.

Achado e corrigido por um contribuidor de fora.
