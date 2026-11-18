---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas da agenda aceitam token de integração
---
As rotas de leitura da agenda (`agenda/configuracao`, `agenda/enderecos`, `agenda/excecoes`, `agenda/horarios-livres`, `agenda/pessoas` e `agenda/vinculos`), a de remoção de bloqueio (`agenda/excecoes` DELETE) e a de reativar tipo de agendamento (`agenda/tipos/reativar`) passam a aceitar o token `dsk_…` de servidor. A leitura exige o escopo `mcp:read`, a escrita exige `mcp:write`, e cada chamada conta no próprio teto de escrita do token e da organização. A organização vem da linha do token. Consultar horários livres pede papel `agent` no token, o mesmo que a ferramenta de agenda da IA exige. Remover bloqueio de dia pelo token pede papel `manager`, já que o token não é pessoa e atua sobre toda a organização. Continuam somente de sessão a criação de bloqueio de dia, a leitura das agendas Google da pessoa, a seleção e a atualização dessas agendas, a decisão de conflito do Google, e a leitura de um compromisso pelo id.
