---
impacto: nada_mudou
secao: corrigido
titulo: Webhook da Meta com payload fora do contrato responde 200, fica arquivado como erro e abre um aviso na Central, em vez de pedir reentrega
---

Quando a Meta mandava um conteúdo num formato que o sistema não reconhece, a
resposta era um erro, e a Meta reenviava o mesmo conteúdo por horas. Agora o
sistema confirma o recebimento, guarda o conteúdo recusado como erro e abre um
aviso na Central para alguém olhar. A mensagem recusada continua não entrando
na conversa. Contribuição de @webtecnica.
