---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de ia/memory e ia/skills aceitam token de integração
---

As rotas de `ai/memory` (GET/POST, entries GET/POST/PATCH, versions GET) e de `ai/skills` (GET lista, GET [name], DELETE, [name]/versions GET) passam a aceitar `Authorization: Bearer dsk_…` (token de integração), além da sessão do navegador. O token precisa de escopo `config:read` (leitura) ou `config:write` (escrita) e papel admin. A organização é resolvida da linha do token, nunca do corpo ou da query. Continuam só pela sessão: importar skill (.zip), atualizar skill (PUT), instalar e restaurar skills — esses usam `getSkillsPool` (pg Pool cru) e não são alcançáveis por token.
