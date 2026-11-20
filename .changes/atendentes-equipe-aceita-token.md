---
impacto: capacidade_nova
secao: adicionado
titulo: Atendentes, setores e destinos de transferência podem ser lidos pelo token de integração
---
As rotas de leitura `attendants/availability` (roster de atendimento), `team/assignable` (destinos de transferência de conversa) e `attendants/sectors` (lista de setores) passam a aceitar o token `dsk_…` de servidor, com escopo `config:read` e papel admin, filtrando a organização pela linha do token. No token, a lista não traz o e-mail de login. Pelo token é só leitura: criar, renomear e apagar setor, trocar as filas de uma pessoa, a lista de membros da equipe, convites, troca de papel, revogação e a disponibilidade de uma pessoa continuam somente pela tela. Crédito: @paulolimajr77.
