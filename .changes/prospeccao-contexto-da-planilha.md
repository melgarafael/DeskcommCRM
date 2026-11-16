---
impacto: capacidade_nova
secao: adicionado
titulo: A planilha da Prospecção leva o que a equipe já sabe da empresa para a primeira mensagem e para a aba Diagnóstico
---

A planilha importada na Prospecção aceita três colunas opcionais: `diagnostico`, `oferta` e `contexto`. Nelas a equipe escreve o que já sabe de cada empresa: em Diagnóstico, o que qualquer um vê de fora (site, Google, redes); em Oferta, o que oferecer; em Contexto, uma indicação, um encontro ou uma conversa anterior. O modelo da planilha já traz as três colunas, e a tela de importação avisa que o que estiver em Contexto e em Diagnóstico pode aparecer na primeira mensagem como fato. A coluna chamada "observação" ou "observações" não é lida, porque costuma guardar notas internas: ela aparece entre as colunas ignoradas.

Na primeira mensagem, a IA usa esses textos com regras próprias. Uma indicação ou conversa anterior vira o motivo do contato, a oferta da equipe decide o que oferecer, sem preço, e a mensagem nunca diz que a equipe analisou a empresa. Recados para a equipe e CPF ou telefone de pessoas não vão para a mensagem. Na campanha que deixa a opção de parar de receber para a segunda mensagem, a primeira só cumprimenta, e só o Contexto entra nela.

Quando a empresa vira contato, a aba Diagnóstico já nasce preenchida: o Diagnóstico da planilha vai para o diagnóstico, a Oferta para a oferta sugerida e o Contexto para as observações da equipe. Se houver diagnóstico ou oferta, quem importou a planilha fica registrado como autor. O Contexto sozinho entra sem autor, como qualquer observação. Se a sua organização já tem um campo de contato próprio com a mesma chave (`diag_resumo`, `diag_oferta` ou `diag_observacoes`), o campo dela fica como está e o texto da planilha não entra nele. Textos muito longos são cortados sem aviso.

Só a importação por planilha muda: a busca de empresas pelo Google Maps continua igual. Sem as colunas, a IA recebe exatamente as mesmas instruções e os mesmos dados de antes para escrever a primeira mensagem. Nenhuma ação é necessária na atualização. Crédito: @tabaterral, sobre a ideia de @aleflores35 no #4459.
