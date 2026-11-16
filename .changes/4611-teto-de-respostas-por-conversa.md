---
impacto: capacidade_nova
secao: corrigido
titulo: A IA para de responder a conversa que virou pingue-pongue, e a equipe é avisada
---

Numa instalação, o contato do outro lado era o atendimento automático de um banco, e os dois robôs conversaram sozinhos: 216 respostas em uma hora para o mesmo contato. Nenhuma trava barrava, porque cada resposta, sozinha, era legítima. Agora, quando a mesma conversa já recebeu 20 mensagens da IA em 60 minutos, a próxima resposta automática não sai. Cada bolha e cada foto contam. Ao mesmo tempo, abre um aviso na Central para aquela conversa, com o botão que leva até ela, para a equipe ver se do outro lado é um robô ou um cliente. Enquanto esse aviso estiver aberto, a mesma conversa não abre outro. Na linha do tempo do contato, o motivo aparece em português. Mensagens de follow-up e o Testar do agente não entram nessa conta. Os números se ajustam pelas variáveis opcionais `TETO_DE_RESPOSTAS_POR_CONVERSA` e `TETO_DE_RESPOSTAS_JANELA_MIN`. Não é preciso mexer no `.env` para atualizar.

Contribuição de @webtecnica (#4611, #4590).
