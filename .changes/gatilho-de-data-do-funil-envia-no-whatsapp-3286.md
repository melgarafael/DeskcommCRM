---
impacto: nada_mudou
secao: corrigido
titulo: A regra com gatilho de data do funil voltou a enviar a mensagem no WhatsApp
---
Uma regra de automação com o gatilho "data do funil" (o campo de data de um negócio, avisando X dias antes ou depois) e a ação "Mensagem no WhatsApp" nunca enviava: a execução aparecia como "Falhou" na aba Atividade e o cliente não recebia nada, enquanto as demais ações da mesma regra (criar tarefa, mover card) funcionavam. Era o mesmo defeito que já havia sido corrigido para a regra de aniversário e para os avisos de agenda, faltando o gatilho de data do funil. Agora ele é reconhecido do mesmo jeito, e a mensagem sai. Nada a fazer na atualização. Crédito: @webtecnica.
