---
impacto: capacidade_nova
secao: adicionado
titulo: A ferramenta de agenda lê um período inteiro, no fuso da empresa e em páginas
---

A ferramenta `crm_list_appointments` passa a aceitar `de`/`ate` (até 62 dias, a agenda inteira da organização) e paginação por `depois_de`/`proximo`, e cada compromisso traz o nome do contato e do atendente, o tipo, o local e os negócios vinculados — as chaves `contato_id`/`atendente_id` continuam na resposta. O filtro por `dia` passa a contar o dia no fuso da organização. A listagem da agenda pela API recusa com 422 um período acima de 62 dias.

Não há ação para quem opera a VPS.

Contribuição de @webtecnica (#1762).
