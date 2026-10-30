---
impacto: nada_mudou
secao: corrigido
titulo: Devolução do atendimento, avisos do negócio e QR sem pareamento
---

O botão de devolver ao automático respeita o responsável da conversa, inclusive
quando outra pessoa assume durante a operação. Os avisos de atribuição, ganho e
perda consultam o registro do negócio quando a aba ainda não o conhece e usam o
instante exato da mudança, evitando reapresentar uma atribuição anterior.
Confirmações atrasadas respeitam o contexto e o responsável em vigor.

Quando um QR expira sem pareamento, a sessão é arquivada e libera a vaga do
plano. Se o número já conectou durante a operação, a conexão é preservada. O
histórico permanece disponível e o assistente pode retomar a mesma sessão.

Contribuições de @webtecnica nos PRs #3452, #3438 e #3423, incorporadas com
ajustes de concorrência e testes adicionais.
