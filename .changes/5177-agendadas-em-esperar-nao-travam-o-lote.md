---
impacto: nada_mudou
secao: corrigido
titulo: Mensagens agendadas esperando um número desconectado não travam mais as outras
---

Quando um número ficava fora do ar com a opção "esperar", as mensagens agendadas dele ocupavam todas as vagas de cada rodada de envio, e uma mensagem agendada para outro número, conectado, podia nunca sair. Agora quem está esperando cede a vez a cada rodada: as mensagens dos números conectados saem no horário, e as que esperam continuam agendadas, com o texto, e são enviadas quando o número voltar. Contribuição de @webtecnica, a partir da issue #5060 relatada por @samirhvbr.
