---
impacto: nada_mudou
secao: corrigido
titulo: Regra com gatilho «Negócio ganho» ou «Negócio perdido» volta a iniciar o follow-up de WhatsApp
---

Uma regra com gatilho «Negócio ganho» (ou «Negócio perdido») que cria um card e inicia um follow-up de WhatsApp terminava pela metade: o card aparecia, mas a ação de mensagem falhava por dentro e a execução ficava marcada como parcial. A inscrição no follow-up nunca nascia, e como o card era criado ninguém percebia que a mensagem não tinha começado. A causa era o resolvedor que liga o evento ao contato da conversa: ele conhecia a criação, a mudança de etapa, a etiqueta e as datas do negócio, mas não o ganho nem a perda.

Agora o ganho e a perda do negócio também resolvem o contato, e o follow-up de WhatsApp começa como qualquer outra ação de mensagem. Regras que já funcionavam continuam idênticas, e um gatilho que ainda não pode mandar mensagem segue recusado — a reabertura do negócio, por exemplo, continua fora.

Não há nada a configurar nem a migrar à mão: a atualização aplica a correção sozinha.
