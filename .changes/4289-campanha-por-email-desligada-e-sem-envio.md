---
impacto: capacidade_nova
secao: adicionado
titulo: A base da campanha por e-mail entrou desligada e ainda sem envio
---

Vem desligado, e nada muda para quem não liga: a tela de nova campanha continua só com o WhatsApp. Nada a fazer na VPS.

Quem administra o servidor encontra em **Sistema** o interruptor **Campanha por e-mail (em construção)**. Ligado, a nova campanha ganha a opção **E-mail**: dá para escrever o assunto e o corpo e conferir o público. Contato sem e-mail fica de fora e aparece na contagem, e a organização precisa ter a conta Resend conectada.

Esta versão ainda **não envia** o e-mail. O envio, o descadastro em um clique e a lista de quem pediu para não receber chegam numa entrega seguinte; até lá a campanha criada fica guardada. Com o interruptor desligado, criar ou editar uma campanha de e-mail pela API responde 404 com o código `campanha_email_desligada`.

Crédito: @webtecnica (#4289).
