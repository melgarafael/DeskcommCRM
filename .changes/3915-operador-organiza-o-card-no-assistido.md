---
impacto: capacidade_nova
secao: adicionado
titulo: Em modo assistido, o Operador passa a organizar o card
---
Com o agente em modo assistido, o Operador deixa de ficar parado: depois de cada rascunho, ele move o card de etapa, aplica tags e preenche campos, sem nunca enviar mensagem ao cliente. Quando ele move o card, as automações de mudança de etapa disparam do mesmo jeito que no modo automático. Agente pausado continua sem rodar nada, e conversa assumida por uma pessoa continua fora do alcance do Operador. O `crm_list_stages` passa a devolver também `description` (o critério de cada etapa) e `agent_stage_hint` (a que passo do funil do agente ela corresponde).

Contribuição de @felipehenriquess (#3915).
