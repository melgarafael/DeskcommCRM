---
impacto: nada_mudou
secao: corrigido
titulo: A regra marcada "não enviar" deixa de enviar quando outra regra do mesmo gatilho espera o horário marcado
---

Na mensagem de WhatsApp de uma automação (texto fixo ou escrito pela IA), a opção "Quando o contato tiver horário marcado" pode ser "esperar", "enviar mesmo assim" ou "não enviar". Com duas automações no mesmo gatilho, uma em "não enviar" e outra em "esperar", a segunda segurava as duas: a "não enviar" só era conferida quando o horário já tinha passado (ou alguém o marcava como concluído na Agenda) e, como o contato já não tinha mais horário marcado, ela enviava a mensagem. Sozinha, ela já pulava o envio, como devia.

Agora cada automação decide na hora em que o gatilho acontece. A que está em "não enviar" pula o envio e registra o motivo na aba Atividade. Só a que está em "esperar" espera. Uma automação do mesmo gatilho que não precisa esperar também roda na hora: antes, ficava parada junto da outra. Quando o gatilho volta para a automação que estava esperando, as que já rodaram não rodam de novo, e nenhuma mensagem sai duas vezes.

Com uma automação só, nada muda.

Você não precisa fazer nada.
