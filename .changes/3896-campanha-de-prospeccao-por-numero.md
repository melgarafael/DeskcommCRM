---
impacto: capacidade_nova
secao: adicionado
titulo: Prospecção com uma campanha em andamento por número de WhatsApp
---

Uma organização com três conexões conectadas deixa de ficar limitada a
**uma campanha de prospecção por vez**: cada número pode ter a sua, com agente,
região e aquecimento próprios. A segunda campanha em outro número é aceita e o
worker envia pelas duas na mesma rodada; a que estava bloqueada respondia
"Pause a campanha atual antes de iniciar outra".

O que continua igual, e de propósito:
**duas campanhas no MESMO número seguem bloqueadas**. O aquecimento é do
número, não da campanha — duas listas no mesmo número dobrariam as primeiras
abordagens dele, que é o comportamento que a plataforma pune com banimento. A
recusa agora diz qual campanha ocupa a conexão, com o código
`prospecting_channel_busy` e o nome de quem está lá; basta pausar essa
campanha para liberar o número.

O teto de 50 tentativas em 24 horas, o teto de aquecimento e o intervalo mínimo
passam a ser contados **por número**. Antes eram da organização inteira: com
duas campanhas rodando, os dois números dividiam as mesmas 50 abordagens do dia
e o mesmo intervalo — o volume de um número só. Agora a tentativa de um número
não consome nem segura a cota do outro, e a soma dos números é a soma das cotas.

Em banco: `prospecting_campaigns.channel_session_id` vira coluna (com backfill
de `config->>'channel_session_id'`), o índice único parcial
`prospecting_one_running_org` dá lugar a `prospecting_one_running_canal`
em `(organization_id, channel_session_id)`, e uma campanha `running` que tenha
ficado sem conexão válida é pausada pela migration com o motivo no cartão.
