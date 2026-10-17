---
impacto: capacidade_nova
secao: alterado
titulo: O pedido de exclusão avisa o titular por e-mail depois de apagar, e o rótulo de anonimizado não deriva mais do id
---
O pedido de exclusão de dados agora avisa o titular por e-mail DEPOIS de apagar (art. 12.º do RGPD, art. 18 da LGPD): o endereço é lido antes da cascata, a mensagem sai depois, com a data de recebimento do pedido e o prazo de resposta. O resultado fica gravado no próprio pedido, então a tela de detalhe mostra se o aviso saiu — e, quando não sai, o motivo (titular sem e-mail, e-mail não configurado na instalação ou falha no envio). A rota de recusa e de prorrogação passa a avisar o titular com o MOTIVO no prazo de um mês.

O rótulo `Cliente Anonimizado #…` deixa de ser os oito primeiros caracteres do id do contato: o sufixo passa a ser um valor aleatório gerado uma vez, que não permite voltar do rótulo ao titular — dado pseudonimizado continua sendo dado pessoal (RGPD considerando 26, LGPD art. 12 e art. 13, § 4). O formato do rótulo não muda, então nenhuma tela muda de aparência. A mensagem que sobra depois da exclusão passa a gravar `external_id` nulo, que era o telefone do titular e o último dado pessoal legível naquela linha.

Quem opera a instalação não precisa fazer nada: sem configuração nova e sem mudança de número de versão esperada além da atualização de sempre.

Refs #2342.
