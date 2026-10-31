---
impacto: nada_mudou
secao: adicionado
titulo: A pergunta do roteiro de atendimento pode gravar a resposta no card do negócio, e cada negócio responde por si
---

Cada pergunta do roteiro de atendimento ganhou "Onde a resposta é guardada":
ficha do contato (o de sempre — e o padrão, inclusive para todo roteiro já
publicado) ou card do negócio aberto do contato. Com o card, o valor entra em
`crm_leads.custom_fields`, que é o que o card da tela, os campos obrigatórios
da etapa do funil e as automações por data leem; e a pergunta é refeita a cada
novo negócio da mesma pessoa — o destino da viagem anterior não vale para a
viagem seguinte. Pergunta sem essa marca continua gravando no contato, byte a
byte como hoje, e a ficha do contato mostra "no card do negócio" em vez de
"não respondido" para a resposta que mora no card.
