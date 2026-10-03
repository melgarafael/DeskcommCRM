---
impacto: capacidade_nova
secao: adicionado
titulo: Dá para configurar o agente por token de API, sem navegador
---

As portas de versão, publicação e teste do agente (`/api/v1/ai/agents/:id/...`) passam a aceitar o token de servidor `dsk_…` junto com a sessão de sempre. O token precisa de `mcp:read`/`mcp:write` **e** papel admin, a organização sai da linha do token (nunca do path) e a sessão continua funcionando igual. Quem já usava só a sessão não vê mudança; quem automata ganha configuração por API.
