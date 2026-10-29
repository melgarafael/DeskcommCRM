---
impacto: nada_mudou
secao: corrigido
titulo: "A etiqueta aplicada por um follow-up agora dispara as automações de etiqueta"
---

O nó **Editar tag do lead** de um follow-up aplicava a etiqueta, mas as regras de automação com o gatilho "Quando um lead ganhar uma etiqueta" (ou "contato ganhou etiqueta") ignoravam essa etiqueta, como se ela tivesse vindo de outra regra. Agora o padrão "o follow-up classifica, etiqueta, e a regra age" funciona: uma nota baixa no NPS que vira `nps-detrator` passa a abrir o card de pós-venda. A proteção contra regra disparando regra continua igual. Nada muda na VPS.

Crédito: @webtecnica (conserto) e @aerosuiteapp (relato e causa, #3659).
