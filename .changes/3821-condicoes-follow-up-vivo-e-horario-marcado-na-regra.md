---
impacto: capacidade_nova
secao: adicionado
titulo: Regra de automação pode perguntar se o contato já está num follow-up ou tem horário marcado
---

O editor de regras ganhou duas condições, disponíveis em qualquer gatilho: «Contato tem follow-up vivo» e «Contato tem horário marcado». As duas respondem sim ou não. Na de agenda dá para limitar a «nos próximos N dias» (de 1 a 365) e a um tipo de atendimento.

Antes, uma regra que iniciava um fluxo para um contato que já estava em outro só falhava, e a falha aparecia depois, na Atividade da regra. Agora o mesmo gatilho pode ter duas regras: uma inicia o fluxo para quem não está em follow-up, e a outra cria a tarefa para a equipe. Se a leitura do contato falhar, a condição não decide nem para um lado nem para o outro. Regras que não usam essas condições funcionam como antes.

Contribuição de @webtecnica (#3814).
