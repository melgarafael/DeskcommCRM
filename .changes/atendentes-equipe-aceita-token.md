---
impacto: capacidade_nova
secao: adicionado
titulo: Lista de atendentes e destinos de transferência aceitam token de integração
---
As rotas de leitura `attendants/availability` (roster de atendimento) e `team/assignable` (destinos de transferência de conversa) passam a aceitar o token `dsk_…` de servidor, com escopo `config:read` e papel admin, filtrando a organização pela linha do token. No token, a lista não traz o e-mail de login. Equipe (lista de membros), convites, troca de papel, revogação, disponibilidade e filas de uma pessoa, e a configuração de setores continuam somente de sessão.
