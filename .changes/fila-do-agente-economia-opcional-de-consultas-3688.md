---
impacto: capacidade_nova
secao: adicionado
titulo: A fila de respostas do agente ganhou um modo econômico opcional, que reduz as consultas ao banco com o sistema parado
---

Com o sistema parado, o worker consulta a fila de respostas do agente a cada 2 segundos, cerca de 28 vezes por minuto (medido na issue #3688). Quem precisa poupar a cota do banco agora pode ligar `QUEUE_IDLE_MAX_INTERVAL_MS` no `.env` (por exemplo `60000`): com a fila vazia, a espera entre consultas dobra a cada rodada até esse teto, cerca de 1 consulta por minuto, e volta a 2 segundos no primeiro trabalho. Mensagem nova de cliente acorda a fila na hora, então a primeira resposta do agente não espera o teto; a resposta da equipe a um caso da IA e os disparos agendados pelo cron podem esperar até ele. Sem a variável, nada muda: o modo econômico vem desligado. Contribuição de @webtecnica, com a medição de @DPalmercs.
