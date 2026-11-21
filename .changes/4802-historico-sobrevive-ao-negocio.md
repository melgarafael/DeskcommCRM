---
impacto: nada_mudou
secao: corrigido
titulo: Remover um negócio não leva mais o histórico comercial dele junto
---

O histórico de um negócio (mudanças de etapa, perdas, ganhos, anotações da linha do tempo) era apagado em cascata quando o negócio era apagado: a chave estrangeira de `crm_lead_activities` para `crm_leads` era `ON DELETE CASCADE`, e a operação não avisava. Agora a referência é anulada, e a linha do histórico sobrevive — com o contato dela, que é por onde o histórico continua legível.

O contato e as conversas nunca foram apagados por essa operação: `crm_leads.contact_id` já era `ON DELETE SET NULL`. O que sumia era o histórico.

Contribuição de @webtecnica, a partir da issue #4802.
