---
impacto: exige_acao
secao: corrigido
titulo: A assinatura do ChatGPT volta a responder, e telemetria sem escolha explícita passa a ficar desligada
---

Com o provedor `openai-assinatura` (Sign in with ChatGPT), o agente voltou a responder o cliente: toda chamada "Responder o cliente" falhava em ~1 s com `Invalid state: The ReadableStream is locked`, e a aba Teste do agente dava `preview_failed`. O defeito era da combinação do `ai` 7.0.168+ com a integração do Vercel AI SDK do Sentry — o Sentry trocava o stream da chamada por um stream espiado e travava o original, e só a assinatura usa `streamText` com ferramentas. A integração do AI SDK não é mais instalada no app, no edge nem no worker; chamadas curtas, Gemini e OpenAI por chave continuam iguais.

A telemetria também mudou de padrão: `SENTRY_DSN` ausente ou vazio significa DESLIGADA. Antes, o vazio caía no Sentry da comunidade, então toda instalação enviava relatório de erro sem ninguém ter escolhido. Quem quiser o Sentry do projeto pede por nome, com `SENTRY_DSN=comunidade`.

## Requer atenção

Se a sua instalação mandava erros para o Sentry do projeto sem `SENTRY_DSN` escrito no `.env` (o caso de quem copiou o `.env` do exemplo ou deixou a chave vazia), ela para de enviar depois desta atualização. Para continuar enviando ao Sentry do projeto, ponha `SENTRY_DSN=comunidade` no `.env` e recrie `app` e `worker` (`docker compose -f docker-compose.prod.yml up -d`). Para enviar ao SEU Sentry, use `SENTRY_DSN=<seu-dsn>`; a captura de erro continua igual, mas os spans de IA não são mais gerados. Nada mais precisa ser feito: nenhuma migration, nenhuma variável nova obrigatória.
