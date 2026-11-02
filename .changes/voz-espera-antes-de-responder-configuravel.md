---
impacto: capacidade_nova
secao: adicionado
titulo: O tempo que o agente de voz espera antes de responder passa a ser configurável
---

Nas ligações, o agente de voz espera ter certeza de que o cliente terminou de falar antes de responder. Esse cuidado evita que ele fale por cima por causa de ruído na linha, mas deixa uma pausa que pode passar de alguns segundos — e, ao telefone, isso soa como demora para responder.

A nova variável `VOICE_VAD_EAGERNESS` no `.env` ajusta essa espera: `low` (padrão, o comportamento de hoje), `auto` ou `medium` (meio-termo) e `high` (responde mais rápido). Valor em branco ou desconhecido mantém `low`.

Você não precisa mudar nada. Se as ligações soam lentas e a linha é limpa, use `VOICE_VAD_EAGERNESS=auto` e reinicie o serviço de voz.
