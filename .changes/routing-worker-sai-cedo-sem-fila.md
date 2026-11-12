---
impacto: nada_mudou
secao: corrigido
titulo: O routing-worker sai antes de consultar o PostgREST quando não há conversa a distribuir
---

A rota roda de minuto em minuto e fazia duas leituras de `event_log` (a varredura de `processing` preso e a de `pending`) em toda batida, mesmo numa instalação sem nada na fila: 2.880 requisições por dia contra o endpoint nº 1 do egress no relato da #3878. Agora ela pergunta ao portão do piso ocioso (`lib/cron/piso-ocioso.ts`) por um sinal novo, `roteamento`, que é a união exata das duas varreduras e vai pelo pool `pg` (não gasta a cota do PostgREST). Evento novo continua sendo distribuído na batida seguinte ao TTL de 30 s. Não é preciso mexer em nada na VPS.

Crédito: @webtecnica (#3878).
