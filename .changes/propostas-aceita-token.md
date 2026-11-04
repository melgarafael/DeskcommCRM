---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de propostas aceitam token de integração
---
As rotas de propostas (`proposals`, `proposals/[id]`, o `assistant/apply`, o `assistant/disponibilidade`, o `decide`, o `documento`, o `modelo`, a `previa` e o `revise`) passam a aceitar o token `dsk_…` de servidor. A leitura exige o escopo `mcp:read` e a escrita exige `mcp:write`, com o mesmo papel que a sessão já pede para cada ação. A organização vem da linha do token. Continuam somente de sessão o assistente que redige com IA (`proposals/[id]/assistant`), o preenchimento com a conversa (`proposals/[id]/preencher-com-conversa`) e o envio ao cliente (`proposals/[id]/send`).
