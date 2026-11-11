---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de IA de configuração e leitura aceitam token de integração
---
As rotas de IA de configuração e leitura (`ai/automatico-ativo`, `ai/budget`, `ai/evolution`, `ai/guardrail-layers`, `ai/mapas`, `ai/mapas/testar`, `ai/operator-metrics`, `ai/pacing`, `ai/runs`, `ai/style-adjustments`, `ai/turn-traces`, `ai/usage` e `ai/voz`) passam a aceitar o token `dsk_…` de servidor. A leitura exige o escopo `config:read` e a escrita exige `config:write`, sempre com papel admin no token. A organização vem da linha do token. Continuam somente de sessão `ai/jev`, `ai/voz/preview`, a leitura de `ai/guardrail-layers` e de `ai/style-adjustments`, e a escrita de `ai/pacing`.
