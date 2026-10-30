---
impacto: nada_mudou
secao: alterado
titulo: "O log do turno do agente passa a trazer a duração do turno e dos classificadores"
---

O log `turno do agente concluído` ganha dois campos: `duracao_do_turno_ms` (o turno inteiro, do início ao fim, incluindo a pausa humana e o intervalo entre envios) e `classificadores_ms` (os classificadores auxiliares, que rodam em paralelo). O comportamento do agente não muda. A metodologia para medir a latência está em `docs/research/medicao-latencia-turno-agente.md`. Nada muda na VPS.

Crédito: @webtecnica.
