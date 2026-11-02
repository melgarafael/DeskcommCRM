---
impacto: nada_mudou
secao: corrigido
titulo: A cerca do e2e do alvo de toque mede a caixa do alvo, e não um ponto a 1px da borda dela
---

O e2e do celular provava o alvo de toque do link «Ver conversa» cravando um ponto a 21px do centro de uma área declarada de ±22px — 1px antes da borda. Duas execuções do mesmo tree deram resultados opostos: numa delas o container do caso estava rolado, o topo do link ficava recortado pela área que rola e o ponto a 21px acima do centro deixava de existir para o dedo, enquanto a altura declarada do alvo continuava 44px (recorte não é layout). A cerca passou a medir a geometria do alvo — os 44px do `::before` —, a conferir que a caixa está inteira dentro da área visível e a tocar 4px dentro da borda declarada, com controle 4px fora. Nada muda no produto: o alvo continua o mesmo 44px. Contribuição de @webtecnica (#3844).
