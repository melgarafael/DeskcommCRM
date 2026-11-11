---
impacto: capacidade_nova
secao: adicionado
titulo: Integração com token passa a gerenciar os grupos de respostas rápidas e a ler as respostas compartilhadas
---

Uma integração com token de API pode listar os grupos de respostas rápidas, criar, renomear, reordenar e apagar grupos, listar as respostas compartilhadas da organização, ver a imagem de uma delas e apagar uma resposta compartilhada. Para ler é preciso o escopo `config:read`; para alterar, `config:write`, e o token precisa ter papel de administrador. O token alcança só as respostas compartilhadas: as pessoais continuam sendo de cada atendente. Criar, editar e reordenar respostas, e enviar imagens para elas, continuam só pela tela.
