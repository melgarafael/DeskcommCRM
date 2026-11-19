---
impacto: nada_mudou
secao: corrigido
titulo: O catálogo de serviços explica o motivo quando recusa um cadastro
---

Quando o sinal fixo ultrapassa o menor preço do serviço, o motivo aparece ao lado
do valor do sinal. Se a recusa acontece ao cadastrar uma variação, o aviso ao lado
do preço indica o que pode ser ajustado. Os avisos seguem o idioma da tela.

Para quem integra pela API REST: em `POST /api/v1/servicos` e `PATCH /api/v1/servicos/{id}`,
o `error.details` das recusas de validação passa a trazer um código estável por campo
(por exemplo `{"sinal": ["sinal_fixo_acima_do_preco"]}` ou `{"pai_id": ["pai_invalido"]}`)
em vez da frase em português. Quem lia a frase deve passar a comparar o código.

Contribuição de @yunshu0909, a partir da issue #4998.
