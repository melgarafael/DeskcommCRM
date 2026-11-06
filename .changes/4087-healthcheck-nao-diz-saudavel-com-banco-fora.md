---
impacto: nada_mudou
secao: corrigido
titulo: O healthcheck só diz "app saudável" quando o app está saudável
---

O diagnóstico do kit (`hostgator-setup-kit/healthcheck.sh`) decidia a saúde do app com um `grep` pelo
status `ok` no JSON do `/api/v1/health`. `ok` é o vocabulário dos **checks individuais**, não o do
status GERAL (`healthy` | `degraded` | `unhealthy`): com o **banco fora** e o Redis de pé,
`checks.redis.status` casava e a linha `✓ app saudável` aparecia — e o script ainda saía 0, então nem
cron nem monitor podiam usá-lo como alarme.

Agora quem decide é a sonda do próprio kit, `app_health_probe` de `_common.sh` — a mesma que o
`install.sh` e o `update.sh` já usavam. `✓ app saudável` só com o status geral `healthy`; `degraded`
sai em amarelo e `unhealthy` em vermelho, com o JSON acima dizendo qual check caiu. Corpo vazio, JSON
ilegível e app mudo também reprovam: **falha fechada**, nunca aberta.

O `healthcheck.sh` passa a sair **1** quando o app não está saudável — `degraded` inclusive, que na
instalação é tolerado (serviço opcional ainda não configurado) mas num diagnóstico chamado à mão não
é "saudável".
