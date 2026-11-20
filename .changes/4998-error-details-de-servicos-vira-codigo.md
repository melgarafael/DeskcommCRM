---
impacto: exige_acao
secao: alterado
titulo: API de serviços devolve código, e não frase, no motivo da recusa
---
Para quem integra pela API REST: desde a 1.120.0, em `POST /api/v1/servicos` e
`PATCH /api/v1/servicos/{id}`, as regras do cadastro de serviço que antes devolviam uma
frase em português em `error.details` passaram a devolver um código estável. Cada campo
traz uma lista de códigos, por exemplo `{"sinal": ["sinal_fixo_acima_do_preco"]}` ou
`{"pai_id": ["pai_invalido"]}`. Algumas recusas de formato ainda chegam com a mensagem
padrão do validador (por exemplo `preco_cents` enviado como texto).

Contribuição de @yunshu0909, a partir da issue #4998.

## Requer atenção

Se a sua integração compara as frases de `error.details` ao cadastrar ou alterar serviços,
passe a comparar os códigos. Quem usa só a tela do CRM não precisa fazer nada.
