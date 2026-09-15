---
impacto: nada_mudou
secao: alterado
titulo: A versão da Graph API passa a morar num lugar só
---
A versão da Graph API com que a instalação fala (hoje `v22.0`) deixa de estar copiada à mão em dez arquivos de produção e passa a viver num só, com uma catraca que reprova a suíte se alguém escrever a versão à mão em qualquer outro arquivo. Nada muda para quem opera: a instalação continua falando `v22.0`, e `META_GRAPH_VERSION` continua mandando quando existe — inclusive quando ela está preenchida com espaço ou vazia, que antes virava URL sem versão. O que muda é o dia do bump: subir de versão passa a ser uma edição deliberada num arquivo, em vez de dez edições com uma esquecível.

Crédito: @webtecnica.
