---
impacto: capacidade_nova
secao: adicionado
titulo: Ferramentas MCP para criação, consulta e atualização de tarefas
---

O endpoint MCP (`/api/mcp`) ganha o ciclo de vida das tarefas da equipe (`crm_tasks`), com o mesmo desenho da rota `/api/v1/tasks`:

- **`crm_create_task`**: abre uma tarefa ligada a um contato, a uma demanda em andamento ou a um negócio da organização, com prazo e responsável da equipe, e registra na linha do tempo do negócio.
- **`crm_list_tasks`**: consulta as tarefas por responsável (`me`, `ninguem` ou o id), situação, contato, negócio, demanda ou janela de vencimento. Dentro de uma conversa, o agente vê só as tarefas do cliente daquela conversa.
- **`crm_update_task`**: altera situação, prazo, prioridade, descrição, responsável e vínculos. A conclusão entra na linha do tempo do negócio só quando a tarefa fecha de fato, e o registro de auditoria guarda de qual situação para qual ela foi.

As três ficam no pacote "Passar para um humano" da configuração do agente: a tarefa é o pedido que o agente deixa para alguém da equipe. Ler exige `viewer`; criar e alterar exigem `agent`.

Contribuição de @Villa-Nova-Cont (#4838).
