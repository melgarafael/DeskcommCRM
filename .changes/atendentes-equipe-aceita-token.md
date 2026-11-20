---
impacto: capacidade_nova
secao: adicionado
titulo: Atendentes, setores e destinos de transferência aceitam token de integração
---
As rotas de leitura `attendants/availability` (roster de atendimento) e `team/assignable` (destinos de transferência de conversa) passam a aceitar o token `dsk_…` de servidor, com escopo `config:read` e papel admin, filtrando a organização pela linha do token. No token, a lista não traz o e-mail de login. A configuração de setores também passa a aceitar o token: listar (`config:read`), criar, renomear e apagar setores e mudar o setor de uma pessoa (`config:write`), sempre com papel admin. Equipe (lista de membros), convites, troca de papel, revogação, e disponibilidade e filas de uma pessoa continuam somente de sessão. Crédito: @paulolimajr77.
