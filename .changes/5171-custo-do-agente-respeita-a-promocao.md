---
impacto: nada_mudou
secao: corrigido
titulo: O custo das execuções do agente passa a seguir a promoção do Gemini Flash
---

Enquanto vale a promoção do **Gemini 3.5/3.6/3.7/3.8 Flash** (até 31/12/2026), a coluna de custo em **IA → Agentes → Execuções** mostrava o dobro do que o motor cobrava pela mesma chamada, e a soma mensal de gasto de IA inflava junto. A rota que grava `ai_agent_runs.cost_cents` passou a aplicar o mesmo corte por data que a rota que grava as chamadas do motor já aplicava. A tabela de preços do catálogo não muda e o degrau do Claude Haiku 5.5 continua valendo. A partir de 01/01/2027 UTC as duas rotas seguem a tarifa cheia, como antes.
