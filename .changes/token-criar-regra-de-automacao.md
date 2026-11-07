---
impacto: capacidade_nova
secao: adicionado
titulo: Criar regra de automação por token de integração
---
`POST /api/v1/automation-rules` passa a aceitar o token `dsk_…` de servidor, com o escopo `config:write` e papel `admin` no token. Antes de gravar, a rota confere que cada funil, etapa, canal, agente, fluxo e pessoa citados nas ações da regra (inclusive nas ações aninhadas de uma decisão por IA) e no gatilho existem na organização do token, e recusa com 422 qualquer referência que não seja dela ou que a conferência não reconheça. A regra continua nascendo pausada. A criação pela tela não muda. — Paulo Lima Jr
