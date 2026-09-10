---
impacto: nada_mudou
secao: corrigido
titulo: Instalador para de morrer numa VPS que nunca teve crontab
---

Numa VPS recém-provisionada, `crontab -l` sai com status 1 quando o usuário nunca teve
crontab — mesmo sem nenhum erro real, só aviso em stderr. Sob `pipefail`, esse status vazava
pelo pipe e o instalador morria antes de confirmar a automação, mesmo com a linha do cron já
gravada com sucesso. As duas automações afetadas (o dreno do event-log e o agente de
atualização) agora seguem instalando normalmente nesse caso.
