---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de ia/memory e ia/skills aceitam token de integração
---

As rotas de `ai/memory` (GET/POST, entries GET/POST/PATCH, versions GET) e de `ai/skills` (lista, ver, atualizar e apagar uma skill, versões, importar `.zip`, instalar do catálogo e restaurar uma versão) passam a aceitar `Authorization: Bearer dsk_…` (token de integração), além da sessão do navegador. O token precisa de escopo `config:read` (leitura) ou `config:write` (escrita) e papel admin. A organização é resolvida da linha do token, nunca do corpo ou da query. Crédito: @paulolimajr77.
