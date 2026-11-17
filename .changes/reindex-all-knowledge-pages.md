---
impacto: nada_mudou
secao: corrigido
titulo: Preparar de novo toda a base de conhecimento alcança todos os materiais
---

Ao preparar de novo toda a base de conhecimento, inclusive depois de trocar o provedor de embeddings, o sistema agora lê os materiais ativos em páginas até o fim. Antes, a leitura era uma consulta só, e o limite de linhas por resposta da API (1.000 no padrão) deixava os materiais seguintes de fora sem avisar: numa base com 1.001 materiais, um ficava com o modelo antigo e fora das buscas feitas com o novo. Os materiais que ainda precisam de preparo continuam indo primeiro, e, se a leitura de alguma página falhar, nada é limpo nem enfileirado. Nenhuma ação é necessária na atualização.

Crédito: @samirhvbr.
