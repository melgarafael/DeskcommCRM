---
impacto: nada_mudou
secao: corrigido
titulo: A busca de contatos acha o nome com ou sem acento
---

A busca da lista de contatos comparava o nome com `ilike`, que ignora maiúsculas mas não ignora acento: quem digitava "Joao" não achava "João", e "MARCIA" não achava "Márcia". Agora as quatro colunas de texto (nome, nome exibido, e-mail e telefone) usam `imatch`, e cada letra com acento do português vira uma classe (`jo[aáàâãä…]o`), então o termo acha o cadastro nos dois sentidos, sem migração e sem `unaccent` no banco.

Letra acentuada fora do português (`ñ`, `ë`, `å`, `ò`) continua achando pela grafia exata, como antes. Asteriscos seguidos no termo viram um curinga só, para que um termo longo de `*` não trave a consulta. Telefone e CPF seguem com a mesma comparação de antes. A busca de conversas continua em `ilike` e ainda não acha o nome sem o acento.

Contribuição de @webtecnica (#2310, Refs #1835).
