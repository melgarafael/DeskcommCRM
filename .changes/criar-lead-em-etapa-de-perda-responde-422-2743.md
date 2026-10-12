---
impacto: nada_mudou
secao: corrigido
titulo: Criar um negócio direto numa etapa de perda sem motivo responde 422, não erro interno
---

Pela API, criar um negócio (`POST /api/v1/leads`) já numa etapa de perda e sem informar o motivo respondia erro interno (500) com o texto cru do banco. Agora a resposta é 422 `lost_reason_required`, com a mesma frase traduzida que a ação "marcar como perdido" devolve. O mesmo vale para a importação de planilha e para as fontes de captação que apontam para uma etapa de perda: a importação para na primeira linha e desfaz os contatos que tinha criado, e a fonte externa recebe 422 em vez de 500. Outros erros do banco continuam como antes.

Você não precisa fazer nada.

Contribuição de @webtecnica (#2762), a partir da issue #2743.
