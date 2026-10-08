---
impacto: nada_mudou
secao: corrigido
titulo: A conferência de fato deixa de barrar resposta cujo preço está no material, mesmo quando o agente junta itens ("Flexível ou fosca: R$ 119,90")
---

Quando o agente resumia o catálogo com as próprias palavras, a conferência de fato podia marcar como "fora da base" uma frase cujo preço estava escrito no material, e em modo decidindo a resposta era barrada. Agora, antes de vetar, o preço é normalizado (`R$ 119,90`, `119,90` e `119.90` são o mesmo valor), e a frase passa só se cada item nomeado tiver aquele preço no material.

O guardrail não afrouxa para o resto: preço de outro item, preço sem item nomeado e texto extra sem base depois do preço seguem barrados. Nada precisa ser feito ao atualizar.

Contribuído por @webtecnica (PR #2610); relatado por @brunno-soaress (issue #2582).
