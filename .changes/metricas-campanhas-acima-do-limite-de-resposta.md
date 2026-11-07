---
impacto: nada_mudou
secao: corrigido
titulo: Métricas de campanhas leem além do limite de uma resposta do banco
---

As contagens e o progresso de campanhas com mais destinatários que o limite de uma resposta do banco podiam considerar apenas o primeiro lote. A leitura agora continua em páginas, mantendo o teto de 20.000 destinatários e indicando quando existem linhas além dele. Uma campanha com exatamente 20.000 deixa de ser marcada como parcial apenas por atingir esse teto. As linhas e os estados podem mudar durante as consultas; a leitura não é um retrato atômico da campanha.

Correção identificada e inicialmente proposta por @Draven9 no PR #3571. Você não precisa fazer nada.
