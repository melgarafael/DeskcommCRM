---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas do acervo de conhecimento aceitam token de integração
---
As rotas de configuração do acervo de IA (`ai/knowledge/sources`, `ai/knowledge/busca`, `ai/knowledge/reindex-all`, `ai/knowledge/sources/[id]`, `ai/knowledge/sources/[id]/conteudo`, `ai/knowledge/sources/[id]/reindex`, `ai/knowledge/sources/[id]/trechos` e `ai/knowledge/sources/upload`) passam a aceitar o token `dsk_…` de servidor, com papel admin no token e a organização vinda da linha do token. `ai/knowledge/chave` e `ai/knowledge/provedor` continuam somente de sessão. Crédito: @paulolimajr77.
