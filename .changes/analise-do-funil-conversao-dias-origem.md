---
impacto: capacidade_nova
secao: adicionado
titulo: Análise do funil na API — conversão por etapa, dias até fechar e ganho × perda por origem
---

A rota `GET /api/v1/metrics/funil` responde as três perguntas básicas do funil que hoje não têm resposta: quantos passam de cada etapa para a seguinte (sempre com a amostra da própria linha, e `null` — nunca `0` — quando não há medida), quanto tempo leva do primeiro contato ao fechamento (mediana e quartis, só dos ganhos, com a palavra "mediana" no payload) e de que origem vêm os que fecham (ganhos × perdas por origem, com valor somado **por moeda**, sem total cruzando moedas). A conversão é reconstruída das passagens de etapa já registradas — as feitas à mão e também as feitas pelo agente, pelo handoff e pela agenda: nenhuma tabela nova, nenhuma migration.

A contra-métrica vem no mesmo corpo, como manda a doutrina: turnos até o desfecho e opt-outs medidos na mesma janela pelo `fn_atrito_metrics` que alimenta o Índice de Atrito — se essa leitura falhar, os números vêm nulos com a razão escrita, não somem e não viram zero.

Ainda não há painel em `/app/metrics`: esta entrega é a consulta (rota + contas testadas sem banco); a tela é o passo seguinte da mesma issue.

Contribuição de @webtecnica (#2222).
