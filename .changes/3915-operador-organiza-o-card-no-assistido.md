---
impacto: capacidade_nova
secao: adicionado
titulo: Em modo assistido, o Operador passa a organizar o card
---
Com o agente em modo assistido, o Operador deixa de ficar parado: depois de cada rascunho, ele move o card de etapa, aplica tags e preenche campos, sem nunca enviar mensagem ao cliente: no assistido, mesmo que a lista de ferramentas do Operador inclua alguma que envia mensagem, agenda retorno ou escreve num servidor externo, ela fica fora da mão dele. Quando ele move o card, as automações da etapa rodam o que não fala com o cliente (etiqueta, tarefa, aviso à equipe); WhatsApp, e-mail, mensagem da IA e sequência ficam parados, e a Central de avisos mostra o que parou com o botão "Disparar agora" para quem é gestor. Marcar o aviso como resolvido descarta o envio. No modo automático, e quando quem move é uma pessoa, as automações rodam como antes. Agente pausado continua sem rodar nada, e conversa assumida por uma pessoa continua fora do alcance do Operador. O `crm_list_stages` passa a devolver também `description` (o critério de cada etapa) e `agent_stage_hint` (a que passo do funil do agente ela corresponde).

Contribuição de @felipehenriquess (#3915).
