---
impacto: capacidade_nova
secao: adicionado
titulo: O contato ganha tipo, Cliente ou Fornecedor, escolhido na ficha
---
Todo contato passa a ter um tipo e nasce Cliente, sem ninguém precisar escolher; os contatos que já existem viram Cliente na atualização. Na ficha do contato, em Editar, aparece o campo Tipo de contato, com Cliente ou Fornecedor. O fornecedor ganha um selo na ficha e no painel da conversa no Inbox, e continua conversando normalmente: o tipo não bloqueia envio, não pausa o agente e não mexe no funil. A API de contatos aceita e devolve `contact_type` (`cliente` ou `fornecedor`). Nada a fazer na atualização. Quem já marcava fornecedores com a etiqueta `fornecedor` precisa escolher o tipo na ficha: a etiqueta não é convertida. Crédito: @webtecnica (#3259).
