---
impacto: nada_mudou
secao: corrigido
titulo: O provedor de IA personalizado pede JSON, e gateways que assumem streaming deixam de quebrar a chamada
---
Com um gateway OpenAI-compatível que trata a ausência de `stream` como streaming (o 9Router é um), a resposta voltava como `text/event-stream` e a chamada falhava com "Invalid JSON response", mesmo com HTTP 200. O provedor personalizado agora manda `Accept: application/json`, que é o que a chamada sem streaming quer. Quem já usava um gateway que responde JSON por padrão não percebe diferença.
