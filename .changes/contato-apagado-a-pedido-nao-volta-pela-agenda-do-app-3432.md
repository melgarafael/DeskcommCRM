---
impacto: nada_mudou
secao: corrigido
titulo: O contato apagado a pedido não volta pela agenda do app WhatsApp Business
---

O contato que o titular pediu para apagar não volta mais ao cadastro quando alguém edita esse número na agenda do app em coexistência, nem na sincronização inicial dos contatos. Antes, a Meta entregava o contato da agenda, o CRM não achava a ficha — a anonimização zera o telefone — e criava outra, com o número e o nome do celular.

A sincronização de contatos agora pergunta, antes de gravar, se aquele número foi apagado a pedido, pela mesma regra que a importação do histórico já usava. Se foi, não cria nada. Se a pergunta falhar ou não responder sim ou não, também não cria: na dúvida, o contato fica fora, e o desfecho aparece no log do webhook como contato não sincronizado. Crédito: @webtecnica (#3432).
