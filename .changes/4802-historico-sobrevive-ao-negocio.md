---
impacto: nada_mudou
secao: corrigido
titulo: Remover um negócio não leva mais o histórico comercial dele junto
---

O histórico de um negócio (mudanças de etapa, perdas, ganhos, anotações da linha do tempo) era apagado em cascata quando o negócio era apagado: a chave estrangeira de `crm_lead_activities` para `crm_leads` era `ON DELETE CASCADE`, e a operação não avisava. Agora a referência é anulada, e a linha do histórico sobrevive — com o contato dela, que é por onde o histórico continua legível e por onde a anonimização do contato o alcança. A atualização preenche o contato nas linhas antigas que não o tinham, e a linha que não tem contato nenhum continua sendo apagada junto com o negócio, como antes. Se o contato for apagado depois do negócio, a linha que só ele segurava sai junto com ele — sem negócio e sem contato, ela ficaria fora do alcance da anonimização.

O contato e as conversas nunca foram apagados por essa operação: `crm_leads.contact_id` já era `ON DELETE SET NULL`. O que sumia era o histórico.

Contribuição de @webtecnica, a partir da issue #4802.
