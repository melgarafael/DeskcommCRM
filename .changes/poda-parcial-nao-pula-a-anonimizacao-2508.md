---
impacto: nada_mudou
secao: corrigido
titulo: Uma poda de retenção que falha não pula mais a anonimização do dia nem some com as contagens das outras podas
---

O cron diário de retenção poda dezesseis tabelas em sequência e, no fim, retoma as anonimizações de LGPD que ficaram pela metade (o prazo legal é de quinze dias). Se qualquer poda falhasse — uma função ausente num clone, um grant que não veio na atualização —, as podas seguintes não rodavam, a retomada de anonimização daquele dia era pulada e a auditoria registrava só "falhou", sem as contagens do que já tinha sido apagado. Agora cada poda falha sozinha e é nomeada no relatório e na auditoria, junto com as contagens das podas que funcionaram, e a retomada de anonimização roda de qualquer jeito. O cron continua terminando com erro quando alguma poda falha, agora dizendo quais.

Contribuição de @Tong-bit-art (#2645), a partir da issue #2508.
