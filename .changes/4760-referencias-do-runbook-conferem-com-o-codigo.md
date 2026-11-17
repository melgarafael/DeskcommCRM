---
impacto: nada_mudou
secao: corrigido
titulo: O runbook de custo do Supabase cita as linhas certas do scheduler e o texto certo da tela de erro
---

Duas coisas do runbook mandavam a pessoa olhar o lugar errado. A referência ao cron `data-retention` apontava para a linha 163 do `docker/scheduler/entrypoint.sh` — que hoje é a do `lead-time-triggers`, um cron que não tem nada a ver com retenção; o `data-retention` mora na linha 175. A do `media-retention` apontava para a 167 e ele está na 179. Quem abria o arquivo na linha indicada encontrava outro cron e concluía que a retenção não existia. E a frase que o runbook punha na tela de erro de segmento era “Algo de errado”, com a palavra faltando: a tela diz “Algo deu errado”. Nada muda em quem já opera uma instalação — é texto de documentação, conferido contra o código.
