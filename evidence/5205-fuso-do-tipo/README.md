# #5205 — o tipo de agendamento segue o fuso da empresa

Prova pela tela em 24/11/2026, numa instalação de teste na 1.124.0 com a migration 9469 aplicada (renumerada para 9477 na entrada na main) ao banco (a mudança é só de banco; a imagem do app é a publicada).

1. Configurações › Organização: fuso trocado de `America/Sao_Paulo` para `America/Manaus` e salvo ("Organização atualizada").
2. Configurações › Agendamentos › Novo tipo de agendamento: tipo criado pela tela, sem tocar em fuso.
3. Configurar o tipo › Opções adicionais: **Fuso do serviço = `America/Manaus`** (`tipo-novo-nasce-no-fuso-da-empresa.png`). Antes do conserto, o mesmo caminho dava `America/Sao_Paulo`.
4. Configurações › Organização: fuso de volta para `America/Sao_Paulo`. No banco, o tipo criado voltou para `America/Sao_Paulo` e os 6 tipos que já estavam em outro fuso, postos à mão, não mudaram.
5. O tipo de teste foi desativado pela tela.

Os três caminhos do defeito (empresa criada sem fuso e fuso escolhido depois; empresa que já nasce em outro fuso; tipo novo pelo POST) e o ajuste dos tipos antigos também foram medidos no banco, numa transação desfeita, antes e depois da migration.
