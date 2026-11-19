---
impacto: capacidade_nova
secao: adicionado
titulo: O relatório de vendas do Desempenho sai em CSV, com o período no nome do arquivo
---

A tela de Desempenho mostrava o resultado de vendas por atendente — ganhos, perdidos, conversas e o tempo da primeira resposta — e não tinha porta de saída: levar o número para a gestão ou abrir numa planilha dependia de print ou digitação. Agora o botão "Exportar vendas", ao lado do filtro de atendente, baixa um CSV com a tabela da tela.

O arquivo sai no formato das exportações que o produto já tinha (contatos, conversas, auditoria): mesmo `Content-Type`, mesmo `Content-Disposition` de anexo, BOM na frente, `;` de separador e CRLF — o que faz o Excel em português abrir acento e colunas certos. O decimal vai com vírgula, e média não medida sai vazia em vez de zero.

O nome do arquivo diz o que é e qual é o período (`vendas-por-atendente-AAAA-MM-DD_a_AAAA-MM-DD.csv`), e o recorte que a pessoa está vendo é o que sai: com um atendente escolhido no filtro, o arquivo tem só a linha dele. Os números não são recalculados — a rota e a tela leem a mesma função, então o arquivo e a tela não têm como divergir. Exportar exige papel de gestão (`manager`), o mesmo piso das outras exportações, e cada arquivo baixado fica registrado na auditoria com a quantidade de linhas e o recorte, nunca com o conteúdo da venda.
