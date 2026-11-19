---
impacto: nada_mudou
secao: adicionado
titulo: Nível `telas_principais` passa a ter régua medida, e um idioma novo aparece sem cobrar toda frase
---

O nível `telas_principais` do registro de idiomas deixou de ser uma promessa sem critério: existe agora a régua que o confere. As telas principais são os destinos do menu lateral, derivados de `lib/navigation/registry.ts` — nunca uma lista escrita à mão —, e a cobertura de frases é medida pelo grafo de imports de cada rota, para que a conta alcance o componente onde a tela de fato mora.

Medido nesta árvore: 16 telas e 4.573 frases distintas, com piso de dois terços. Quem declara o nível é aprovado quando atende a régua e recusado quando não atende, com o número do que falta — antes, qualquer declaração era recusada. O nível `completo` não mudou: o espanhol continua cobrando toda frase de tela. Nenhum idioma é promovido nesta fatia.
