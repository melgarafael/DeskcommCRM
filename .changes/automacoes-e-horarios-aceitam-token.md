---
impacto: capacidade_nova
secao: adicionado
titulo: Regras de automação e horários de atendimento aceitam token de integração
---
As rotas de automação (listar regras, excluir regra, histórico de execuções por regra e da organização) e de horários de atendimento (listar, agendar, editar e cancelar a janela de manutenção) passam a aceitar o token `dsk_…` de servidor. O token precisa de `config:read` para ler e de `config:write` para alterar, com papel admin, e a organização vem da linha do token. Criar e editar regra de automação continuam somente pela tela.
