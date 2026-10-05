---
impacto: nada_mudou
secao: corrigido
titulo: O funil de Desempenho não mostra mais a organização anterior depois da troca
---

O card **Funil** de Análise › Desempenho pedia `/api/v1/metrics/attendants`, rota que resolve o escopo no cookie da organização ativa — ou seja, a mesma URL devolve o funil de quem estiver ativa naquele instante. A chave do cache, porém, não levava a organização, então as duas empresas dividiam uma única entrada: depois de trocar de organização, o card continuava com as etapas da anterior (com 0 abertos) e só um Ctrl+F5 resolvia.

A organização ativa agora entra na chave da query, e uma entrada gravada para uma organização nunca é servida para outra. Sem mudança de comportamento para quem usa uma organização só: é a mesma consulta, a mesma rota e os mesmos tempos de cache — o que muda é que a resposta deixa de atravessar a troca.

Contribuição de @webtecnica (#2333).
