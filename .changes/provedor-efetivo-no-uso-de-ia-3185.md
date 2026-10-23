---
impacto: nada_mudou
secao: corrigido
titulo: As execuções de IA passam a mostrar o provedor configurado no painel para cada finalidade
---
Quando a leitura do clima da conversa ou a resposta do agente usavam um provedor personalizado configurado no painel com um modelo de nome com barra (por exemplo `qwen/qwen3.8-27b` no Groq), a chamada era registrada como OpenRouter, e a lista de Execuções de IA e o filtro por provedor ficavam errados. Agora o registro grava o provedor escolhido no painel. O valor gasto e o teto de gasto não mudam. Nada a fazer na atualização.

Medido por @eduardosuruagy (#3098) e corrigido por @webtecnica (#3185).
