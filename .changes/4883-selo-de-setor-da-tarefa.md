---
impacto: nada_mudou
secao: corrigido
titulo: O selo de setor da tarefa vem da conversa (ou do negócio), não do primeiro setor do responsável
---

Na tela **Tarefas** (lista e quadro), o selo de setor mostrava o **primeiro setor de quem tem a tarefa**. Quem atende mais de um setor ficava com todas as tarefas com o mesmo selo: um vendedor cujo primeiro setor é "Viagens Nacionais" via esse selo numa tarefa de cliente que pediu Peru, enquanto a **conversa** desse cliente estava em "Viagens Internacionais" — setor que a IA já gravava (#3881), mas que a tarefa não lia.

O filtro "Setor" tinha a mesma origem: casava com o setor do responsável (`crm_tasks.assigned_to` → `attendant_sector_members`), então selo e filtro contavam a mesma história errada.

Agora o setor da tarefa é **derivado de onde ela nasceu**, nesta ordem: o setor da **conversa** vinculada (a mais recente do contato da tarefa), senão o do **negócio** (a conversa ligada ao card em `crm_lead_links`; sem ligação, a do contato do card), e só sem nenhum dos dois o setor do **responsável** — que continua existindo para a tarefa avulsa, mas agora vem **declarado**: o selo diz "Setor do responsável — a tarefa não tem conversa nem negócio com setor", e não passa por setor do atendimento.

Selo e filtro passam pela **mesma função pura** (`lib/tarefas/setor-da-tarefa.ts`), usada pela rota que anexa `setor: { id, origem }` a cada tarefa e filtra por ele: filtrar por "Viagens Internacionais" devolve essa tarefa mesmo que o responsável seja de outro setor, e a tarefa de um membro de "Viagens Nacionais" cuja conversa está em outro setor **não** aparece no filtro de nacionais. Nenhuma migration: os dados já existiam. Nenhuma mudança na atribuição de setor da IA (#3881) nem em `attendant_sector_members`. O filtro roda depois do corte de 500 linhas da rota (o setor é derivado, não é coluna), então continua valendo o teto de 500.

Contribuição de @webtecnica, a partir da issue #4883.
