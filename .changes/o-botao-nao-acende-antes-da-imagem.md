---
impacto: capacidade_nova
secao: corrigido
titulo: O aviso de versão nova só aparece quando ela está pronta para instalar
---

A tela oferecia a versão nova **antes de ela estar pronta para instalar**. O aviso saía assim que a versão era publicada, mas o pacote que a VPS precisa baixar leva mais uns minutos para ficar pronto.

Quem clicava nessa janela via a atualização parar no meio.

Agora o sistema **pergunta se há o que baixar** antes de oferecer. E se a VPS estiver sem acesso ao registro, ele **continua oferecendo**: deixar de oferecer para sempre, em silêncio, por causa de um problema de rede seria pior.
