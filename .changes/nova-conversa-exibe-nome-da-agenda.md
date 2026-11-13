---
impacto: correcao
secao: corrigido
titulo: O diálogo Nova conversa no Inbox exibe o nome salvo na agenda do contato
---

Ao buscar um contato no diálogo "Nova conversa" (`PainelIniciarConversa`), contatos sincronizados via WhatsApp que possuíam apenas o nome salvo na agenda do aparelho (`address_book_name`), sem `name` ou `display_name` cadastrado, eram apresentados com o telefone no rótulo principal e novamente no rótulo secundário.

O componente passa a utilizar `rotuloParaAEquipe`, alinhando-se com a lista de conversas e o cabeçalho do Inbox, apresentando o nome amigável da agenda na busca e na confirmação do contato existente.
