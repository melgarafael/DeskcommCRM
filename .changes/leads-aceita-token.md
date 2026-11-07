---
impacto: capacidade_nova
secao: adicionado
titulo: Leads aceitam token de integração
---
As rotas de leads passam a aceitar o token `dsk_…` de servidor, além da sessão de navegador. Integrações (n8n e outros sistemas server-to-server) podem criar, atualizar, mover, ganhar, perder, clonar e retomar negócios, além de gerenciar anexos, vínculos de contato e propostas de campos, sem precisar de cookie de sessão. Cada chamada filtra a organização pela linha do token, mantendo o isolamento entre tenants. O radar de risco (`at-risk`) e o histórico de capturas continuam só pela sessão.
