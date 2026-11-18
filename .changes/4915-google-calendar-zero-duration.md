---
impacto: nada_mudou
secao: corrigido
titulo: Poda eventos de duração zero na sincronização do Google Agenda (#4915)
---

Eventos de terceiros com duração zero no Google Agenda (início igual ao fim) travavam a sincronização incremental para sempre devido à violação do check `calendar_external_events_periodo_valido`. Agora esses eventos são podados na leitura da página antes da gravação no banco, sem ocupar slots nem cancelar compromissos no CRM. Quando um evento é recusado, o erro identifica a data e hora do evento sem expor título ou dados de participantes, e falhas de sincronização são registradas de forma estruturada no log.
