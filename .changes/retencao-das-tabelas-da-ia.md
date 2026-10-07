---
impacto: capacidade_nova
secao: adicionado
titulo: Os registros que a IA grava a cada conversa passam a ter prazo de guarda configurável
---
Sete tabelas que a IA preenche a cada mensagem nunca eram limpas e cresciam para sempre: o custo de cada chamada à IA, as métricas dos turnos, as ativações de skills, as decisões do roteador, o registro de envios do ritmo anti-banimento, as cópias das mensagens enviadas e os resumos de atendimento do agente. A limpeza diária que já existia (`data-retention`) passa a cuidar delas também, em lotes pequenos, e cada rodada que apaga alguma coisa deixa uma linha `retention.sweep_run` na auditoria com a contagem.

Os padrões, que valem sem você mexer em nada:
- custo, métricas, skills e roteador: 400 dias (`AI_TELEMETRY_RETENTION_DAYS`, mínimo 100). As telas de uso olham no máximo 90 dias, e o orçamento olha o mês corrente;
- registro de envios do ritmo: 2 dias (`PACING_LEDGER_RETENTION_DAYS`, mínimo 2). O último envio de cada número nunca é apagado;
- cópias das mensagens enviadas: 30 dias (`OUTBOUND_COPIES_RETENTION_DAYS`, mínimo 7). As últimas que o bloqueio de texto repetido compara (20 por número, ou o que estiver configurado) nunca são apagadas;
- resumos de atendimento: 180 dias (`LEAD_CHECKPOINT_RETENTION_DAYS`, mínimo 30), e só os resumos já substituídos por um mais novo. O resumo em vigor de cada atendimento nunca sai, nem o que um trabalho ainda na fila vai ler.

**Se você quer guardar mais histórico do que o padrão, suba a variável ANTES de atualizar:** a primeira limpeza depois da atualização já apaga pelo prazo em vigor, e o que ela apagou não volta.

Para mudar um prazo, ponha a variável no `.env` com o número de dias e recrie o app. Um valor abaixo do mínimo vira o mínimo, com aviso no log; um valor que não é número vira o padrão. Os mínimos moram dentro das funções de limpeza do banco, então nem chamando a limpeza à mão dá para apagar menos dias do que o mínimo. O mínimo vale para a limpeza: um `DELETE` digitado direto no banco não passa por ele.

O primeiro dia depois da atualização pode apagar bastante numa instalação antiga: a limpeza anda em lotes e termina ao longo de alguns dias, sem travar o sistema. O espaço liberado volta a ser usado pelo banco, mas o tamanho do arquivo no disco só diminui com um `VACUUM FULL`, que o runbook `docs/runbooks/custo-e-cota-do-supabase.md` explica. A fila de gatilhos de tempo (`event_log`) continua sem limpeza de propósito: é ela que impede o mesmo WhatsApp de ser enviado duas vezes.
