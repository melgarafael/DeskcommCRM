---
impacto: nada_mudou
secao: corrigido
titulo: O agente passa a gravar o que coleta nos campos do negócio
---

O agente de IA (o papel Conversador) agora recebe o identificador do negócio
(o card do funil) de cada pessoa e aprende, na abertura do turno, a usar esse
id — e não o do contato — nas ferramentas do CRM que pedem `lead_id`. Antes,
ele usava o identificador do contato, o CRM recusava a gravação e os campos do
negócio ficavam vazios.

Para funcionar, o funil precisa estar liberado para o agente em
**Agente de IA › Agentes › (seu agente) › Em que negócios ele pode mexer**.
