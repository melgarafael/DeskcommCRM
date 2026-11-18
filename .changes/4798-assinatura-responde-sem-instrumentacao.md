---
impacto: nada_mudou
secao: corrigido
titulo: A assinatura do ChatGPT volta a responder o cliente com o Sentry ligado
---

Com o provedor `openai-assinatura` (Sign in with ChatGPT), o agente voltou a responder o cliente: toda chamada "Responder o cliente" falhava em ~1 s com `Invalid state: The ReadableStream is locked`, e a aba Teste do agente dava `preview_failed`. O defeito era da combinação do `ai` 7.0.168+ com a integração do Vercel AI SDK do Sentry — o Sentry trocava o stream da chamada por um stream espiado e travava o original, e só a assinatura usa `streamText` com ferramentas. A integração do AI SDK não é mais instalada no app, no edge nem no worker; chamadas curtas, Gemini e OpenAI por chave continuam iguais. Quem usava `SENTRY_DSN=off` como contorno pode tirar a linha; a escolha de telemetria continua a mesma de antes. Quem aponta `SENTRY_DSN` para o próprio Sentry segue recebendo os erros, mas deixa de receber os spans das chamadas de IA. Encontrado por @hubmorada (#4798), consertado por @webtecnica.
