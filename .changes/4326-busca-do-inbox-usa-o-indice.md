---
impacto: nada_mudou
secao: alterado
titulo: A busca do Inbox acha o contato pelo índice, e não varrendo a empresa
---

A busca do Inbox casa o nome e o telefone do contato numa função do banco, em vez
de filtrar a tabela de contatos inteira sob a política de linha. Em organizações
grandes a busca deixa de crescer com o tamanho da base: medido com 40 mil
contatos, a consulta caiu de 37,0 ms varrendo a empresa inteira para 8,0 ms, e o
casamento em si — a parte que dependia do tamanho da base — passou a custar
0,24 ms por índice. As fichas anonimizadas e as pessoais continuam fora do resultado, e
quem não é membro da organização continua sem ver nada. A atualização cria os
índices e a função sozinha e não pede nenhuma ação de quem opera a instalação.
