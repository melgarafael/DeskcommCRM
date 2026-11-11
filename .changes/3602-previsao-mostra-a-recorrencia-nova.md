---
impacto: capacidade_nova
secao: adicionado
titulo: A previsão do funil passa a mostrar a recorrência nova, ao lado do valor único
---

A previsão do funil — painel **Previsão** em Métricas, `GET
/api/v1/pipelines/{id}/forecast` e a tool `crm_get_pipeline_forecast` — projetava
só `value_cents`. Quem vende setup + mensalidade via o contrato de R$ 3.000 +
R$ 500/mês como **R$ 3.000**, seis vezes menor, e a mensalidade nova não
aparecia em número nenhum do cronograma.

Cada balde (mês × moeda, total, "sem data" e "sem probabilidade") passa a trazer
**duas parcelas**, com o mesmo par bruto/ponderado e a mesma probabilidade:
`unico` (o setup) e `recorrente_mensal` (a mensalidade). Elas nunca são somadas
— entram em meses diferentes do caixa. Os campos antigos `bruto_cents` e
`ponderado_cents` continuam iguais (só o valor único), então nada que já lia a
resposta muda de número.

Recorrência que não é mensal não vira parcela mensal: aparece à parte em
`recorrencia_nao_mensal`, com o valor. A duração do contrato
(`recurring_months`) não multiplica a projeção: a previsão é do mês de
fechamento, não do contrato inteiro.
