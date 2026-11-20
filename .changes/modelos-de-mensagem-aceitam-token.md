---
impacto: capacidade_nova
secao: adicionado
titulo: Integração com token passa a gerenciar os grupos de respostas rápidas e as respostas compartilhadas
---

Uma integração com token de API pode listar, criar, renomear, reordenar e apagar os grupos de respostas rápidas, e listar, criar, editar, reordenar e apagar as respostas compartilhadas da organização, além de enviar e ver as imagens delas. Para ler é preciso o escopo `config:read`; para alterar, `config:write`, e o token precisa ter papel de administrador. O token alcança só as respostas compartilhadas: criar uma resposta pessoal pelo token é recusado, e as pessoais continuam sendo de cada atendente. Crédito: @paulolimajr77.
