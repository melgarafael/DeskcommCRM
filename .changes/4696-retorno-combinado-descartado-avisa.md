---
impacto: capacidade_nova
secao: corrigido
titulo: O retorno combinado que não vai mais sair passa a aparecer na Central de avisos
---

Quando a IA combinava um retorno com o cliente ("te chamo às 15h") e o atendimento mudava antes da hora, por exemplo porque a conversa foi encerrada, a mensagem deixava de sair, e isso continua assim: escrever em nome de um atendimento que já acabou seria pior. O problema é que ninguém ficava sabendo. Numa instalação foram 11 casos em 17 dias, e num deles o cliente ficou esperando um contato que não veio. Agora a Central de avisos mostra "Retorno combinado com <contato> não vai sair", com o horário que estava combinado e um botão para abrir a conversa. Se o mesmo contato tiver dois retornos descartados, aparece um aviso só. Quando o contato tem um negócio aberto, a linha do tempo dele registra o motivo em português. Nada é enviado ao cliente. Não é preciso mexer no `.env` para atualizar.

Contribuição de @webtecnica (#4703, #4696).
