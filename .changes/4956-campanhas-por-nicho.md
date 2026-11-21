---
impacto: capacidade_nova
secao: adicionado
titulo: "Suas campanhas" agrupa a lista de prospecção por nicho, com um grupo nomeado para as campanhas sem nicho
---

Quem roda mais de uma oferta para o mesmo público — padarias de um lado, clínicas de outro — lia a lista inteira de campanhas para descobrir onde estavam as daquele nicho: o nicho só aparecia com a campanha já aberta. Agora a lista "Suas campanhas" desenha um cabeçalho por nicho e põe as campanhas embaixo. Nicho escrito com outra caixa ("Padarias" e "padarias") cai no mesmo grupo, que mostra o texto da primeira campanha do grupo.

O agrupamento é só de apresentação: nenhuma campanha muda de lugar no banco, nenhuma contagem do cartão é recalculada e as ações do cartão (abrir, arquivar, desarquivar) continuam iguais. A ordem também não mudou — cada grupo aparece onde a primeira campanha dele apareceria, e dentro do grupo as campanhas seguem a ordem que já vinham; não há uma segunda ordenação.

Campanha sem nicho gravado (busca antiga, `search` nulo) ganha o grupo próprio "Sem nicho" e continua na lista — antes ela aparecia misturada, agora tem cabeçalho e não some. O filtro "Ver arquivadas" agrupa do mesmo jeito, e a lista vazia continua com o aviso de sempre. Regra em `lib/prospecting/grupos-por-nicho.ts`, testada sem DOM e pela tela.
