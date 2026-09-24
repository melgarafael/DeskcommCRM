---
impacto: nada_mudou
secao: corrigido
titulo: As rotinas agendadas conferem a senha interna sem vazar pistas pelo tempo de resposta
---

As rotinas agendadas do sistema (as rotas em `/api/v1/cron/`) conferiam a senha interna (`INTERNAL_CRON_SECRET` ou `INTERNAL_SECRET`) comparando letra por letra e parando na primeira diferença. Medindo o tempo de resposta, quem tentasse de fora conseguia descobrir aos poucos quantas letras tinha acertado. Agora as 30 rotas conferem a senha pelo mesmo portão, que leva o mesmo tempo com senha certa ou errada, e um teste impede que uma rota nova volte a comparar à mão.

As rotas que só aceitavam o cabeçalho `Authorization: Bearer <senha>` passam a aceitar também `x-cron-secret: <senha>`, como as demais já faziam. Quem chama as rotinas continua funcionando do mesmo jeito: o operador não precisa fazer nada.

Contribuição de @FabioMundoDigital (#1431).
