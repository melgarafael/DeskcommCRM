---
impacto: nada_mudou
secao: corrigido
titulo: Mensagens seguidas do mesmo contato viram uma resposta só, e a espera para de crescer sem fim
---

Quando o cliente escreve em várias bolhas — o jeito normal de digitar no WhatsApp —, o CRM já juntava as mensagens do mesmo contato numa resposta só. Mas a janela dessa junção era fixa: nascia com a primeira mensagem e não andava mais. Uma rajada de bolhas com 10 a 20 segundos de intervalo caía fora dela, e o agente respondia uma vez para cada bolha, como se fossem assuntos diferentes.

Agora a janela **anda** a cada mensagem nova do mesmo contato e para num teto contado da primeira mensagem da rajada: 45 s por padrão, na variável `INBOUND_BURST_MAX_MS` do worker (`0` volta à janela fixa de antes). Passado o teto, a mensagem seguinte abre uma rajada nova: quem escreve sem parar continua sendo respondido, uma vez por rajada em vez de uma vez por bolha. Quem escreveu uma mensagem só e parou recebe a resposta no mesmo tempo de antes.

Numa simulação com teto de 18 s, uma rajada de 8 bolhas que virava 8 turnos passa a virar 4, e a espera da última mensagem cai de ~170 s para ~50 s. Nada a fazer na atualização. Contribuição de @webtecnica, a partir da issue #196 de @Gervanno.
