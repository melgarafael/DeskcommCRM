---
impacto: nada_mudou
secao: corrigido
titulo: Material arquivado que ficou marcado no assistente volta para a tela, com o desmarcar a um clique
---

Arquivar um material do acervo não podia travar o assistente que o tinha marcado — mas travava: o
acervo chegava na seção já sem os arquivados, o id continuava em `knowledge_source_ids`, e o salvar
recusava a versão com "um dos materiais marcados não existe mais, ou foi arquivado" sem oferecer
onde desmarcar. Agora o arquivado **e marcado** aparece na lista com o selo "arquivado no acervo" e
com o desmarcar a um clique; o arquivado que ninguém marcou continua fora da lista, e arquivado não
conta como material do assistente em nenhum aviso.
