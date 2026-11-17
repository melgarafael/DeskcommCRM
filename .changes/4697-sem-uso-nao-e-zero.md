---
impacto: nada_mudou
secao: corrigido
titulo: Chamada sem medição de uso deixa de gravar custo zero, e o custo nulo passa a dizer o motivo
---

Depois da regra única do custo (#4700), faltava o outro lado do defeito do #4697: a chamada que o provedor **não mediu**. Quando a resposta chega sem `usage` — gateway sem contagem, resposta cortada, assinatura que devolve o bloco vazio —, o preço de tabela vezes zero token dá `0`, e esse `0` entrava em `cost_cents` com cara de número medido: o painel de custo e o teto de gasto, que somam `coalesce(cost_cents, 0)`, liam "esta chamada foi de graça" quando o que faltava era o dado. Agora toda rota que grava chamada pergunta antes se o provedor mediu uso (`haUsoMedido`): sem medição, o custo é nulo com o motivo `sem_uso`, que é distinto de `sem_preco` (uso medido, preço desconhecido) — os dois nulos deixam de se confundir no log da linha. O nulo, e não o zero, é o que acende o aviso de gasto incompleto na tela de Orçamento; zero apagava esse sinal. Junto veio a divergência entre rotas: a legada (`computeCost`, dos workers de resposta e de sentimento) consultava `ai_pricing` antes da tabela do motor, enquanto o seam consultava `pricing.ts` — o mesmo modelo podia sair com número numa rota e nulo na outra. As duas passam a resolver na mesma ordem. Nenhuma linha já gravada é reescrita: a correção é só do caminho de escrita novo.

Contribuição de @webtecnica (#4697).
