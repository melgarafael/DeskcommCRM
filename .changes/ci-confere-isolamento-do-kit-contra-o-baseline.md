---
impacto: nada_mudou
secao: alterado
titulo: O CI passa a rodar a conferência de isolamento da atualização contra o banco novo
---

Da v1.61.0 à v1.63.0, a atualização de quase toda instalação parava no meio e deixava o CRM atrás da página de manutenção: a conferência das regras de isolamento do `update.sh` passou a cobrar regras de um módulo que a instalação não tinha, e nenhum dos cinco checks obrigatórios rodava essa conferência. Agora o check `invariants` a roda contra o banco recém-montado pelo `baseline.sql`, em três versões do script — a do próprio PR, a da última release publicada (é a que roda do disco de quem atualiza) e a da v1.63.0, a última que ainda lê as regras só pelo texto. Uma mudança de banco que travaria a atualização de alguém passa a reprovar antes do merge. Nada muda para quem opera.
