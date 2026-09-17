---
impacto: nada_mudou
secao: corrigido
titulo: A atualização deixa de reabrir, no meio do caminho, permissões que ela mesma fecha adiante
---
O instalador aplica o arquivo de banco inteiro a cada atualização, um comando de cada vez. Três linhas dele concediam uma permissão que o próprio arquivo retira adiante — o banco ficava, no meio do caminho, com uma permissão a mais do que teria no fim.

As três linhas saíram. O estado final do banco é exatamente o mesmo de antes: quem termina a atualização fica com as mesmas permissões de sempre, e nada muda para quem usa o sistema. Duas guardas novas impedem a volta: uma lê o arquivo e recusa concessão no corpo que seja revogada adiante, e a outra prova em banco que reaplicar o arquivo não deixa nenhuma função ganhar permissão que ela não tinha.
