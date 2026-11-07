---
impacto: exige_acao
secao: alterado
titulo: As respostas da API de contatos dizem só se há CPF
---

Lista, detalhe, criação e edição em `/api/v1/contacts` deixam de trazer o campo
`cpf_hash` e passam a trazer `cpf_available` (`true` ou `false`) em todas elas —
antes esse sinal só vinha no detalhe. A busca por CPF, a trava de CPF repetido, a
exportação e o pedido do CPF por quem tem papel para isso seguem iguais.

Modelos de mensagem deixam de resolver as colunas de CPF do contato.

## Requer atenção

Vale só para quem integra com a API de contatos ou escreveu um modelo de mensagem
com essas colunas; sem isso, não há nada a fazer.

- Integração que lia `cpf_hash` para saber se a ficha tem CPF passa a ler `cpf_available`.
- Integração que usava `cpf_hash` para localizar a ficha de uma pessoa passa a buscar
  com `GET /api/v1/contacts?search=` e os 11 dígitos do CPF.
- Modelo de mensagem que citava `contact.cpf_hash` ou `contact.cpf_encrypted` sai com
  esse trecho em branco.
