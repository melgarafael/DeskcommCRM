---
impacto: nada_mudou
secao: corrigido
titulo: Mensagens seguidas do mesmo contato viram uma resposta só, e a espera para de crescer sem fim
---

Quando o cliente escreve em várias bolhas — o jeito normal de digitar no
WhatsApp —, o CRM já juntava as mensagens do mesmo contato numa resposta só.
Mas a janela dessa junção era fixa: nascia com a primeira mensagem e não andava
mais. Uma rajada de bolhas com 10–20 segundos de intervalo caía fora dela, e o
agente respondia uma vez para cada bolha, como se fossem assuntos diferentes.

Agora a janela **anda** a cada mensagem nova do mesmo contato, e para num teto
contado da primeira mensagem da rajada (`INBOUND_BURST_MAX_MS`, 45 s por
padrão). Passado o teto, a mensagem seguinte abre uma rajada nova — quem escreve
sem parar continua sendo respondido, só que uma vez por rajada em vez de uma vez
por bolha. Quem escreveu uma mensagem só e parou continua recebendo a resposta
no mesmo tempo de antes.

No medido: uma rajada de 8 bolhas que antes virava 8 turnos passa a virar 4, e a
espera da última mensagem cai de ~170 s para ~50 s. Nada a fazer na atualização.

O valor do teto é uma **proposta** — a faixa sugerida na issue era 30–45 s, e
45 s cobre com folga a rajada medida em produção (29,6 s entre a primeira e a
última bolha). Se preferir 30 s, é uma variável de ambiente, sem migração.
