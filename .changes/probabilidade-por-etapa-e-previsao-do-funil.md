---
impacto: capacidade_nova
secao: adicionado
titulo: Chance de fechamento por etapa e previsão ponderada do funil
---

Em **Configurações › Funis**, cada etapa aberta ganha o campo **Chance de fechamento (0 a 100)**, calibrado por quem gere a equipe. Etapas de ganho e de perda valem 100 e 0 automaticamente. No quadro, cada coluna mostra o valor **ponderado** abaixo do total. Em **Métricas**, o painel **Previsão** mostra o valor bruto e o ponderado por mês de fechamento previsto e por moeda (moedas nunca são somadas); negócios sem data prevista e em etapa sem chance configurada aparecem à parte, em vez de sumirem como zero. A previsão respeita o que cada atendente pode ver. A API ganha `GET /api/v1/pipelines/{id}/forecast` e a tool MCP `crm_get_pipeline_forecast`; `crm_update_stage` e `crm_list_stages` passam a aceitar e devolver `win_probability`.

A coluna nova `crm_stages.win_probability` nasce vazia em todas as etapas: nada muda até alguém configurar a chance.

Não há ação para quem opera a VPS.

Contribuição de @webtecnica (#1716, issue #1535).
