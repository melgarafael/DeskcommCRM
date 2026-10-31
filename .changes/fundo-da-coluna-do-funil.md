---
impacto: nada_mudou
secao: corrigido
titulo: Coluna do funil, painel da agenda e hover das ações voltam a ter fundo
---

As colunas de etapa do quadro do funil apareciam sem fundo, e "Ignorar" (na próxima ação) e "Encerrar" (na reativação) não acendiam quando o cursor passava por cima. O mesmo acontecia com o aviso de funil arquivado no topo do quadro, com o esqueleto que aparece enquanto o quadro carrega e com dois painéis de aviso da agenda. A causa era uma só: essas telas pediam uma superfície que o produto não tem, e a classe não pintava nada.

Agora as três usam a superfície suave que existe nos temas claro e escuro — a mesma dos cartões de apoio, dos botões secundários e das barras de ação. Coluna com fundo próprio, hover visível e avisos destacados do fundo da página, nos dois temas.

Contribuição de @webtecnica (#3791).
