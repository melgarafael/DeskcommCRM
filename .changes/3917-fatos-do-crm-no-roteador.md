---
impacto: capacidade_nova
secao: adicionado
titulo: Roteador de intenção decide sabendo o que o contato já tem no CRM
---

O classificador do roteador escolhia o agente só pelo texto da mensagem e
pelas últimas mensagens da conversa. Numa agência de viagens com vendas e
pós-venda no mesmo número, a cliente que já tinha viagem fechada escreveu
"Bom dia! Tudo bem?" e foi para o vendas; na mensagem seguinte, "Agradeço",
foi para o pós-venda — duas despedidas diferentes na mesma conversa.

O classificador passa a receber os **funis e etapas com negócio aberto** e as
**etiquetas** do contato, sempre restritos à organização da conversa. Contato
sem negócio aberto não recebe bloco nenhum: o prompt continua idêntico ao de
antes, e a decisão continua sendo do modelo, com o mesmo JSON de saída.
A lista é limitada (até 3 funis, 2 etapas por funil e 8 etiquetas) e diz
quando truncou. Se a leitura do CRM falhar, o turno classifica como antes e
registra o motivo — o atendimento não para.
