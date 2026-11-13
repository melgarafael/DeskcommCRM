---
impacto: capacidade_nova
secao: corrigido
titulo: Conversões só oferece "Enviar vendas pelo canal da conversa" a quem tem um canal que envia a venda
---

A chave aparecia para toda organização, inclusive para quem conecta o WhatsApp
por QR Code ou pela API oficial direta, onde ela não envia nada. Agora ela só é
oferecida quando alguma conexão da organização consegue devolver a venda pela
conversa; sem esse canal, a tela diz isso e aponta a conexão direta com a Meta
(conjunto de dados e token). Quem já tinha a chave ligada sem canal que envie a
vê com um aviso e pode desligá-la. Nenhuma rota, tabela ou migration nova.
