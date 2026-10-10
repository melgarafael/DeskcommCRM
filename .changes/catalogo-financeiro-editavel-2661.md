---
impacto: capacidade_nova
secao: adicionado
titulo: Configurações › Financeiro ganha Editar em contas, formas de pagamento, plano de contas, regras de comissão e lançamentos recorrentes
---

Configurações › Financeiro: contas, formas de pagamento, plano de contas, regras de comissão e lançamentos recorrentes ganham Editar, sem desativar e recadastrar — contribuição de @webtecnica (#2661, Closes #2641).

Junto, dois defeitos da edição pela API: editar uma regra de comissão respondia erro 500, e editar uma conta zerava o saldo inicial e voltava a moeda para BRL quando esses campos não vinham no pedido. Editar não reescreve lançamentos nem comissões já gerados. Nada precisa ser feito ao atualizar.
