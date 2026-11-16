---
impacto: nada_mudou
secao: corrigido
titulo: A taxa de cache da tela Uso de IA conta só as chamadas que podem cachear
---

A tela dividia o cache lido pelos tokens de entrada de todas as chamadas do
período. Chamada com menos de 1.024 tokens de entrada nunca vai para cache (os
classificadores, a conferência de campo, as extrações curtas), então ela entrava
no denominador sem chance de entrar no numerador e puxava a taxa para baixo — no
caso medido na issue, 8,2% no total contra 50,0% só nas chamadas cacheáveis.

A taxa passa a usar o mesmo corte do aviso "cache hit de prompt abaixo do alvo"
(`lib/ai/cache-de-prompt.ts`): a função `fn_uso_de_ia` devolve também
`chamadas_cacheaveis`, `input_tokens_cacheaveis` e `cache_read_tokens_cacheaveis`,
e o cartão divide por eles. Os totais de custo, tokens e latência continuam sendo
de todas as chamadas — só a taxa de cache mudou de régua.
