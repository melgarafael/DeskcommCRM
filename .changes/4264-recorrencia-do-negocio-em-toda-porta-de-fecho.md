---
impacto: capacidade_nova
secao: adicionado
titulo: Ganhar ou perder um negócio pelo quadro, pelo botão e em lote também move a recorrência no financeiro
---

A recorrência do negócio já existia: quando um negócio com valor mensal era ganho pelo MCP ou por uma automação, o molde da receita nascia no financeiro sozinho. As outras portas de fecho — **arrastar o card para a coluna Ganho no quadro**, **o botão Ganhar/Perder** (e tudo que passa por ele: `/win`, `/lose`, clone, `crm_close_demand`, cold call, troca de funil) e **o mover em lote** — fechavam o negócio sem que o financeiro soubesse, e a mensalidade continuava sendo lançada à mão.

Agora as três portas criam o mesmo molde, com o mesmo valor, o mesmo dia do mês (o `created_at` do negócio) e a mesma duração de contrato, e a perda desativa o molde **daquele** negócio. Arrastar dentro da coluna Ganho (reordenar sem trocar de etapa) e mover em lote um card que já estava lá não criam um segundo molde. Nada disso depende de ação do operador: quem arrasta o card continua arrastando.

Se o financeiro estiver fora do ar, o movimento não é desfeito — o card move, o negócio fecha e a falha vira log com o id do negócio e o `request_id`, para o molde ser criado à mão se for o caso.

Contribuição de @webtecnica, a partir da issue #3602.
