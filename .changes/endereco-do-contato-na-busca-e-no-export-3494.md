---
impacto: nada_mudou
secao: corrigido
titulo: O endereço do contato entra na busca e na exportação
---

O contato de pessoa física já guardava rua, número, complemento, bairro,
cidade, UF e CEP — preenchidos pelo CEP no cadastro e na ficha. Mas o endereço
não era encontrável nem saía da instalação: a busca de Contatos procurava só
por nome, e-mail, telefone e CPF, e a exportação em CSV e vCard levava apenas
esses campos. Quem recebia o cliente pelo endereço ("o da Rua XV, 120") não
achava o cadastro, e o backup e o pedido de portabilidade devolviam a metade do
contato que não serve para entrega nem cobrança.

Agora a busca acha pela rua, pelo bairro e pela cidade digitados com ou sem
acento, e também pelo CEP — com ou sem máscara. O CSV exportado passou a levar
as sete colunas de endereço, e o vCard leva o endereço no campo `ADR`; o
importador reconhece as mesmas colunas, então exportar e reimportar continua
devolvendo o contato inteiro. Nenhuma ação é necessária na atualização.

Contribuição de @webtecnica (#3494).
