---
impacto: nada_mudou
secao: corrigido
titulo: A atualização deixa de reabrir, no meio do caminho, permissões que ela mesma fecha adiante
---
O instalador aplica o arquivo de banco inteiro a cada atualização, um comando de cada vez. Três linhas dele devolviam a papéis de cliente uma permissão de executar que o próprio arquivo retira alguns milhares de linhas depois. Em quem instalou há tempos, e por isso já estava com essas permissões fechadas, a atualização as reabria até o comando que as fecha chegar.

As três linhas saíram. O estado final do banco é exatamente o mesmo de antes — quem termina a atualização fica com as mesmas permissões de sempre, e nada muda para quem usa o sistema. Duas guardas novas impedem a volta: uma lê o arquivo e recusa concessão no corpo que seja revogada adiante, e a outra prova em banco que reaplicar o arquivo não deixa nenhuma função ganhar permissão que ela não tinha.
