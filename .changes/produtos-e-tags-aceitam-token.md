---
impacto: capacidade_nova
secao: adicionado
titulo: Produtos e vocabulário de etiquetas aceitam token de integração
---
As rotas de produtos (catálogo, cadastro, edição, remoção, fotos e importação da planilha) e as de etiquetas (cores e leitura do vocabulário) passam a aceitar o token `dsk_…` de servidor, além da sessão de navegador. Para ler é preciso o escopo `config:read`; para cadastrar, editar, remover, enviar foto ou importar, `config:write`. Como a configuração da loja e das etiquetas é decisão de gestão, o token precisa de papel `admin`. A organização sai da linha do token, nunca do corpo ou do caminho enviado pelo cliente, e cada chamada conta no teto de escrita do token.

Continuam só pela sessão de navegador a gravação do vocabulário de etiquetas (`POST /api/v1/tags/vocabulario`), que depende da sessão do usuário para conferir o papel.
