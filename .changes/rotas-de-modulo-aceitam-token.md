---
impacto: capacidade_nova
secao: adicionado
titulo: Agenda, chamadas, demandas, financeiro e tarefas aceitam token de integração nas rotas de leitura e escrita
---

As rotas de módulo passam a aceitar o token `dsk_…` de servidor ao lado da sessão de navegador, sempre filtradas pela organização da linha do token: agenda (configuração, endereços, exceções, horários livres, pessoas, vínculos e reativar tipo), chamadas (histórico, com paginação e filtros por contato e período), demandas (consulta do detalhe, próximo passo e encerramento), financeiro (catálogo, comandas, fila de faturamento, fidelidade, extrato e honorários — só leitura) e tarefas (listar, criar e editar, inclusive com repetição semanal).

A leitura pede o escopo `mcp:read` e o mesmo papel que a tela já exige; a escrita pede `mcp:write`, e cada chamada conta no teto do token e da organização — passou do limite, a resposta é 429 com `Retry-After`. Consultar horários livres exige papel `agent`, e remover bloqueio de dia e apagar tarefa exigem `manager`, a régua das exclusões da organização.

O que continua só pela sessão: iniciar ligação, criar bloqueio de dia, ler e atualizar as agendas Google da pessoa e decidir conflito do Google, filtrar tarefa por funil (`pipeline_id`) ou atribuir a si mesmo (`assigned_to=me`), e toda escrita no financeiro e nos honorários, que o token recusa com 401 até a fatia própria.

Contribuição de @paulolimajr77 (#4391).
