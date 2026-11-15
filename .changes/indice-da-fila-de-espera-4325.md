---
impacto: nada_mudou
secao: corrigido
titulo: A aba Fila do Inbox para de varrer o histórico encerrado para montar a lista e o número do badge
---

A lista da Fila e a contagem da aba liam a organização inteira — com o histórico fechado incluído, que é a maior parte das linhas — e ordenavam o resultado em memória, mesmo quando a fila tem poucas dezenas de conversas. Um índice parcial novo (`idx_conversations_fila_espera`, migration 9357) casa exatamente com o filtro que a aba pede e com a ordem por tempo de espera, então o banco passa a ler só as conversas sem dono e abertas, já na ordem da tela.

Medido neste repositório (Postgres 15, 120 mil conversas, 120 na fila): a lista da Fila caiu de 4.343 para 685 buffers lidos e a contagem de 4.139 para 485, com 120 mil linhas lidas virando 120. O custo deixa de crescer com o tamanho do histórico — com 60 mil conversas o mesmo plano mediu 686 buffers.

Nada muda na tela nem no que cada pessoa vê: a troca é só de caminho no banco, e a instalação que atualiza ganha o índice pelo `update.sh`. Crédito: @webtecnica (#4325).
