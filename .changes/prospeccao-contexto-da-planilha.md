---
impacto: capacidade_nova
secao: adicionado
titulo: A planilha da Prospecção leva o que a equipe já sabe da empresa para a primeira mensagem e para a aba Diagnóstico
---

A planilha importada na Prospecção aceita três colunas opcionais: `diagnostico`, `oferta` e `contexto`. Nelas a equipe escreve o que já sabe de cada empresa: em Diagnóstico, o que qualquer um vê de fora (site, Google, redes); em Oferta, o que oferecer; em Contexto, uma indicação, um encontro ou uma conversa anterior. O modelo da planilha já traz as três colunas, e a tela de importação avisa que o que estiver em Contexto e em Diagnóstico pode aparecer na primeira mensagem como fato. A coluna chamada "observação" ou "observações" não é lida, porque costuma guardar notas internas: ela aparece entre as colunas ignoradas.

Na primeira mensagem, a IA recebe esses textos com instruções próprias: usar uma indicação ou conversa anterior como motivo do contato, deixar a oferta da equipe decidir o que oferecer, sem preço, nunca dizer que a equipe analisou a empresa e não levar para a mensagem recados para a equipe nem telefone, CPF, e-mail ou documento de pessoas. As instruções orientam a IA, mas não garantem o texto: confira a prévia antes de disparar. Na campanha em que "Quando oferecer a opção de parar de receber" está em "Atrasar para a 2ª mensagem", a primeira mensagem só cumprimenta, e dos três textos só o Contexto entra nela.

Quando a empresa vira contato, a aba Diagnóstico já nasce preenchida: o Diagnóstico da planilha vai para o diagnóstico, a Oferta para a oferta sugerida e o Contexto para as observações da equipe. Se houver diagnóstico ou oferta, quem importou a planilha fica registrado como autor. O Contexto sozinho entra sem autor, como qualquer observação. Se a sua organização já tem um campo de contato próprio com a mesma chave (`diag_resumo`, `diag_oferta` ou `diag_observacoes`), o campo dela fica como está e o texto da planilha não entra nele. Na leitura da planilha, o texto acima de 4.000 caracteres (Diagnóstico e Contexto) ou de 2.000 (Oferta) é cortado sem aviso. Para escrever a primeira mensagem, a IA lê até 1.200 caracteres de cada um.

Só a importação por planilha muda: a busca de empresas pelo Google Maps continua igual. Sem as colunas, a IA recebe exatamente as mesmas instruções e os mesmos dados de antes para escrever a primeira mensagem. Nenhuma ação é necessária na atualização. Crédito: @tabaterral, sobre a ideia de @aleflores35 no #4459.
