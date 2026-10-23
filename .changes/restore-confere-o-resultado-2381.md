---
impacto: nada_mudou
secao: corrigido
titulo: O restore do backup só diz que deu certo quando confere que os dados voltaram
---

Antes, o `restore.sh` podia anunciar « ✓ banco restaurado » sem ter restaurado nada: o banco recusava a escrita, o terminal enchia de erros e o script terminava como se tudo tivesse dado certo. Agora ele compara, tabela por tabela, quantas linhas o próprio backup declara com quantas o banco tem no fim; se faltar alguma tabela ou a contagem não bater, ele para, diz qual tabela, quanto esperava e quanto achou, e não considera o banco restaurado. O restore continua usando a mesma conta de banco da atualização, então a próxima atualização segue funcionando depois de um restore. Conserto de @webtecnica, a partir do problema encontrado por @apoenondigitalmarketing numa VPS real (#2381).
