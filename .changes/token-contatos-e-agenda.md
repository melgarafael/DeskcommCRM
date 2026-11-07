---
impacto: capacidade_nova
secao: adicionado
titulo: Criar contato e ler agendamentos e serviços por token de integração
---
`POST /api/v1/contacts` (criar contato), `GET /api/v1/agenda/agendamentos` (lista de compromissos) e `GET /api/v1/agenda/servicos` (configuração dos serviços da agenda) passam a aceitar o token `dsk_…` de servidor, além da sessão. A criação de contato exige o escopo `mcp:write` e papel `agent` no token; as duas leituras exigem `mcp:read` e papel `manager`, porque o token enxerga a organização inteira e a tela de um atendente pode mostrar só a própria agenda. A organização vem sempre da linha do token, e cada chamada conta no teto de uso do token e da organização. O registro de auditoria da criação de contato passa a guardar o token que a fez. Quem entra pela tela não percebe mudança. — Paulo Lima Jr
