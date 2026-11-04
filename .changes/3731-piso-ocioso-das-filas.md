---
impacto: nada_mudou
secao: alterado
titulo: O cron das filas vazias para de consultar o banco — instalação ociosa gasta menos cota
---

Numa instalação parada, nove rotas de cron batiam no PostgREST a cada 5 minutos
só para descobrir que a fila estava vazia: soneca vencida, mensagem presa, fila
de redação de objeto, devolução de handoff, devolução ao rodízio, saúde de
canal, revogação de acesso MCP vencido, lembrete de tarefa e lembrete de
agenda. Juntas eram 15 consultas por batida — 2,4 requisições por minuto
(144/h) que consumiam a cota do banco sem ninguém usando o produto, e no
plano grátis do Supabase isso é o caminho para a instalação cair em `PGRST002`.

Agora cada uma dessas rotas consulta o retrato em memória do piso ocioso
(`lib/cron/piso-ocioso.ts`) antes de qualquer outra coisa e sai na hora quando a
fila está vazia. O retrato é uma consulta só, compartilhada pelas rotas, e vai
pelo pool do Postgres — não gasta requisição do PostgREST, que é a cota que
estoura. Nada muda para quem usa o recurso: a rodada roda igual, e o recurso
que passa a ter trabalho volta na batida seguinte. Se a leitura do retrato
falhar, a rota roda — o portão economiza cota, não decide se um recurso
funciona.

Medido no crontab inteiro, com o banco vazio e as mesmas rotas: o piso das
rotas de fila cai de 3,0 para 0,6 req/min (as 0,6 são da poda de log de webhook,
que fica para outra fatia). A soma do crontab, fora o `event_log`, cai de 7,7
para 5,3 req/min.

Refs #3731.
