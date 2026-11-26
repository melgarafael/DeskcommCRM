---
impacto: nada_mudou
secao: corrigido
titulo: A tela Casos volta a abrir em organizações com mais de 400 conversas com caso
---

Numa organização com pouco mais de 400 conversas que já tiveram caso, a tela **Casos** ficava carregando para sempre, tanto em **Abertos** quanto em **Concluídos**: o pedido que monta a fila carregava a lista inteira de conversas de uma vez e passava do tamanho que o servidor aceita, e a rota respondia com erro. Agora essa lista é consultada em partes, e a fila abre com qualquer tamanho. A aba **Abertos** também ficou mais leve, porque passa a considerar só os casos abertos ao decidir o que mostrar.

Duas falhas vizinhas saíram junto. Acima de 1.000 casos na organização, parte dos casos sumia da fila sem aviso nenhum; agora todos entram. E a leitura da fila por token de integração, que tinha o mesmo limite ao buscar o contato de cada caso, também passou a consultar em partes.

Relatado em #5255 por @tiagolisboa88; correção de @Jutaosorio.
