---
impacto: capacidade_nova
secao: adicionado
titulo: A planilha de prospecção aceita diagnóstico, oferta e contexto da equipe, usados na primeira mensagem e na ficha do contato
---

A planilha importada na Prospecção ganhou três colunas opcionais: `diagnostico`, `oferta` e `contexto`. Nelas a equipe escreve o que já sabe da empresa (o que se vê de fora, o que oferecer, uma indicação ou conversa anterior). O modelo da planilha já traz as três colunas, e a tela de importação avisa que o que estiver em Contexto e em Diagnóstico pode aparecer na primeira mensagem como fato.

A IA lê esses textos como dados ao escrever a primeira mensagem, com regras próprias: uma indicação ou conversa anterior vira o motivo do contato, a oferta da equipe decide o que oferecer, e a mensagem nunca diz que a equipe analisou a empresa. No modo em que a saída vai na segunda mensagem, só o contexto entra. Quando a empresa vira contato, a aba Diagnóstico já nasce com os três textos, assinados por quem importou a planilha. Se a empresa já usa um campo próprio com a mesma chave, esse campo fica de fora.

Planilha sem as colunas funciona como antes, e a mensagem enviada é a mesma de antes. Nenhuma ação é necessária na atualização.

Parte 2 da #4459 (item R6 da #4632).
