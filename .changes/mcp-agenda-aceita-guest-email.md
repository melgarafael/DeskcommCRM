---
impacto: nada_mudou
secao: corrigido
titulo: O agente passou a incluir alguém da equipe no convite da reunião que marca (guest_email)
---

Quando o agente marcava uma reunião — por `crm_book_appointment` ou `crm_find_and_book_appointment` — o convite do Google saía sem o consultor que ia conduzi-la, porque as ferramentas do agente não ofereciam o campo `guest_email` que a tela e a rota `POST /api/v1/agenda/agendamentos` já aceitavam e gravavam.

Agora as duas ferramentas aceitam `guest_email` opcional, com uma regra:

- o e-mail precisa ser de um usuário ativo da própria empresa (sem diferenciar maiúsculas); aí ele entra no convite do Google;
- e-mail de cliente ou de terceiro é recusado e nada é marcado — o agente escreve o que o cliente dita, e um convite em nome do negócio não sai para quem o negócio não escolheu. A recusa é a mesma para e-mail desconhecido e para usuário de outra empresa;
- sem `guest_email`, a marcação continua funcionando como antes.

A tela da Agenda e a rota da API não mudam: lá o convidado é escolhido por quem opera o sistema (pela tela ou por uma integração), não ditado por um cliente na conversa. Nenhuma ação é necessária para receber a correção.

Contribuição de @webtecnica (#2077, issue #2062); a regra de "só da equipe" foi decisão do mantenedor, aplicada sobre o trabalho dele.
