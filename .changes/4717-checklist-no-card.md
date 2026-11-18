---
impacto: capacidade_nova
secao: adicionado
titulo: O plano aplicado vira checklist no card, com quem marcou, quando e o progresso
---

O plano de tarefas aplicado a um negócio deixava de virar lista: as tarefas nasciam soltas na aba Tarefas e o card não dizia em que pé estava a cadência. Agora o painel do card dentro do Inbox mostra a **lista única do negócio**, na ordem do plano, com ✔ por item, **quem marcou e quando** e a barra **"N de M concluídas"** — recalculada no servidor a cada clique, então o painel mostra o estado do card e não o do clique. A leitura reusa o que já existia em vez de criar uma segunda verdade sobre "esta etapa foi cumprida?": a ordem vem de `crm_lead_activities.payload.tarefa_ids`, gravado por `aplicarPlanoDeTarefas` na ordem dos passos; o estado é `crm_tasks.status`; o autor e a data são a linha `task_completed` da mesma timeline que a aba Tarefas mostra; e o nome de quem marcou sai de `fn_nomes_dos_membros`. Sem tabela, sem coluna e **sem migration** — nenhum plano já aplicado perde a lista, porque a leitura é retroativa para toda marca `task_plan_applied` existente. Desmarcar volta o item sem apagar a linha `task_completed`: o autor da marcação original é histórico, não estado. Um item apagado na aba Tarefas some do checklist, que é o desfecho correto — o checklist É a tarefa. Fora desta entrega, os itens 3 a 6 da issue: agrupamento na aba Tarefas, prazo relativo a campo de data, condição de automação "checklist concluído" e aplicação manual de item avulso.

Contribuição de @webtecnica (#4717).
