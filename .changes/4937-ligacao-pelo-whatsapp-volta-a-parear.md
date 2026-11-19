---
impacto: nada_mudou
secao: corrigido
titulo: A ligação pelo WhatsApp volta a parear o número
---

O WhatsApp passou a recusar a versão do componente de ligações (WaCalls) que a instalação usava. Ao parear o número para ligações, o QR não chegava, a sessão ficava em "conectando" para sempre sem mensagem de erro, e uma sessão pareada que caía não voltava. A imagem padrão agora é a do fork mantido pela DeskLabs, com a biblioteca do WhatsApp atualizada e com a falha de pareamento visível em vez de silenciosa. Quem usa o padrão recebe a imagem nova na próxima atualização, sem fazer nada.

Quem sobrescreveu `WACALLS_IMAGE` no `.env` continua na imagem que escolheu: troque para `ghcr.io/desklabs-opensource/wacalls@sha256:03f9e47fadc1afa909f512bbdda0fa4091d4646310f9a76ce3c752f05eafd1ff`, ou apague a linha para voltar ao padrão.

Ajuste a partir da issue #4937.
