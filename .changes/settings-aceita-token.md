---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de configuração da organização aceitam token de integração
---
As rotas de configuração em `settings` (agenda de apresentação, campanhas, modelos de proposta, proposals, prospecção, roteamento, sons dos avisos e planos de tarefa) passam a aceitar o token `dsk_…` de servidor, filtrando a organização pela linha do token. A leitura exige `config:read` e a escrita exige `config:write`, e o token precisa de papel admin. A sessão de navegador continua igual. A configuração de canais e a importação de modelo por arquivo continuam somente de sessão.
