---
impacto: nada_mudou
secao: corrigido
titulo: O «Adicionar guardrail» do agente de voz cabe na tela do celular
---

No agente de voz › Guardrails, a linha do tipo de regra empurrava o botão «Adicionar guardrail» para fora da tela em 375 px e a página inteira rolava para o lado: em flex o filho `flex-1` tem `min-width: auto` e não encolhe abaixo do próprio conteúdo. Agora o seletor cede a largura que sobra e o botão fica na tela, com a aba vazia ou com uma regra adicionada (#5221). A 1280 px a linha continua em uma linha só, e o layout de 320 px também coube. Nenhum texto novo, então o dicionário não mudou.
