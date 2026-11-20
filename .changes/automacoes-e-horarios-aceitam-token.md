---
impacto: capacidade_nova
secao: adicionado
titulo: Regras de automação e pausas agendadas de canal aceitam token de integração
---
As rotas de automação (listar regras, excluir regra, histórico de execuções por regra e da organização) e a lista de pausas agendadas de canal passam a aceitar o token `dsk_…` de servidor. O token precisa de `config:read` para ler e de `config:write` para excluir regra, com papel admin, e a organização vem da linha do token. Criar e editar regra de automação, e agendar, editar e cancelar a pausa de canal, continuam somente pela tela. Crédito: @paulolimajr77.
