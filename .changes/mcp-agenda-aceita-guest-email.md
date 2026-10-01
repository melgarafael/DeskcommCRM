---
impacto: problema_corrigido
secao: corrigido
titulo: O agente passou a incluir o e-mail do convidado na reunião marcada (guest_email)
---

Quando o agente marcava uma reunião — por `crm_book_appointment` ou `crm_find_and_book_appointment` — o convite do Google saía sem a outra pessoa (acompanhante, responsável, participante), porque as ferramentas MCP do agente não ofereciam o campo `guest_email` que a tela e a rota `POST /api/v1/agenda/agendamentos` já aceitavam e gravavam.

Agora as duas ferramentas passam a aceitar `guest_email` opcional, validado como e-mail:

- quem marcar pode informar o e-mail de um convidado externo e ele entra no convite do Google;
- sem `guest_email`, a marcação continua funcionando como antes — nada muda no comportamento atual;
- e-mail que não for válido é recusado antes de chegar à marcação.

A tela da Agenda e a rota da API já sabiam gravar esse campo; faltava a porta do agente repassá-lo. Nenhuma ação é necessária para receber a correção.

Contribuição de @webtecnica (#2077).
