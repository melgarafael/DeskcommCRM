---
impacto: nada_mudou
secao: corrigido
titulo: Os e-mails de confirmação de conta, redefinição de senha e convite de time seguem o idioma da instalação e da empresa
---

Com a tela em espanhol, os e-mails do sistema continuavam chegando em português: o texto de cada
molde era fixo dentro do arquivo dele, fora do dicionário da interface.

Agora o corpo do e-mail de confirmação de conta e o de redefinição de senha saem no idioma da
instalação (`APP_LOCALE`), e o convite de time sai no idioma da empresa que convidou. Em português
nada muda. O assunto dos e-mails de confirmação e de redefinição continua sendo o que a instalação
configurou no serviço de autenticação. Você não precisa fazer nada.

Crédito: @webtecnica.
