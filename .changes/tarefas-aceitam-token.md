---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de tarefas aceitam token de integração
---
As rotas de tarefas (`tasks` e `tasks/[id]`) passam a aceitar o token `dsk_…` de servidor além da sessão de navegador. O token permite listar, criar e editar tarefas (inclusive tarefas com repetição semanal), associando-as a leads, contatos ou demandas da própria organização. A leitura exige o escopo `mcp:read` (com papel `viewer`) e a escrita exige `mcp:write` (com papel `agent`). Para apagar uma tarefa via token (`DELETE /api/v1/tasks/[id]`), exige-se papel mínimo `manager`, alinhado à régua de exclusões da organização. O filtro de funil (`pipeline_id`) e a atribuição dinâmica a si mesmo (`assigned_to=me`) continuam restritos à sessão da tela.
