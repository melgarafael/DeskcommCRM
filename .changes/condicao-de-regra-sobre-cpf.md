---
impacto: exige_acao
secao: alterado
titulo: Condição de regra sobre as colunas de CPF responde só se estão preenchidas
---

Condição de regra de automação em `contact.cpf_hash` ou `contact.cpf_encrypted`
passa a responder só a "está preenchido" e "está vazio". Os demais operadores dão
falso. A API de contatos e a tela de duplicados respondem como antes.

## Requer atenção

Vale só para quem escreveu uma condição dessas com outro operador; sem isso, não há
nada a fazer.

- Regra que comparava o valor dessas colunas deixa de disparar. Para saber se a
  ficha tem CPF, use "está preenchido".
