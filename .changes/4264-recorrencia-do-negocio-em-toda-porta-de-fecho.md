---
impacto: nada_mudou
secao: alterado
titulo: O quadro, os botões Ganhar e Perder e o mover em lote passam pela mesma regra da recorrência do negócio
---

A recorrência do negócio (o molde mensal que nasce no financeiro quando um negócio com valor mensal é ganho) só era consultada quando o negócio fechava pelo MCP ou por uma automação. As outras portas de fecho — **arrastar o card para a coluna Ganho ou Perdido no quadro**, **os botões Ganhar e Perder** (e tudo que passa por eles: `/win`, `/lose`, clone, `crm_close_demand`, cold call, troca de funil) e **o mover em lote** — não chegavam a essa regra.

Agora as três portas passam pela mesma regra, com o mesmo valor, o mesmo dia do mês e a mesma duração de contrato, e a perda desativa só o molde **daquele** negócio. Reordenar dentro da coluna Ganho, ou mover em lote um card que já estava lá, não cria um segundo molde. Se o financeiro falhar, o movimento não é desfeito: o card move, o negócio fecha e a falha vai para o log com o id do negócio e o `request_id`.

**Para quem atualiza, nada muda.** A opção que liga a recorrência no ganho continua desligada de fábrica e ainda não tem tela, então nenhum molde é criado e nenhuma ação é necessária. O interruptor nas configurações do financeiro chega na etapa seguinte.

Contribuição de @webtecnica (#4264, issue #3602).
