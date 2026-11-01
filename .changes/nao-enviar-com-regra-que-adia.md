---
impacto: nada_mudou
secao: corrigido
titulo: A regra marcada "não enviar" deixa de enviar quando outra regra do mesmo gatilho espera o horário marcado
---

Na mensagem de WhatsApp de uma automação (texto fixo ou escrito pela IA), a opção "Quando o contato tiver horário marcado" pode ser "esperar", "enviar mesmo assim" ou "não enviar". Com duas automações no mesmo gatilho, uma em "não enviar" e outra em "esperar", a segunda segurava as duas: a "não enviar" só era conferida quando o horário já tinha passado (ou alguém o marcava como concluído na Agenda) e, como o contato já não tinha mais horário marcado, ela enviava a mensagem. Sozinha, ela já pulava o envio, como devia.

Agora a decisão de "não enviar" é tomada na hora em que o gatilho acontece e fica guardada: quando a automação que esperava chega à vez dela, a "não enviar" pula o envio e registra o motivo na aba Atividade, mesmo que o horário já tenha passado. As automações do mesmo gatilho continuam esperando juntas, como antes.

Com uma automação só, nada muda.

Você não precisa fazer nada.
