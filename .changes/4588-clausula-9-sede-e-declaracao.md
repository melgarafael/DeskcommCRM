---
impacto: nada_mudou
secao: corrigido
titulo: A cláusula de transferência internacional separa a sede do provedor do país que ele declara
---

O modelo da cláusula 9 do documento do operador (`docs/saas/contrato-e-lgpd.md`) dizia que o
conteúdo das conversas era processado "conforme a declaração de cada provedor, consultada em"
uma data, para todos os provedores, quando só a DeepSeek tem país de processamento declarado com
fonte. Agora cada linha diz o que é: a DeepSeek aparece com o país declarado e a data da consulta
da política dela; Anthropic, OpenAI, Google, OpenRouter e TypeSafe AI aparecem com a sede da
empresa que recebe o conteúdo e, sobre a região de processamento, só com o que o catálogo do
sistema registra — a OpenAI declara residência de dados por projeto, a API do Gemini não declara a
região, no OpenRouter ela varia a cada chamada, e dos demais o sistema não registrou declaração.
Quem já copiou a cláusula antiga para o próprio contrato pode refazê-la pelo modelo novo.
Contribuição de @webtecnica (#4588).
