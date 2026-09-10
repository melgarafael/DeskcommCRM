---
impacto: nada_mudou
secao: corrigido
titulo: Sentry para de derrubar um coletor de Web Vitals no console de quem usa o DSN da comunidade
---

A integração `BrowserTracing` do Sentry instrumenta Web Vitals (CLS/LCP/TTFB) mesmo sem enviar
nenhum trace — a amostragem decide se o dado é enviado, não se o coletor roda. Numa instalação
real (2026-09-09), uma extensão do navegador mexendo na Performance API da página derrubava
esse coletor com um erro no console (`TypeError: Cannot read properties of undefined (reading
'startTime')`), sem nenhum trace chegando a existir para explicar o motivo. Quem está no DSN da
comunidade não tinha telemetria nenhuma sendo enviada por essa integração — só o risco do
crash. Ela deixa de ser carregada para essa população; quem aponta para o próprio Sentry
mantém o tracing normalmente.
