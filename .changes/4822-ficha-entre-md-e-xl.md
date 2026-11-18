---
impacto: nada_mudou
secao: corrigido
titulo: Inbox ganha a porta da ficha do contato na faixa entre 768 e 1279 px
---

A ficha do contato só aparecia como terceira coluna a partir de 1280 px, e a
gaveta que abre o mesmo painel tinha uma única porta — dentro da barra do
celular, que some a partir de 768 px. Quem atendia numa janela de notebook
(~1230 px) ficava sem coluna e sem botão, e não achava onde inscrever o contato
num follow-up: essa seção só existe dentro da ficha.

Agora o cabeçalho da conversa tem um botão "Ficha" entre 768 e 1279 px. Ele abre
a gaveta que já existia — não há segundo painel — e a seção de follow-up vem
junto. Abaixo de 768 px nada muda (a barra do celular continua com o botão dela)
e a partir de 1280 px a ficha continua sendo a coluna da direita, sem botão
duplicado. O corte de 1280 px não foi tocado: ele é decisão de layout medida.

Contribuição de @webtecnica, a partir da issue #4822.
