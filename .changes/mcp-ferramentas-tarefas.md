---
impacto: capacidade_nova
secao: adicionado
titulo: Ferramentas MCP para criação, consulta e atualização de tarefas
---

O endpoint MCP (`/api/mcp`) ganha suporte nativo para o ciclo de vida completo de tarefas da equipe (`crm_tasks`):

- **`crm_create_task`**: Permite a agentes de IA e integrações abrirem tarefas vinculadas a contatos, demandas ativas ou negócios, validando responsabilidade dentro da organização e disparando o fechamento de laço no Sistema Vivo.
- **`crm_list_tasks`**: Permite consultar tarefas pendentes ou em andamento com filtros por responsável (`me`, `ninguem` ou UUID), status, contato, demanda ou janela de vencimento, respeitando estritamente o isolamento multi-tenant (`organization_id`).
- **`crm_update_task`**: Permite alterar status (`pending`, `in_progress`, `done`, `cancelled`), redefinir prazos, prioridades, descrições e responsáveis com validação e rastreamento.
- **Catálogo Amigável**: As ferramentas foram devidamente catalogadas em `TOOL_CATALOG` com perfis de risco (`seguro` / `atencao`), agrupadas nos pacotes `organizar` e `atender`, com permissões RBAC mínimas de acesso (`viewer` para leitura, `agent` para escrita).
