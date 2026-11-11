---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de mensagens e módulos aceitam token de integração
---
GET /api/v1/messages/[id]/media, POST/DELETE /api/v1/messages/[id]/hide e
GET /api/v1/modulos/[modulo]/[objeto] passam a aceitar o Bearer `dsk_...` de
integração, além da sessão de navegador. A organização sai da linha do token,
nunca do corpo ou do caminho enviado pelo cliente.

O token precisa de `mcp:read` para ler (mídia e fichas de módulo) e de
`mcp:write` para ocultar ou restaurar mensagem. O papel exigido é o mesmo da
sessão: `manager` para ocultar, `viewer` para ler.
