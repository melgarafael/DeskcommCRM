---
impacto: nada_mudou
secao: corrigido
titulo: Valor inválido em QUEUE_POLL_INTERVAL_MS ou QUEUE_IDLE_MAX_INTERVAL_MS não impede mais o worker de subir: cai no padrão com aviso no log
---

Se uma dessas duas variáveis do .env tiver um valor que não é um número válido,
o worker passa a usar o valor padrão e registra um aviso no log, em vez de não
subir. Quem não define essas variáveis, ou define valores válidos, não vê
diferença. Não é preciso mexer em nada na VPS. Contribuição de @webtecnica.
