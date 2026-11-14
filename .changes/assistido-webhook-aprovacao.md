---
impacto: alterado
secao: corrigido
titulo: Webhook de saída espera aprovação no modo assistido
---

Quando uma automação da etapa de um card movido pelo agente contém `call_webhook`, a ação agora fica parada no modo assistido e aparece na Central para aprovação humana. A mesma proteção vale quando `ai_decide` pode escolher o webhook. No modo automático ou quando uma pessoa move o card, o webhook continua funcionando normalmente. Isso evita que um sistema externo receba um evento e envie mensagens ao cliente antes da aprovação.
