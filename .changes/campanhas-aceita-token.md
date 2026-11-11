---
impacto: capacidade_nova
secao: adicionado
titulo: Campanhas, modelos de texto e lista de exclusão aceitam token de integração
---

As rotas de campanhas, de textos guardados e da lista de exclusão passam a aceitar token de integração. Com o token, a leitura pede o escopo `mcp:read` e a escrita (e a prévia do público, que não grava nada) pede `mcp:write`; em ambos os casos o token precisa do papel de gerente, como na tela.

Ficam de fora desta versão, e continuam só pela tela: iniciar, retomar, pausar, cancelar, agendar, duplicar e testar um envio. Todas passam pela mesma rota de ações, que dispara mensagens a clientes.
